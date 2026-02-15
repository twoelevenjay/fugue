import * as vscode from 'vscode';
import {
    JohannSession,
    OrchestrationPlan,
    Subtask,
    SubtaskResult,
    EscalationRecord,
} from './types';
import { createLogger } from './logger';

const logger = createLogger();

// ============================================================================
// SESSION PERSISTENCE — Everything to disk, OpenClaw-style
//
// Every piece of orchestration state is written to disk immediately:
//   .vscode/johann/sessions/<sessionId>/
//     ├── session.json        — Full session metadata (status, timestamps, request)
//     ├── plan.json           — The orchestration plan (written right after decomposition)
//     ├── subtasks/
//     │   ├── task-1.json     — Subtask state + result (updated on every status change)
//     │   ├── task-2.json     — ...
//     │   └── ...
//     ├── escalations.json    — Escalation records
//     └── context.txt         — Original workspace context snapshot
//
// Design principles (following OpenClaw):
//   1. Write IMMEDIATELY — before any execution begins
//   2. Write on EVERY state change — not just at the end
//   3. Everything is recoverable from disk after any interruption
//   4. Resume = read plan.json + subtask files → skip completed → continue
//   5. No important state lives only in memory
//
// This means:
//   - If interrupted during planning → session.json exists with status='planning', no plan.json
//   - If interrupted during execution → plan.json exists, subtask files show which completed
//   - If interrupted during merge → all subtask results exist on disk, can re-merge
//   - Planning LLM cost is paid ONCE, never repeated on resume
// ============================================================================

/**
 * On-disk representation of a subtask (includes the result inline).
 */
export interface PersistedSubtask {
    id: string;
    title: string;
    description: string;
    complexity: string;
    dependsOn: string[];
    successCriteria: string[];
    status: string;
    assignedModel?: string;
    attempts: number;
    maxAttempts: number;
    worktreePath?: string;
    result?: SubtaskResult;
}

/**
 * On-disk session metadata.
 */
export interface PersistedSession {
    sessionId: string;
    originalRequest: string;
    status: string;
    startedAt: string;
    completedAt?: string;
    lastUpdated: string;
    planSummary?: string;
    subtaskCount?: number;
    completedCount?: number;
}

/**
 * Summary of a resumable session found on disk.
 */
export interface ResumableSession {
    sessionId: string;
    originalRequest: string;
    status: string;
    startedAt: string;
    lastUpdated: string;
    /** Optional message from the user when resuming (for course-correction) */
    resumeMessage?: string;
    plan: OrchestrationPlan | null;
    completedSubtaskIds: string[];
    pendingSubtaskIds: string[];
    subtaskResults: Map<string, SubtaskResult>;
    escalations: EscalationRecord[];
    workspaceContext: string;
}

/**
 * SessionPersistence — Manages all disk I/O for a single orchestration session.
 *
 * Usage:
 *   const persist = new SessionPersistence(sessionId);
 *   await persist.initialize();
 *   await persist.writeSession(session);
 *   await persist.writePlan(plan);
 *   await persist.writeSubtaskUpdate(subtask);
 *   await persist.writeSubtaskResult(subtaskId, result);
 *   ...
 *
 * Resume:
 *   const resumable = await SessionPersistence.findResumable();
 *   if (resumable) { ... resume from disk state ... }
 */
export class SessionPersistence {
    private sessionId: string;
    private sessionDir!: vscode.Uri;
    private subtasksDir!: vscode.Uri;
    private initialized = false;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    // ========================================================================
    // INITIALIZATION
    // ========================================================================

    /**
     * Create the session directory structure on disk.
     * Must be called before any write operations.
     */
    async initialize(): Promise<boolean> {
        const baseDir = this.getBaseDir();
        if (!baseDir) {
            logger.warn('SessionPersistence: No workspace folder found — cannot initialize disk persistence.');
            return false;
        }

        this.sessionDir = vscode.Uri.joinPath(baseDir, this.sessionId);
        this.subtasksDir = vscode.Uri.joinPath(this.sessionDir, 'subtasks');

        try {
            await vscode.workspace.fs.createDirectory(this.sessionDir);
            await vscode.workspace.fs.createDirectory(this.subtasksDir);
            logger.info(`SessionPersistence: Initialized session dir at ${this.sessionDir.fsPath}`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`SessionPersistence: Failed to create session directories: ${msg}`);
            // Don't set initialized — writes will be skipped
            return false;
        }

        this.initialized = true;
        return true;
    }

    // ========================================================================
    // WRITE — Every state change goes to disk immediately
    // ========================================================================

    /**
     * Write the session metadata to disk.
     * Called at session start and on every status transition.
     */
    async writeSession(session: JohannSession): Promise<void> {
        if (!this.initialized) {
            logger.warn('SessionPersistence.writeSession: skipped — not initialized');
            return;
        }

        const persisted: PersistedSession = {
            sessionId: session.sessionId,
            originalRequest: session.originalRequest,
            status: session.status,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
            lastUpdated: new Date().toISOString(),
            planSummary: session.plan?.summary,
            subtaskCount: session.plan?.subtasks.length,
            completedCount: session.plan?.subtasks.filter(
                st => st.status === 'completed'
            ).length,
        };

        await this.writeJson('session.json', persisted);
    }

    /**
     * Write the full orchestration plan to disk.
     * Called IMMEDIATELY after TaskDecomposer.decompose() returns.
     * This is the most critical write — it preserves the planning LLM cost.
     */
    async writePlan(plan: OrchestrationPlan): Promise<void> {
        if (!this.initialized) {
            logger.warn('SessionPersistence.writePlan: skipped — not initialized. Plan is ONLY in memory!');
            return;
        }

        // Write the plan as a whole (machine-readable)
        await this.writeJson('plan.json', plan);

        // Write a human-readable plan.md for easy inspection
        await this.writePlanMarkdown(plan);

        // Also write each subtask as an individual file for granular updates
        for (const subtask of plan.subtasks) {
            await this.writeSubtaskFile(subtask);
        }

        // Write initial status.md
        await this.writeStatusMarkdown(plan);
    }

    /**
     * Append a chunk of the plan stream to disk as it's being generated.
     * Called from TaskDecomposer on every LLM chunk so the plan is on disk
     * even if the process is interrupted mid-planning.
     */
    async appendPlanStream(chunk: string): Promise<void> {
        if (!this.initialized) return;
        try {
            const uri = vscode.Uri.joinPath(this.sessionDir, 'plan-stream.txt');
            let existing = '';
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                existing = new TextDecoder().decode(bytes);
            } catch {
                // File doesn't exist yet — first chunk
            }
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(existing + chunk));
        } catch (err) {
            // Don't let streaming I/O slow down the LLM — log and continue
            const msg = err instanceof Error ? err.message : String(err);
            logger.debug(`SessionPersistence: plan-stream append failed: ${msg}`);
        }
    }

    /**
     * Append a line to the execution log.
     * This creates a running text log of everything Johann does,
     * written as it happens so you can tail it in real time.
     */
    async appendExecutionLog(event: string, detail?: string): Promise<void> {
        if (!this.initialized) return;
        const ts = new Date().toISOString();
        const line = detail
            ? `[${ts}] ${event}: ${detail}\n`
            : `[${ts}] ${event}\n`;
        try {
            const uri = vscode.Uri.joinPath(this.sessionDir, 'execution.log');
            let existing = '';
            try {
                const bytes = await vscode.workspace.fs.readFile(uri);
                existing = new TextDecoder().decode(bytes);
            } catch {
                // First entry
            }
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(existing + line));
        } catch {
            // Non-critical
        }
    }

    /**
     * Update the human-readable status.md file.
     * Provides a quick at-a-glance view of session progress.
     */
    async writeStatusMarkdown(plan: OrchestrationPlan, activeSubtaskId?: string): Promise<void> {
        if (!this.initialized) return;

        const lines: string[] = [];
        lines.push(`# Session: ${this.sessionId}`);
        lines.push(``);
        lines.push(`**Plan:** ${plan.summary}`);
        lines.push(`**Strategy:** ${plan.strategy} | **Complexity:** ${plan.overallComplexity}`);
        lines.push(`**Updated:** ${new Date().toISOString()}`);
        lines.push(``);
        lines.push(`## Subtasks`);
        lines.push(``);

        for (const st of plan.subtasks) {
            const icon = st.status === 'completed' ? '✅'
                : st.status === 'in-progress' ? '🔄'
                : st.status === 'failed' ? '❌'
                : st.status === 'escalated' ? '⬆️'
                : st.status === 'reviewing' ? '🔍'
                : '⏳';
            const active = st.id === activeSubtaskId ? ' **← ACTIVE**' : '';
            const model = st.assignedModel ? ` (${st.assignedModel})` : '';
            const attempts = st.attempts > 0 ? ` [attempt ${st.attempts}/${st.maxAttempts}]` : '';
            lines.push(`${icon} **${st.id}: ${st.title}** — ${st.status}${model}${attempts}${active}`);

            if (st.result) {
                const dur = st.result.durationMs > 0 ? ` (${(st.result.durationMs / 1000).toFixed(1)}s)` : '';
                lines.push(`   - Result: ${st.result.success ? 'SUCCESS' : 'FAILED'}${dur}`);
                if (st.result.reviewNotes) {
                    lines.push(`   - Review: ${st.result.reviewNotes.substring(0, 200)}`);
                }
            }
        }

        const completed = plan.subtasks.filter(st => st.status === 'completed').length;
        const total = plan.subtasks.length;
        lines.push(``);
        lines.push(`---`);
        lines.push(`**Progress:** ${completed}/${total} subtasks completed`);

        await this.writeText('status.md', lines.join('\n'));
    }

    /**
     * Update a single subtask's state on disk.
     * Called on every status change: pending → in-progress → reviewing → completed/failed.
     */
    async writeSubtaskUpdate(subtask: Subtask): Promise<void> {
        if (!this.initialized) return;
        await this.writeSubtaskFile(subtask);
    }

    /**
     * Write the subtask result to its file.
     * Called as soon as the subagent returns a result (before review).
     */
    async writeSubtaskResult(subtaskId: string, result: SubtaskResult, subtask: Subtask): Promise<void> {
        if (!this.initialized) return;

        subtask.result = result;
        await this.writeSubtaskFile(subtask);
    }

    /**
     * Write escalation records to disk.
     */
    async writeEscalations(escalations: EscalationRecord[]): Promise<void> {
        if (!this.initialized) return;
        await this.writeJson('escalations.json', escalations);
    }

    /**
     * Write the workspace context snapshot to disk.
     * Preserved so a resumed session has the same context.
     */
    async writeContext(context: string): Promise<void> {
        if (!this.initialized) return;
        await this.writeText('context.txt', context);
    }

    /**
     * Mark the session as completed on disk.
     */
    async markCompleted(session: JohannSession): Promise<void> {
        session.completedAt = new Date().toISOString();
        session.status = 'completed';
        await this.writeSession(session);
    }

    /**
     * Mark the session as failed on disk with error details.
     */
    async markFailed(session: JohannSession, error: string): Promise<void> {
        session.completedAt = new Date().toISOString();
        session.status = 'failed';
        await this.writeSession(session);
        await this.writeText('error.txt', `${new Date().toISOString()}\n${error}`);
    }

    // ========================================================================
    // READ — For resume and inspection
    // ========================================================================

    /**
     * Read the full session state from disk for resumption.
     * Returns null if the session directory doesn't exist or is corrupt.
     */
    async readForResume(): Promise<ResumableSession | null> {
        if (!this.initialized) {
            const ok = await this.initialize();
            if (!ok) return null;
        }

        // Read session metadata
        const sessionData = await this.readJson<PersistedSession>('session.json');
        if (!sessionData) return null;

        // Read plan
        const plan = await this.readJson<OrchestrationPlan>('plan.json');

        // Read subtask files
        const subtaskResults = new Map<string, SubtaskResult>();
        const completedIds: string[] = [];
        const pendingIds: string[] = [];

        if (plan) {
            for (const subtask of plan.subtasks) {
                const persisted = await this.readJson<PersistedSubtask>(
                    `subtasks/${subtask.id}.json`
                );
                if (persisted) {
                    // Restore status from disk
                    subtask.status = persisted.status as any;
                    subtask.attempts = persisted.attempts;
                    subtask.assignedModel = persisted.assignedModel;
                    subtask.result = persisted.result;

                    if (persisted.status === 'completed' && persisted.result) {
                        completedIds.push(subtask.id);
                        subtaskResults.set(subtask.id, persisted.result);
                    } else if (persisted.status !== 'failed') {
                        // Reset non-completed, non-failed tasks to pending for retry
                        subtask.status = 'pending';
                        subtask.attempts = 0; // Reset attempts for in-progress tasks that were interrupted
                        pendingIds.push(subtask.id);
                    } else {
                        pendingIds.push(subtask.id);
                    }
                } else {
                    pendingIds.push(subtask.id);
                }
            }
        }

        // Read escalations
        const escalations = await this.readJson<EscalationRecord[]>('escalations.json') || [];

        // Read context
        const context = await this.readText('context.txt') || '';

        return {
            sessionId: sessionData.sessionId,
            originalRequest: sessionData.originalRequest,
            status: sessionData.status,
            startedAt: sessionData.startedAt,
            lastUpdated: sessionData.lastUpdated,
            plan,
            completedSubtaskIds: completedIds,
            pendingSubtaskIds: pendingIds,
            subtaskResults,
            escalations,
            workspaceContext: context,
        };
    }

    /**
     * Get the session directory URI.
     */
    getSessionDir(): vscode.Uri | undefined {
        return this.initialized ? this.sessionDir : undefined;
    }

    // ========================================================================
    // STATIC — Find sessions on disk
    // ========================================================================

    /**
     * Find all incomplete (resumable) sessions on disk.
     * A session is resumable if:
     *   1. session.json exists with status != 'completed'
     *   2. plan.json exists (planning was completed)
     *   3. At least one subtask is not completed
     *
     * Returns sessions sorted by lastUpdated (most recent first).
     */
    static async findResumable(): Promise<ResumableSession[]> {
        const baseDir = SessionPersistence.prototype.getBaseDir.call({});
        if (!baseDir) return [];

        const resumable: ResumableSession[] = [];

        try {
            const entries = await vscode.workspace.fs.readDirectory(baseDir);
            const sessionDirs = entries.filter(
                ([, type]) => type === vscode.FileType.Directory
            );

            for (const [dirName] of sessionDirs) {
                // Skip non-session directories (subtasks, debug, memory, etc.)
                if (!dirName.startsWith('johann-')) continue;

                const persist = new SessionPersistence(dirName);
                await persist.initialize();

                const session = await persist.readForResume();
                if (!session) continue;

                // Only include sessions that have a plan and aren't completed
                if (
                    session.plan &&
                    session.status !== 'completed' &&
                    session.pendingSubtaskIds.length > 0
                ) {
                    resumable.push(session);
                }
            }
        } catch {
            // Sessions directory might not exist yet
            return [];
        }

        // Sort by most recently updated
        resumable.sort(
            (a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime()
        );

        return resumable;
    }

    /**
     * Find the most recent resumable session, if any.
     */
    static async findMostRecentResumable(): Promise<ResumableSession | null> {
        const sessions = await SessionPersistence.findResumable();
        return sessions.length > 0 ? sessions[0] : null;
    }

    // ========================================================================
    // PRIVATE — File I/O helpers
    // ========================================================================

    private getBaseDir(): vscode.Uri | undefined {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return undefined;
        return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'johann', 'sessions');
    }

    /**
     * Write a human-readable plan.md alongside plan.json.
     */
    private async writePlanMarkdown(plan: OrchestrationPlan): Promise<void> {
        const lines: string[] = [];
        lines.push(`# Orchestration Plan`);
        lines.push(``);
        lines.push(`**Summary:** ${plan.summary}`);
        lines.push(`**Strategy:** ${plan.strategy}`);
        lines.push(`**Overall Complexity:** ${plan.overallComplexity}`);
        lines.push(``);

        if (plan.successCriteria.length > 0) {
            lines.push(`## Success Criteria`);
            for (const sc of plan.successCriteria) {
                lines.push(`- ${sc}`);
            }
            lines.push(``);
        }

        lines.push(`## Subtasks (${plan.subtasks.length})`);
        lines.push(``);

        for (const st of plan.subtasks) {
            const deps = st.dependsOn.length > 0 ? ` (depends on: ${st.dependsOn.join(', ')})` : '';
            lines.push(`### ${st.id}: ${st.title}${deps}`);
            lines.push(`**Complexity:** ${st.complexity}`);
            lines.push(``);
            lines.push(st.description);
            lines.push(``);
            if (st.successCriteria.length > 0) {
                lines.push(`**Success Criteria:**`);
                for (const sc of st.successCriteria) {
                    lines.push(`- ${sc}`);
                }
                lines.push(``);
            }
            lines.push(`---`);
            lines.push(``);
        }

        await this.writeText('plan.md', lines.join('\n'));
    }

    private async writeSubtaskFile(subtask: Subtask): Promise<void> {
        const persisted: PersistedSubtask = {
            id: subtask.id,
            title: subtask.title,
            description: subtask.description,
            complexity: subtask.complexity,
            dependsOn: subtask.dependsOn,
            successCriteria: subtask.successCriteria,
            status: subtask.status,
            assignedModel: subtask.assignedModel,
            attempts: subtask.attempts,
            maxAttempts: subtask.maxAttempts,
            worktreePath: subtask.worktreePath,
            result: subtask.result,
        };

        await this.writeJson(`subtasks/${subtask.id}.json`, persisted);
    }

    private async writeJson(filename: string, data: unknown): Promise<void> {
        try {
            const uri = vscode.Uri.joinPath(this.sessionDir, filename);

            // Ensure parent directory exists for nested paths
            const parts = filename.split('/');
            if (parts.length > 1) {
                const parentDir = vscode.Uri.joinPath(
                    this.sessionDir,
                    ...parts.slice(0, -1)
                );
                await vscode.workspace.fs.createDirectory(parentDir);
            }

            const content = JSON.stringify(data, null, 2);
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
            logger.debug(`SessionPersistence: wrote ${filename} (${content.length} bytes)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`SessionPersistence: failed to write ${filename}: ${msg}`);
        }
    }

    private async writeText(filename: string, content: string): Promise<void> {
        try {
            const uri = vscode.Uri.joinPath(this.sessionDir, filename);
            await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
            logger.debug(`SessionPersistence: wrote ${filename} (${content.length} chars)`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`SessionPersistence: failed to write ${filename}: ${msg}`);
        }
    }

    private async readJson<T>(filename: string): Promise<T | null> {
        try {
            const uri = vscode.Uri.joinPath(this.sessionDir, filename);
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(bytes);
            return JSON.parse(text) as T;
        } catch {
            return null;
        }
    }

    private async readText(filename: string): Promise<string | null> {
        try {
            const uri = vscode.Uri.joinPath(this.sessionDir, filename);
            const bytes = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    }
}
