import * as vscode from 'vscode';
import { getLogger } from './logger';

// ============================================================================
// DELEGATION POLICY — Deterministic, bounded, auditable delegation control
//
// Johann is the ONLY global orchestrator by default. Subagents are leaf
// executors that operate within a strict contract:
//   - Execute scoped tasks
//   - Return artifacts, diffs, findings
//   - DO NOT re-plan the global mission
//   - DO NOT spawn further subagents (unless explicitly allowed)
//
// This module enforces:
//   1. Delegation mode (johann-only | allow-model | no-delegation)
//   2. Recursion depth limits
//   3. Parallel subagent caps
//   4. Total delegation budget
//   5. Runaway detection
//
// All enforcement is via DelegationGuard — a stateful tracker that must be
// consulted before every delegation attempt. The orchestrator holds one
// DelegationGuard per session. Subagents never receive a DelegationGuard.
//
// Design principle: Delegation behavior is governed by DelegationPolicy,
// NOT by model identity. No model bypasses constraints, even if it
// natively supports agentic self-delegation.
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// TYPES
// ────────────────────────────────────────────────────────────────────────────

/**
 * The three delegation modes.
 *
 * - `"johann-only"` — DEFAULT. Only Johann delegates. Subagents are pure
 *   leaf executors. Recursion depth = 1. Max parallel = 3.
 *
 * - `"allow-model"` — The underlying LLM may use its own subagent features.
 *   Johann still enforces max recursion depth (default 2) and max parallel
 *   agents (default 4). Intended for power users.
 *
 * - `"no-delegation"` — No subagents at all. All tasks are executed serially
 *   by Johann in a single pass. Budget-safe mode.
 */
export type DelegationMode = 'johann-only' | 'allow-model' | 'no-delegation';

/**
 * Immutable policy configuration read from VS Code settings.
 * Determines how delegation is permitted for a session.
 */
export interface DelegationPolicy {
    /** Which delegation mode is active */
    readonly mode: DelegationMode;
    /** Maximum recursion depth (1 = subagents only, 2 = sub-subagents allowed) */
    readonly maxDepth: number;
    /** Maximum number of concurrent subagents */
    readonly maxParallel: number;
    /** Runaway detection threshold — max delegation attempts before freeze */
    readonly runawayThreshold: number;
}

/**
 * Default policy — stable, safe, suitable for overnight runs.
 */
export const DEFAULT_DELEGATION_POLICY: DelegationPolicy = {
    mode: 'johann-only',
    maxDepth: 1,
    maxParallel: 3,
    runawayThreshold: 5,
};

/**
 * Result of a delegation request.
 */
export interface DelegationDecision {
    /** Whether the delegation was allowed */
    readonly allowed: boolean;
    /** Reason if blocked */
    readonly reason?: string;
    /** Whether the guard froze further delegation (runaway detected) */
    readonly frozen?: boolean;
}

/**
 * A snapshot of delegation statistics for ledger/audit purposes.
 */
export interface DelegationStats {
    /** The active delegation mode */
    mode: DelegationMode;
    /** Total subagents spawned this session */
    totalSpawned: number;
    /** Currently active subagents */
    activeCount: number;
    /** Maximum depth reached */
    maxDepthReached: number;
    /** Number of delegations blocked */
    delegationsBlocked: number;
    /** Whether the guard is frozen (runaway detected) */
    frozen: boolean;
    /** Number of runaway signals detected */
    runawaySignals: number;
    /** Detailed block reasons for audit trail */
    blockLog: ReadonlyArray<{ timestamp: string; reason: string }>;
}

// ────────────────────────────────────────────────────────────────────────────
// RUNAWAY DETECTION
// ────────────────────────────────────────────────────────────────────────────

/**
 * Phrases in LLM output that signal the model is trying to self-delegate.
 * If the model repeatedly emits these, the guard freezes delegation.
 */
const DELEGATION_SIGNAL_PHRASES: ReadonlyArray<string | RegExp> = [
    /\bspawn\s+(a\s+)?sub\s*agent/i,
    /\bdelegate\s+(this\s+)?task/i,
    /\bcreate\s+(a\s+)?(new\s+)?agent/i,
    /\blaunch\s+(a\s+)?(new\s+)?sub\s*agent/i,
    /\bfork\s+(a\s+)?(new\s+)?agent/i,
    /\brecursive\s+planning/i,
    /\bspawn\s+another\s+agent/i,
    /\bre-plan\s+the\s+(global\s+)?mission/i,
    /\bI('ll| will)\s+orchestrate/i,
    /\bI('ll| will)\s+decompose\s+this/i,
];

// ────────────────────────────────────────────────────────────────────────────
// SETTINGS READER
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read the delegation policy from VS Code settings.
 * Falls back to DEFAULT_DELEGATION_POLICY for any missing values.
 */
export function getDelegationPolicy(): DelegationPolicy {
    const cfg = vscode.workspace.getConfiguration('johann');
    const rawMode = cfg.get<string>('delegationMode', DEFAULT_DELEGATION_POLICY.mode);

    // Validate mode
    const validModes: DelegationMode[] = ['johann-only', 'allow-model', 'no-delegation'];
    const mode: DelegationMode = validModes.includes(rawMode as DelegationMode)
        ? rawMode as DelegationMode
        : DEFAULT_DELEGATION_POLICY.mode;

    // Read limits — enforce per-mode defaults
    let maxDepth: number;
    let maxParallel: number;

    switch (mode) {
        case 'johann-only':
            maxDepth = cfg.get<number>('delegationMaxDepth', 1);
            maxParallel = cfg.get<number>('delegationMaxParallel', 3);
            // Clamp depth to 1 in johann-only (subagents may not re-delegate)
            maxDepth = Math.min(maxDepth, 1);
            break;
        case 'allow-model':
            maxDepth = cfg.get<number>('delegationMaxDepth', 2);
            maxParallel = cfg.get<number>('delegationMaxParallel', 4);
            break;
        case 'no-delegation':
            maxDepth = 0;
            maxParallel = 0;
            break;
    }

    const runawayThreshold = cfg.get<number>(
        'delegationRunawayThreshold',
        DEFAULT_DELEGATION_POLICY.runawayThreshold,
    );

    return { mode, maxDepth, maxParallel, runawayThreshold };
}

// ────────────────────────────────────────────────────────────────────────────
// DELEGATION GUARD
// ────────────────────────────────────────────────────────────────────────────

/**
 * Stateful per-session delegation guard.
 *
 * The orchestrator creates ONE guard at session start and passes it through the
 * execution pipeline. Every call to `requestDelegation()` is checked against
 * the policy and the running counters.
 *
 * Subagents NEVER receive the guard — they have no way to delegate.
 * The guard lives in the orchestrator only.
 */
export class DelegationGuard {
    private readonly policy: DelegationPolicy;
    private readonly logger = getLogger();

    // ── Running counters ──
    private _totalSpawned = 0;
    private _activeCount = 0;
    private _maxDepthReached = 0;
    private _delegationsBlocked = 0;
    private _frozen = false;
    private _runawaySignals = 0;
    private readonly _blockLog: Array<{ timestamp: string; reason: string }> = [];

    // ── Queue for when parallel cap is hit ──
    private readonly _waitQueue: Array<{
        resolve: () => void;
        reject: (err: Error) => void;
    }> = [];

    constructor(policy?: DelegationPolicy) {
        this.policy = policy ?? getDelegationPolicy();
        this.logger.info(
            `DelegationGuard initialized: mode=${this.policy.mode}, ` +
            `maxDepth=${this.policy.maxDepth}, maxParallel=${this.policy.maxParallel}, ` +
            `runawayThreshold=${this.policy.runawayThreshold}`,
        );
    }

    // ════════════════════════════════════════════════════════════════════════
    // PUBLIC API
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Request permission to delegate a task.
     *
     * @param depth  The current delegation depth (0 = Johann, 1 = subagent, …)
     * @returns      Decision with `allowed` flag and optional `reason`.
     */
    requestDelegation(depth: number): DelegationDecision {
        // ── No-delegation mode: everything is blocked ──
        if (this.policy.mode === 'no-delegation') {
            return this.block('Delegation disabled (no-delegation mode)');
        }

        // ── Frozen by runaway detection ──
        if (this._frozen) {
            return this.block('Delegation frozen — runaway behavior detected', true);
        }

        // ── Depth check ──
        if (depth >= this.policy.maxDepth) {
            return this.block(
                `Depth ${depth} exceeds max allowed depth ${this.policy.maxDepth}`,
            );
        }

        // ── Parallel cap check ──
        if (this._activeCount >= this.policy.maxParallel) {
            return this.block(
                `Active subagent count ${this._activeCount} is at parallel cap ${this.policy.maxParallel}`,
            );
        }

        // ── Budget check (runaway threshold on total spawned) ──
        // We use runawayThreshold * maxParallel to get a reasonable ceiling
        const totalCeiling = this.policy.runawayThreshold * Math.max(this.policy.maxParallel, 1);
        if (this._totalSpawned >= totalCeiling) {
            return this.block(
                `Total subagents spawned (${this._totalSpawned}) exceeds session budget (${totalCeiling})`,
            );
        }

        // ── Allowed ──
        this._totalSpawned++;
        this._activeCount++;
        if (depth + 1 > this._maxDepthReached) {
            this._maxDepthReached = depth + 1;
        }
        return { allowed: true };
    }

    /**
     * Signal that a delegated subagent has completed (success or failure).
     * Decrements the active count and unblocks queued waiters.
     */
    releaseDelegation(): void {
        if (this._activeCount > 0) {
            this._activeCount--;
        }

        // Unblock one waiter if present
        if (this._waitQueue.length > 0) {
            const waiter = this._waitQueue.shift();
            waiter?.resolve();
        }
    }

    /**
     * Wait until a delegation slot is available (for queue-based parallel cap).
     * Resolves immediately if under the parallel cap, otherwise parks until
     * a slot opens via `releaseDelegation()`.
     *
     * @param token  Optional cancellation token.
     * @returns      Decision (may still be blocked if frozen or at budget).
     */
    async waitForSlot(
        depth: number,
        token?: vscode.CancellationToken,
    ): Promise<DelegationDecision> {
        // Fast path: try immediately
        const immediate = this.requestDelegation(depth);
        if (immediate.allowed || immediate.reason !== `Active subagent count ${this._activeCount} is at parallel cap ${this.policy.maxParallel}`) {
            return immediate;
        }

        // Park until a slot opens
        return new Promise<DelegationDecision>((resolve, reject) => {
            const waiter = {
                resolve: () => {
                    // Re-check after waking (frozen state may have changed)
                    const decision = this.requestDelegation(depth);
                    resolve(decision);
                },
                reject: (err: Error) => {
                    reject(err);
                },
            };
            this._waitQueue.push(waiter);

            // Cancellation support
            if (token) {
                const onCancel = token.onCancellationRequested(() => {
                    const idx = this._waitQueue.indexOf(waiter);
                    if (idx >= 0) {
                        this._waitQueue.splice(idx, 1);
                    }
                    resolve({ allowed: false, reason: 'Cancelled while waiting for delegation slot' });
                    onCancel.dispose();
                });
            }
        });
    }

    /**
     * Scan text output for delegation-signal phrases.
     * If the count exceeds the runaway threshold, freeze delegation.
     *
     * Call this on every round of subagent output when in `johann-only` mode.
     */
    checkForRunaway(text: string): void {
        if (this.policy.mode !== 'johann-only') {
            // In allow-model mode, the model is expected to delegate — no alarm
            return;
        }

        for (const pattern of DELEGATION_SIGNAL_PHRASES) {
            const match = typeof pattern === 'string'
                ? text.toLowerCase().includes(pattern.toLowerCase())
                : pattern.test(text);

            if (match) {
                this._runawaySignals++;
                this.logger.warn(
                    `Delegation signal #${this._runawaySignals} detected in subagent output ` +
                    `(threshold: ${this.policy.runawayThreshold})`,
                );

                if (this._runawaySignals >= this.policy.runawayThreshold) {
                    this._frozen = true;
                    this._blockLog.push({
                        timestamp: new Date().toISOString(),
                        reason: `RUNAWAY FREEZE: ${this._runawaySignals} delegation signals exceeded threshold ${this.policy.runawayThreshold}`,
                    });
                    this.logger.warn(
                        'DELEGATION FROZEN — runaway behavior detected. ' +
                        'Further delegation is blocked. Execution continues serially.',
                    );
                }
                break; // One signal per text chunk is enough
            }
        }
    }

    /**
     * Manually freeze delegation (e.g., if an external safety check fails).
     */
    freeze(reason: string): void {
        this._frozen = true;
        this._blockLog.push({
            timestamp: new Date().toISOString(),
            reason: `MANUAL FREEZE: ${reason}`,
        });
        this.logger.warn(`DelegationGuard manually frozen: ${reason}`);

        // Reject all queued waiters
        for (const waiter of this._waitQueue) {
            waiter.reject(new Error('Delegation frozen'));
        }
        this._waitQueue.length = 0;
    }

    // ════════════════════════════════════════════════════════════════════════
    // ACCESSORS
    // ════════════════════════════════════════════════════════════════════════

    /** Current delegation mode */
    get mode(): DelegationMode {
        return this.policy.mode;
    }

    /** Whether delegation is completely disabled */
    get isNoDelegation(): boolean {
        return this.policy.mode === 'no-delegation';
    }

    /** Whether the guard is frozen (runaway detected or manually frozen) */
    get isFrozen(): boolean {
        return this._frozen;
    }

    /** Max parallel subagents allowed */
    get maxParallel(): number {
        return this.policy.maxParallel;
    }

    /** Number of currently active subagents */
    get activeCount(): number {
        return this._activeCount;
    }

    /** The full policy (read-only) */
    getPolicy(): Readonly<DelegationPolicy> {
        return this.policy;
    }

    /**
     * Get a snapshot of delegation statistics for logging/ledger/audit.
     */
    getStats(): DelegationStats {
        return {
            mode: this.policy.mode,
            totalSpawned: this._totalSpawned,
            activeCount: this._activeCount,
            maxDepthReached: this._maxDepthReached,
            delegationsBlocked: this._delegationsBlocked,
            frozen: this._frozen,
            runawaySignals: this._runawaySignals,
            blockLog: [...this._blockLog],
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // INTERNAL
    // ════════════════════════════════════════════════════════════════════════

    private block(reason: string, frozen?: boolean): DelegationDecision {
        this._delegationsBlocked++;
        this._blockLog.push({
            timestamp: new Date().toISOString(),
            reason,
        });
        this.logger.warn(`Delegation blocked: ${reason}`);
        return { allowed: false, reason, frozen };
    }
}

// ────────────────────────────────────────────────────────────────────────────
// SUBAGENT PROMPT INJECTION
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build the delegation constraint block that gets injected into every
 * subagent system prompt. This tells the underlying model that it is a
 * leaf executor and MUST NOT attempt to spawn further agents.
 *
 * Used in `johann-only` mode. In `allow-model` mode a relaxed version
 * is injected instead.
 */
export function buildDelegationConstraintBlock(policy: DelegationPolicy): string {
    if (policy.mode === 'no-delegation') {
        return [
            '',
            'DELEGATION POLICY: NONE',
            'You are the sole executor. No delegation or subagent spawning is permitted.',
            'Execute the task directly and return your results.',
            '',
        ].join('\n');
    }

    if (policy.mode === 'allow-model') {
        return [
            '',
            'DELEGATION POLICY: MODEL-MANAGED (BOUNDED)',
            'You may use your native delegation/subagent capabilities if available.',
            'However, the following limits are HARD-ENFORCED by the orchestrator:',
            `  - Maximum delegation depth: ${policy.maxDepth}`,
            `  - Maximum parallel agents: ${policy.maxParallel}`,
            'If you exceed these limits, your delegation requests will be blocked.',
            'Focus on completing your assigned task scope.',
            '',
        ].join('\n');
    }

    // johann-only (default)
    return [
        '',
        'DELEGATION POLICY: JOHANN-ONLY (STRICT)',
        'You are a LEAF EXECUTOR. You MUST NOT:',
        '  - Spawn, create, fork, or delegate to subagents',
        '  - Decompose this task into subtasks for other agents',
        '  - Attempt recursive planning or re-plan the global mission',
        '  - Suggest that "another agent" should handle part of this task',
        '',
        'You MUST:',
        '  - Execute the complete task yourself using your available tools',
        '  - Return structured results: artifacts, diffs, findings',
        '  - Respect the scope defined in YOUR TASK section',
        '',
        'If the task feels too large, do your best within scope. The orchestrator',
        'will handle re-planning if needed. You handle execution only.',
        '',
    ].join('\n');
}
