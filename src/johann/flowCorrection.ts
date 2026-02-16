import { OrchestrationPlan, Subtask, SubtaskResult, TaskComplexity } from './types';
import { getDownstreamTasks } from './graphManager';
import { getLogger } from './logger';

// ============================================================================
// FLOW CORRECTION — Upstream re-run with downstream-discovered corrections
//
// When a downstream task (e.g. task-4 that depends on tasks 1,2,3) discovers
// that one of its upstream tasks produced incorrect output, the flow
// correction system:
//
// 1. Records the correction request (which upstream, what went wrong, fix hint)
// 2. Invalidates the upstream task and ALL tasks that transitively depend on it
// 3. Re-queues the upstream task with the correction injected into its prompt
// 4. Re-queues all invalidated downstream tasks
// 5. Guards against infinite correction loops via a per-task correction budget
//
// This is inspired by Gas Town's deacon redispatch pattern, adapted for
// Johann's stateless VS Code session model where we can't "message" a running
// agent — instead we reset tasks and re-run with augmented context.
// ============================================================================

/**
 * A correction request from a downstream task to an upstream task.
 */
export interface CorrectionRequest {
    /** ID of the downstream task that discovered the problem */
    requestedBy: string;
    /** ID of the upstream task whose output needs correction */
    targetTaskId: string;
    /** What went wrong with the upstream output */
    problem: string;
    /** Specific guidance for the upstream task on what to fix */
    correctionHint: string;
    /** When the correction was requested */
    timestamp: string;
}

/**
 * Tracks correction history for a single task to prevent infinite loops.
 */
export interface CorrectionHistory {
    /** Task ID */
    taskId: string;
    /** Number of times this task has been corrected */
    correctionCount: number;
    /** The corrections applied (for context injection) */
    corrections: CorrectionRequest[];
}

/**
 * Result of attempting a flow correction.
 */
export interface CorrectionResult {
    /** Whether the correction was accepted and applied */
    accepted: boolean;
    /** Reason if rejected (e.g., budget exceeded) */
    reason: string;
    /** Task IDs that were invalidated and will be re-run */
    invalidatedTasks: string[];
    /** The correction request that was processed */
    request: CorrectionRequest;
}

/**
 * Configuration for the correction system.
 */
export interface CorrectionConfig {
    /**
     * Maximum number of corrections per task before giving up.
     * Prevents infinite correction loops.
     * Default: 2
     */
    maxCorrectionsPerTask: number;

    /**
     * Maximum total corrections across ALL tasks in a session.
     * Prevents runaway correction cascades.
     * Default: 5
     */
    maxTotalCorrections: number;

    /**
     * Whether to boost complexity when re-running a corrected task.
     * The theory: if the first model got it wrong, we should try a
     * more capable model for the correction run.
     * Default: true
     */
    boostComplexityOnCorrection: boolean;
}

const DEFAULT_CORRECTION_CONFIG: CorrectionConfig = {
    maxCorrectionsPerTask: 2,
    maxTotalCorrections: 5,
    boostComplexityOnCorrection: true,
};

/**
 * Manages flow corrections within an orchestration session.
 *
 * Tracks correction budgets, generates invalidation sets, and injects
 * correction context into task prompts on re-run.
 */
export class FlowCorrectionManager {
    private readonly config: CorrectionConfig;
    private readonly history = new Map<string, CorrectionHistory>();
    private totalCorrections = 0;

    constructor(config?: Partial<CorrectionConfig>) {
        this.config = { ...DEFAULT_CORRECTION_CONFIG, ...config };
    }

    /**
     * Request a flow correction: invalidate an upstream task and its dependents.
     *
     * @param request - The correction request from the downstream task
     * @param plan - The current orchestration plan
     * @param results - Current results map (entries will be deleted for invalidated tasks)
     * @param completed - Set of completed task IDs (entries will be removed)
     * @returns CorrectionResult describing what happened
     */
    requestCorrection(
        request: CorrectionRequest,
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>,
        completed: Set<string>
    ): CorrectionResult {
        const logger = getLogger();

        // ── Guard: global budget ───────────────────────────────────────────
        if (this.totalCorrections >= this.config.maxTotalCorrections) {
            logger.warn(
                `[FlowCorrection] Global correction budget exhausted ` +
                `(${this.totalCorrections}/${this.config.maxTotalCorrections}). ` +
                `Rejecting correction for ${request.targetTaskId}.`
            );
            return {
                accepted: false,
                reason: `Global correction budget exhausted (${this.config.maxTotalCorrections} max). ` +
                    `Task "${request.targetTaskId}" will not be re-run.`,
                invalidatedTasks: [],
                request,
            };
        }

        // ── Guard: per-task budget ─────────────────────────────────────────
        const taskHistory = this.getHistory(request.targetTaskId);
        if (taskHistory.correctionCount >= this.config.maxCorrectionsPerTask) {
            logger.warn(
                `[FlowCorrection] Per-task budget exhausted for "${request.targetTaskId}" ` +
                `(${taskHistory.correctionCount}/${this.config.maxCorrectionsPerTask}).`
            );
            return {
                accepted: false,
                reason: `Task "${request.targetTaskId}" has already been corrected ` +
                    `${taskHistory.correctionCount} time(s) (max ${this.config.maxCorrectionsPerTask}). ` +
                    `Further corrections would risk an infinite loop.`,
                invalidatedTasks: [],
                request,
            };
        }

        // ── Guard: target task must exist ──────────────────────────────────
        const targetTask = plan.subtasks.find(st => st.id === request.targetTaskId);
        if (!targetTask) {
            return {
                accepted: false,
                reason: `Target task "${request.targetTaskId}" not found in plan.`,
                invalidatedTasks: [],
                request,
            };
        }

        // ── Compute invalidation set ───────────────────────────────────────
        // Start with the target task, then add all its transitive dependents
        const downstream = getDownstreamTasks(plan, request.targetTaskId);
        const invalidated = [request.targetTaskId, ...downstream];

        logger.info(
            `[FlowCorrection] Accepted correction for "${request.targetTaskId}" ` +
            `(requested by "${request.requestedBy}"). ` +
            `Invalidating ${invalidated.length} task(s): ${invalidated.join(', ')}`
        );

        // ── Record correction ──────────────────────────────────────────────
        taskHistory.correctionCount++;
        taskHistory.corrections.push(request);
        this.totalCorrections++;

        // ── Invalidate tasks ───────────────────────────────────────────────
        for (const taskId of invalidated) {
            // Remove from completed set
            completed.delete(taskId);

            // Remove cached results
            results.delete(taskId);

            // Reset task status and attempts
            const subtask = plan.subtasks.find(st => st.id === taskId);
            if (subtask) {
                subtask.status = 'pending';
                subtask.result = undefined;
                subtask.attempts = 0;
                subtask.assignedModel = undefined;

                // Boost complexity for the corrected task (not its dependents)
                if (taskId === request.targetTaskId && this.config.boostComplexityOnCorrection) {
                    subtask.complexity = this.boostComplexity(subtask.complexity);
                    logger.info(
                        `[FlowCorrection] Boosted complexity for "${taskId}" ` +
                        `to "${subtask.complexity}" for correction re-run`
                    );
                }
            }
        }

        return {
            accepted: true,
            reason: `Correction accepted. Invalidated ${invalidated.length} task(s). ` +
                `Re-running "${request.targetTaskId}" with correction context.`,
            invalidatedTasks: invalidated,
            request,
        };
    }

    /**
     * Check whether a task has pending corrections that should be injected
     * into its prompt when it re-runs.
     */
    hasPendingCorrections(taskId: string): boolean {
        const history = this.history.get(taskId);
        return !!history && history.corrections.length > 0;
    }

    /**
     * Build a correction context block to inject into a task's prompt
     * when it re-runs after a correction.
     *
     * This gives the subagent explicit information about what went wrong
     * and what to fix, so it doesn't repeat the same mistake.
     */
    buildCorrectionContext(taskId: string): string {
        const history = this.history.get(taskId);
        if (!history || history.corrections.length === 0) {
            return '';
        }

        const lines: string[] = [
            '',
            '=== ⚠️ CORRECTION NOTICE ===',
            `This task has been re-run because a downstream task discovered issues in your previous output.`,
            `Correction attempt: ${history.correctionCount}/${this.config.maxCorrectionsPerTask}`,
            '',
        ];

        for (let i = 0; i < history.corrections.length; i++) {
            const c = history.corrections[i];
            lines.push(`--- Correction ${i + 1} (from "${c.requestedBy}") ---`);
            lines.push(`Problem: ${c.problem}`);
            lines.push(`What to fix: ${c.correctionHint}`);
            lines.push('');
        }

        lines.push(
            'IMPORTANT: Address ALL corrections above. Do NOT repeat the same mistakes. ' +
            'If you are unsure, ask clarifying questions rather than guessing.'
        );
        lines.push('=== END CORRECTION NOTICE ===');
        lines.push('');

        return lines.join('\n');
    }

    /**
     * Extract correction requests from a downstream task's review output.
     *
     * The review model can emit structured correction blocks like:
     * ```
     * <!--CORRECTION:task-1:Problem description:Fix hint-->
     * ```
     *
     * This is parsed the same way HIVE_SIGNALs work — HTML comments that
     * are invisible in rendered markdown but machine-parseable.
     */
    static parseCorrectionSignals(
        reviewOutput: string,
        requestedBy: string
    ): CorrectionRequest[] {
        const requests: CorrectionRequest[] = [];
        const pattern = /<!--CORRECTION:([^:]+):([^:]+):([^>]+)-->/g;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(reviewOutput)) !== null) {
            requests.push({
                requestedBy,
                targetTaskId: match[1].trim(),
                problem: match[2].trim(),
                correctionHint: match[3].trim(),
                timestamp: new Date().toISOString(),
            });
        }

        return requests;
    }

    /**
     * Instruction block to include in the review prompt so the review model
     * knows how to emit correction signals.
     */
    static readonly CORRECTION_SIGNAL_INSTRUCTION = `
## Upstream Correction Protocol

If you determine that this task's output is incorrect because an UPSTREAM dependency produced flawed results:

1. Identify which upstream task produced the bad output (by its task ID, e.g. "task-1")
2. Describe what's wrong with the upstream output
3. Describe specifically what the upstream task should fix

Emit a correction signal as an HTML comment (invisible to the user but parsed by the orchestrator):

<!--CORRECTION:task-id:Problem description:What to fix-->

Example:
<!--CORRECTION:task-1:The GraphManager class is missing cycle detection:Add DFS-based cycle detection before running Kahn's algorithm-->

You may emit multiple correction signals if multiple upstream tasks need fixing.
Only emit corrections when the issue clearly originates from an upstream task's output,
not when the current task simply failed on its own.
`;

    /**
     * Get a diagnostic summary of correction state.
     */
    getDiagnostics(): string {
        const lines: string[] = ['=== Flow Correction Diagnostics ===', ''];
        lines.push(`Total corrections: ${this.totalCorrections}/${this.config.maxTotalCorrections}`);
        lines.push('');

        if (this.history.size === 0) {
            lines.push('No corrections have been requested.');
        } else {
            for (const [taskId, hist] of this.history) {
                lines.push(
                    `**${taskId}:** ${hist.correctionCount}/${this.config.maxCorrectionsPerTask} corrections`
                );
                for (const c of hist.corrections) {
                    lines.push(`  - From "${c.requestedBy}": ${c.problem}`);
                }
            }
        }

        return lines.join('\n');
    }

    /**
     * Reset all correction state. Useful at session boundaries.
     */
    reset(): void {
        this.history.clear();
        this.totalCorrections = 0;
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private getHistory(taskId: string): CorrectionHistory {
        let hist = this.history.get(taskId);
        if (!hist) {
            hist = { taskId, correctionCount: 0, corrections: [] };
            this.history.set(taskId, hist);
        }
        return hist;
    }

    private boostComplexity(current: TaskComplexity): TaskComplexity {
        const ladder: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex', 'expert'];
        const idx = ladder.indexOf(current);
        return ladder[Math.min(idx + 1, ladder.length - 1)];
    }
}
