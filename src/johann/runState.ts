import * as vscode from 'vscode';
import { safeWrite } from './safeIO';

// ============================================================================
// RUN STATE — Canonical model driving all Johann UI rendering
//
// This is the SINGLE source of truth for:
//   - What Johann is currently doing (idle, running, cancelling, completed, failed)
//   - Which tasks are running, queued, done, failed
//   - Which subagents are active and what they're doing
//   - Counters for summary display
//   - User request queue (add-task-while-running)
//   - Snapshot timestamps for throttling
//
// RunState does NOT replace the ExecutionLedger or SessionPersistence.
// It READS from them and provides a unified, UI-friendly view.
//
// All code that renders UI must read from RunState.
// All code that modifies orchestration state must update RunState.
// ============================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Overall run status.
 */
export type RunStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed';

/**
 * Status of a task within a run.
 */
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/**
 * Status of a subagent delegation.
 */
export type SubagentStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * A task within the run — maps to an orchestration subtask.
 */
export interface RunTask {
    /** Unique task ID (matches subtask.id). */
    id: string;
    /** Human-readable title. */
    title: string;
    /** Current status. */
    status: TaskStatus;
    /** Parent task ID (for hierarchical grouping). */
    parentId?: string;
    /** Artifacts produced (file paths, diff counts, etc.). */
    artifacts: string[];
    /** When the task was created. */
    createdAt: string;
    /** When the task started executing. */
    startedAt?: string;
    /** When the task completed. */
    completedAt?: string;
    /** Short progress message (current activity). */
    progressMessage?: string;
    /** Model used for execution. */
    model?: string;
    /** Orchestration phase tag for workflow view clustering. */
    phase?: RunPhase;
}

/**
 * A subagent invocation — collapsed "tool-call-like" entry.
 */
export interface RunSubagent {
    /** Unique subagent ID. */
    id: string;
    /** Display title / purpose. */
    title: string;
    /** Current status. */
    status: SubagentStatus;
    /** 1–2 line summary (visible in collapsed view). */
    summary: string;
    /** Full result text (only populated on completion). */
    result?: string;
    /** Associated task ID. */
    taskId?: string;
    /** When this subagent was created. */
    createdAt: string;
    /** When this subagent completed. */
    completedAt?: string;
}

/**
 * A user message enqueued while a run is active.
 */
export interface QueuedUserMessage {
    /** Unique ID. */
    id: string;
    /** The user's message text. */
    message: string;
    /** When it was enqueued. */
    enqueuedAt: string;
    /** Position in queue (1-based). */
    position: number;
    /** Whether it has been integrated into the task graph. */
    integrated: boolean;
}

/**
 * Run-level counters for summary display.
 */
export interface RunCounters {
    queued: number;
    running: number;
    done: number;
    failed: number;
}

/**
 * Orchestration phase for workflow view clustering.
 */
export type RunPhase =
    | 'discovery'
    | 'planning'
    | 'delegation'
    | 'implementation'
    | 'verification'
    | 'packaging';

/**
 * The canonical RunState — everything the UI needs.
 */
export interface RunStateData {
    /** Unique run identifier. */
    runId: string;
    /** When the run started. */
    startedAt: string;
    /** Last updated timestamp. */
    lastUpdatedAt: string;
    /** Overall run status. */
    status: RunStatus;
    /** All tasks in this run. */
    tasks: RunTask[];
    /** All subagent invocations. */
    subagents: RunSubagent[];
    /** Aggregated counters. */
    counters: RunCounters;
    /** When the last snapshot was generated. */
    lastSnapshotAt?: string;
    /** User messages enqueued during the run. */
    userQueue: QueuedUserMessage[];
    /** Original user request. */
    originalRequest: string;
    /** Plan summary (if planning is done). */
    planSummary?: string;
    /** Elapsed time in ms (computed on read). */
    elapsedMs?: number;
}

// ---------------------------------------------------------------------------
// RunStateManager — Singleton
// ---------------------------------------------------------------------------

/**
 * Manages the canonical RunState for the current Johann session.
 *
 * Only one run can be active at a time. The manager provides:
 * - State transitions (start, update, complete, cancel)
 * - Task lifecycle updates
 * - Subagent registration
 * - User queue management
 * - Snapshot throttling
 * - Disk persistence
 */
export class RunStateManager {
    private static instance: RunStateManager | null = null;
    private state: RunStateData | null = null;
    private persistDir: vscode.Uri | null = null;
    private _onStateChange = new vscode.EventEmitter<RunStateData>();

    /** Fires whenever the state changes. Use for reactive UI updates. */
    readonly onStateChange = this._onStateChange.event;

    private constructor() {}

    static getInstance(): RunStateManager {
        if (!RunStateManager.instance) {
            RunStateManager.instance = new RunStateManager();
        }
        return RunStateManager.instance;
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Start a new run. Resets any prior state.
     */
    async startRun(runId: string, originalRequest: string): Promise<RunStateData> {
        const now = new Date().toISOString();
        this.state = {
            runId,
            startedAt: now,
            lastUpdatedAt: now,
            status: 'running',
            tasks: [],
            subagents: [],
            counters: { queued: 0, running: 0, done: 0, failed: 0 },
            userQueue: [],
            originalRequest,
        };

        // Set up persist directory
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            this.persistDir = vscode.Uri.joinPath(
                folders[0].uri, '.vscode', 'johann', 'sessions', runId
            );
        }

        await this.persist();
        this._onStateChange.fire(this.state);
        return this.state;
    }

    /**
     * Get the current state (or null if idle).
     */
    getState(): Readonly<RunStateData> | null {
        if (this.state) {
            // Compute elapsed time on read
            this.state.elapsedMs = Date.now() - new Date(this.state.startedAt).getTime();
        }
        return this.state;
    }

    /**
     * Check if a run is active.
     */
    isRunning(): boolean {
        return this.state?.status === 'running' || this.state?.status === 'cancelling';
    }

    /**
     * Mark the run as cancelling (user hit Stop).
     */
    async cancelRun(): Promise<void> {
        if (!this.state) { return; }
        this.state.status = 'cancelling';
        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    /**
     * Mark the run as completed.
     */
    async completeRun(): Promise<void> {
        if (!this.state) { return; }
        this.state.status = 'completed';
        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    /**
     * Mark the run as failed.
     */
    async failRun(_error?: string): Promise<void> {
        if (!this.state) { return; }
        this.state.status = 'failed';
        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    /**
     * Set the plan summary (after planning phase).
     */
    async setPlanSummary(summary: string): Promise<void> {
        if (!this.state) { return; }
        this.state.planSummary = summary;
        this.touch();
        await this.persist();
    }

    /**
     * Clear the run state (after completion or on new run).
     */
    clear(): void {
        this.state = null;
    }

    // ========================================================================
    // TASK MANAGEMENT
    // ========================================================================

    /**
     * Register tasks from an orchestration plan.
     */
    async registerTasks(tasks: Array<{
        id: string;
        title: string;
        phase?: RunPhase;
    }>): Promise<void> {
        if (!this.state) { return; }

        for (const t of tasks) {
            if (!this.state.tasks.find(rt => rt.id === t.id)) {
                this.state.tasks.push({
                    id: t.id,
                    title: t.title,
                    status: 'queued',
                    artifacts: [],
                    createdAt: new Date().toISOString(),
                    phase: t.phase,
                });
            }
        }

        this.recomputeCounters();
        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    /**
     * Update a task's status and metadata.
     */
    async updateTask(
        taskId: string,
        update: Partial<Pick<RunTask, 'status' | 'progressMessage' | 'model' | 'phase' | 'artifacts'>>
    ): Promise<void> {
        if (!this.state) { return; }
        const task = this.state.tasks.find(t => t.id === taskId);
        if (!task) { return; }

        if (update.status !== undefined) {
            task.status = update.status;
            if (update.status === 'running' && !task.startedAt) {
                task.startedAt = new Date().toISOString();
            }
            if (update.status === 'done' || update.status === 'failed' || update.status === 'cancelled') {
                task.completedAt = new Date().toISOString();
            }
        }
        if (update.progressMessage !== undefined) { task.progressMessage = update.progressMessage; }
        if (update.model !== undefined) { task.model = update.model; }
        if (update.phase !== undefined) { task.phase = update.phase; }
        if (update.artifacts !== undefined) { task.artifacts = update.artifacts; }

        this.recomputeCounters();
        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    // ========================================================================
    // SUBAGENT MANAGEMENT
    // ========================================================================

    /**
     * Register a subagent invocation.
     */
    async registerSubagent(subagent: Omit<RunSubagent, 'createdAt'>): Promise<void> {
        if (!this.state) { return; }

        this.state.subagents.push({
            ...subagent,
            createdAt: new Date().toISOString(),
        });

        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    /**
     * Update a subagent's status and result.
     */
    async updateSubagent(
        subagentId: string,
        update: Partial<Pick<RunSubagent, 'status' | 'summary' | 'result'>>
    ): Promise<void> {
        if (!this.state) { return; }
        const sa = this.state.subagents.find(s => s.id === subagentId);
        if (!sa) { return; }

        if (update.status !== undefined) {
            sa.status = update.status;
            if (update.status === 'done' || update.status === 'failed') {
                sa.completedAt = new Date().toISOString();
            }
        }
        if (update.summary !== undefined) { sa.summary = update.summary; }
        if (update.result !== undefined) { sa.result = update.result; }

        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
    }

    // ========================================================================
    // USER QUEUE (add-task-while-running)
    // ========================================================================

    /**
     * Enqueue a user message to be integrated at the next safe checkpoint.
     * Returns the queue position.
     */
    async enqueueUserMessage(message: string): Promise<number> {
        if (!this.state) {
            throw new Error('No active run to enqueue into');
        }

        const position = this.state.userQueue.filter(q => !q.integrated).length + 1;

        this.state.userQueue.push({
            id: `uq-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            message,
            enqueuedAt: new Date().toISOString(),
            position,
            integrated: false,
        });

        this.touch();
        await this.persist();
        this._onStateChange.fire(this.state);
        return position;
    }

    /**
     * Get pending (un-integrated) user messages.
     */
    getPendingUserMessages(): QueuedUserMessage[] {
        if (!this.state) { return []; }
        return this.state.userQueue.filter(q => !q.integrated);
    }

    /**
     * Mark a user message as integrated into the task graph.
     */
    async markUserMessageIntegrated(messageId: string): Promise<void> {
        if (!this.state) { return; }
        const msg = this.state.userQueue.find(q => q.id === messageId);
        if (msg) {
            msg.integrated = true;
        }
        this.touch();
        await this.persist();
    }

    // ========================================================================
    // SNAPSHOT THROTTLE
    // ========================================================================

    /**
     * Record that a snapshot was just generated.
     */
    async recordSnapshot(): Promise<void> {
        if (!this.state) { return; }
        this.state.lastSnapshotAt = new Date().toISOString();
        await this.persist();
    }

    /**
     * Check if enough time has elapsed for a new snapshot.
     * @param minIntervalMs Minimum interval between snapshots (default: 2 minutes).
     */
    canSnapshot(minIntervalMs: number = 120_000): boolean {
        if (!this.state) { return false; }
        if (!this.state.lastSnapshotAt) { return true; }
        const elapsed = Date.now() - new Date(this.state.lastSnapshotAt).getTime();
        return elapsed >= minIntervalMs;
    }

    // ========================================================================
    // INTERNAL
    // ========================================================================

    private touch(): void {
        if (this.state) {
            this.state.lastUpdatedAt = new Date().toISOString();
        }
    }

    private recomputeCounters(): void {
        if (!this.state) { return; }
        this.state.counters = {
            queued: this.state.tasks.filter(t => t.status === 'queued').length,
            running: this.state.tasks.filter(t => t.status === 'running').length,
            done: this.state.tasks.filter(t => t.status === 'done').length,
            failed: this.state.tasks.filter(t => t.status === 'failed').length,
        };
    }

    /**
     * Persist RunState to disk alongside the session.
     */
    private async persist(): Promise<void> {
        if (!this.state || !this.persistDir) { return; }
        try {
            const uri = vscode.Uri.joinPath(this.persistDir, 'run-state.json');
            const content = JSON.stringify(this.state, null, 2);
            await safeWrite(uri, content);
        } catch {
            // Non-critical — in-memory state is still authoritative
        }
    }

    /**
     * Load RunState from disk (for resume scenarios).
     */
    async loadFromDisk(sessionDir: vscode.Uri): Promise<RunStateData | null> {
        try {
            const uri = vscode.Uri.joinPath(sessionDir, 'run-state.json');
            const bytes = await vscode.workspace.fs.readFile(uri);
            const parsed = JSON.parse(new TextDecoder().decode(bytes)) as RunStateData;
            this.state = parsed;
            this.persistDir = sessionDir;
            return parsed;
        } catch {
            return null;
        }
    }

    /**
     * Dispose and reset.
     */
    dispose(): void {
        this._onStateChange.dispose();
        this.state = null;
        RunStateManager.instance = null;
    }
}
