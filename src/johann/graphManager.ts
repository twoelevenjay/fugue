/**
 * graphManager.ts — DAG-based Wave Execution Engine
 *
 * Converts flat subtask dependency arrays into topologically sorted
 * execution waves, enabling maximum concurrency.
 *
 * Inspired by the CLI System's DAG wave execution and Gas Town's
 * formula resolution patterns.
 *
 * Key capabilities:
 * - Topological sort via Kahn's algorithm
 * - Cycle detection via DFS with stack tracking
 * - Orphan detection via BFS from root tasks
 * - Error propagation to downstream dependents
 */

import { OrchestrationPlan, Subtask } from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * A single execution wave — all tasks in a wave are independent
 * and can run in parallel.
 */
export interface Wave {
    /** Zero-based wave level (wave 0 = no dependencies) */
    level: number;
    /** IDs of tasks in this wave */
    taskIds: string[];
}

/**
 * Result of graph validation.
 */
export interface GraphValidationResult {
    /** Whether the graph is valid (no cycles, no orphans, all deps exist) */
    valid: boolean;
    /** Cycle chains found, if any. Each is an array of task IDs forming a cycle. */
    cycles: string[][];
    /** Task IDs referencing dependencies that don't exist in the plan */
    missingDeps: Array<{ taskId: string; missingDep: string }>;
    /** Task IDs that are unreachable (not root tasks and not reachable from any root) */
    orphans: string[];
}

/**
 * Internal adjacency representation.
 */
interface DependencyGraph {
    /** task ID → set of tasks it depends on (predecessors) */
    inEdges: Map<string, Set<string>>;
    /** task ID → set of tasks that depend on it (successors) */
    outEdges: Map<string, Set<string>>;
    /** All task IDs */
    allIds: Set<string>;
}

// ============================================================================
// Graph Construction
// ============================================================================

/**
 * Build a dependency graph from the plan's subtasks.
 */
function buildGraph(subtasks: Subtask[]): DependencyGraph {
    const inEdges = new Map<string, Set<string>>();
    const outEdges = new Map<string, Set<string>>();
    const allIds = new Set<string>();

    for (const st of subtasks) {
        allIds.add(st.id);
        if (!inEdges.has(st.id)) {
            inEdges.set(st.id, new Set());
        }
        if (!outEdges.has(st.id)) {
            outEdges.set(st.id, new Set());
        }

        for (const dep of st.dependsOn) {
            inEdges.get(st.id)!.add(dep);

            if (!outEdges.has(dep)) {
                outEdges.set(dep, new Set());
            }
            outEdges.get(dep)!.add(st.id);
        }
    }

    return { inEdges, outEdges, allIds };
}

// ============================================================================
// Topological Sort / Wave Generation
// ============================================================================

/**
 * Compute execution waves using Kahn's algorithm (BFS topological sort).
 *
 * Returns waves sorted by level. All tasks in a single wave are independent
 * of each other and can execute in parallel.
 *
 * @throws Error if the graph contains cycles (use `validateGraph` first for
 *         a friendlier error).
 */
export function getExecutionWaves(plan: OrchestrationPlan): Wave[] {
    const subtasks = plan.subtasks;
    if (subtasks.length === 0) {
        return [];
    }

    const graph = buildGraph(subtasks);
    const waves: Wave[] = [];

    // Clone in-degree counts so we can mutate them
    const inDegree = new Map<string, number>();
    for (const id of graph.allIds) {
        inDegree.set(id, graph.inEdges.get(id)?.size ?? 0);
    }

    // Seed: nodes with in-degree 0
    let currentWave: string[] = [];
    for (const [id, deg] of inDegree) {
        if (deg === 0) {
            currentWave.push(id);
        }
    }

    let level = 0;
    const processed = new Set<string>();

    while (currentWave.length > 0) {
        waves.push({ level, taskIds: [...currentWave] });

        const nextWave: string[] = [];
        for (const id of currentWave) {
            processed.add(id);
            const successors = graph.outEdges.get(id) ?? new Set();
            for (const succ of successors) {
                const newDeg = (inDegree.get(succ) ?? 1) - 1;
                inDegree.set(succ, newDeg);
                if (newDeg === 0) {
                    nextWave.push(succ);
                }
            }
        }

        currentWave = nextWave;
        level++;
    }

    // If not all nodes were processed, there's a cycle
    if (processed.size < graph.allIds.size) {
        const stuck = [...graph.allIds].filter(id => !processed.has(id));
        throw new Error(
            `Cycle detected in task graph. Tasks involved: ${stuck.join(', ')}`
        );
    }

    return waves;
}

// ============================================================================
// Downstream Propagation (for failure cascading)
// ============================================================================

/**
 * Get all tasks that transitively depend on the given task (BFS).
 * Used to cancel downstream tasks when a predecessor fails.
 */
export function getDownstreamTasks(plan: OrchestrationPlan, taskId: string): string[] {
    const graph = buildGraph(plan.subtasks);
    const visited = new Set<string>();
    const queue: string[] = [...(graph.outEdges.get(taskId) ?? [])];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) {
            continue;
        }
        visited.add(current);
        const successors = graph.outEdges.get(current) ?? new Set();
        for (const succ of successors) {
            if (!visited.has(succ)) {
                queue.push(succ);
            }
        }
    }

    return [...visited];
}

// ============================================================================
// Graph Validation
// ============================================================================

/**
 * Validate the dependency graph for common issues:
 * - Cycles (would cause infinite loops)
 * - Missing dependencies (task references a dep that doesn't exist)
 * - Orphans (tasks unreachable from any root)
 */
export function validateGraph(plan: OrchestrationPlan): GraphValidationResult {
    const subtasks = plan.subtasks;
    const result: GraphValidationResult = {
        valid: true,
        cycles: [],
        missingDeps: [],
        orphans: [],
    };

    if (subtasks.length === 0) {
        return result;
    }

    const taskIds = new Set(subtasks.map(st => st.id));

    // 1. Missing dependency check
    for (const st of subtasks) {
        for (const dep of st.dependsOn) {
            if (!taskIds.has(dep)) {
                result.missingDeps.push({ taskId: st.id, missingDep: dep });
                result.valid = false;
            }
        }
    }

    // 2. Cycle detection via DFS with coloring
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of taskIds) {
        color.set(id, WHITE);
    }

    // Build adjacency for DFS (task → its dependents)
    const graph = buildGraph(subtasks);

    function dfs(node: string, path: string[]): boolean {
        color.set(node, GRAY);
        path.push(node);

        const successors = graph.outEdges.get(node) ?? new Set();
        for (const succ of successors) {
            if (color.get(succ) === GRAY) {
                // Found a cycle — extract the cycle from path
                const cycleStart = path.indexOf(succ);
                const cycle = path.slice(cycleStart);
                cycle.push(succ); // close the cycle
                result.cycles.push(cycle);
                result.valid = false;
                return true;
            }
            if (color.get(succ) === WHITE) {
                if (dfs(succ, path)) {
                    return true; // propagate cycle found
                }
            }
        }

        path.pop();
        color.set(node, BLACK);
        return false;
    }

    for (const id of taskIds) {
        if (color.get(id) === WHITE) {
            dfs(id, []);
        }
    }

    // 3. Orphan detection — BFS from root tasks (in-degree 0)
    const roots = subtasks.filter(st => st.dependsOn.length === 0).map(st => st.id);
    if (roots.length === 0 && subtasks.length > 0) {
        // No roots at all — everything is either cyclic or depends on something
        result.orphans = [...taskIds];
        result.valid = false;
    } else {
        const reachable = new Set<string>(roots);
        const queue = [...roots];
        while (queue.length > 0) {
            const current = queue.shift()!;
            const successors = graph.outEdges.get(current) ?? new Set();
            for (const succ of successors) {
                if (!reachable.has(succ)) {
                    reachable.add(succ);
                    queue.push(succ);
                }
            }
        }

        for (const id of taskIds) {
            if (!reachable.has(id)) {
                result.orphans.push(id);
                result.valid = false;
            }
        }
    }

    return result;
}
