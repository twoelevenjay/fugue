import * as vscode from 'vscode';
import { getJohannWorkspaceUri } from './bootstrap';
import { safeWrite } from './safeIO';

// ============================================================================
// SUBAGENT REGISTRY — Persistent tracking of spawned subagents
//
// Inspired by OpenClaw's agent registry:
// - Tracks all subagent invocations with status, results, timing
// - Persisted to .vscode/johann/registry/
// - Enables the main agent to know what subagents have done
// - Supports the announce flow (subagent → main agent notification)
// - Each session's registry is stored as a JSON file
// ============================================================================

/**
 * Status of a registered subagent.
 */
export type SubagentStatus = 'spawned' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * A registered subagent entry.
 */
export interface SubagentEntry {
    /** Unique subagent ID */
    id: string;
    /** The session that spawned this subagent */
    sessionId: string;
    /** Parent subtask ID (from the orchestration plan) */
    subtaskId: string;
    /** Human-readable title */
    title: string;
    /** The task description given to the subagent */
    task: string;
    /** Current status */
    status: SubagentStatus;
    /** Model used */
    modelId: string;
    /** Model tier */
    modelTier: number;
    /** When the subagent was spawned */
    spawnedAt: string;
    /** When the subagent completed (or failed) */
    completedAt?: string;
    /** Duration in ms */
    durationMs?: number;
    /** Whether the result was successful */
    success?: boolean;
    /** Output summary (truncated for registry — full output in transcript) */
    outputSummary?: string;
    /** Review notes */
    reviewNotes?: string;
    /** Attempt number (1-based) */
    attemptNumber: number;
    /** Whether this subagent was an escalation from a previous attempt */
    isEscalation: boolean;
}

/**
 * A registry snapshot — all subagents for a session.
 */
export interface RegistrySnapshot {
    /** Session ID */
    sessionId: string;
    /** All subagent entries */
    entries: SubagentEntry[];
    /** When the registry was last updated */
    lastUpdated: string;
}

/**
 * Manages the subagent registry for persistent tracking.
 */
export class SubagentRegistry {
    private sessionId: string;
    private entries: SubagentEntry[] = [];
    private registryUri: vscode.Uri | undefined;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
    }

    /**
     * Initialize the registry — set up the file.
     */
    async initialize(): Promise<boolean> {
        const base = getJohannWorkspaceUri();
        if (!base) return false;

        const registryDir = vscode.Uri.joinPath(base, 'registry');
        try {
            await vscode.workspace.fs.createDirectory(registryDir);
        } catch {
            // Already exists
        }

        const datePrefix = new Date().toISOString().split('T')[0];
        this.registryUri = vscode.Uri.joinPath(registryDir, `${datePrefix}_${this.sessionId}.json`);

        await this.save();
        return true;
    }

    /**
     * Register a new subagent spawn.
     */
    registerSpawn(opts: {
        subtaskId: string;
        title: string;
        task: string;
        modelId: string;
        modelTier: number;
        attemptNumber: number;
        isEscalation: boolean;
    }): SubagentEntry {
        const entry: SubagentEntry = {
            id: this.generateId(),
            sessionId: this.sessionId,
            subtaskId: opts.subtaskId,
            title: opts.title,
            task: opts.task.substring(0, 500), // Truncate for registry
            status: 'spawned',
            modelId: opts.modelId,
            modelTier: opts.modelTier,
            spawnedAt: new Date().toISOString(),
            attemptNumber: opts.attemptNumber,
            isEscalation: opts.isEscalation,
        };

        this.entries.push(entry);
        this.scheduleSave();
        return entry;
    }

    /**
     * Mark a subagent as running.
     */
    markRunning(subagentId: string): void {
        const entry = this.entries.find(e => e.id === subagentId);
        if (entry) {
            entry.status = 'running';
            this.scheduleSave();
        }
    }

    /**
     * Mark a subagent as completed.
     */
    markCompleted(
        subagentId: string,
        success: boolean,
        outputSummary: string,
        reviewNotes?: string
    ): void {
        const entry = this.entries.find(e => e.id === subagentId);
        if (entry) {
            entry.status = success ? 'completed' : 'failed';
            entry.completedAt = new Date().toISOString();
            entry.durationMs = new Date(entry.completedAt).getTime() - new Date(entry.spawnedAt).getTime();
            entry.success = success;
            entry.outputSummary = outputSummary.substring(0, 1000); // Truncate
            entry.reviewNotes = reviewNotes;
            this.scheduleSave();
        }
    }

    /**
     * Mark a subagent as cancelled.
     */
    markCancelled(subagentId: string): void {
        const entry = this.entries.find(e => e.id === subagentId);
        if (entry) {
            entry.status = 'cancelled';
            entry.completedAt = new Date().toISOString();
            this.scheduleSave();
        }
    }

    /**
     * Get all entries (current session).
     */
    getEntries(): SubagentEntry[] {
        return [...this.entries];
    }

    /**
     * Get entries for a specific subtask.
     */
    getEntriesForSubtask(subtaskId: string): SubagentEntry[] {
        return this.entries.filter(e => e.subtaskId === subtaskId);
    }

    /**
     * Get a summary of the registry for prompt injection.
     */
    getSummary(): string {
        if (this.entries.length === 0) return '';

        const lines: string[] = ['=== Subagent Registry ===', ''];

        for (const entry of this.entries) {
            const statusIcon = entry.status === 'completed' ? '✅'
                : entry.status === 'failed' ? '❌'
                : entry.status === 'running' ? '🔄'
                : entry.status === 'cancelled' ? '⛔'
                : '⏳';

            const duration = entry.durationMs
                ? ` (${(entry.durationMs / 1000).toFixed(1)}s)`
                : '';

            const escalation = entry.isEscalation ? ' [escalation]' : '';

            lines.push(
                `${statusIcon} **${entry.title}** → ${entry.modelId} (Tier ${entry.modelTier})` +
                `${duration}${escalation}`
            );

            if (entry.outputSummary && entry.status === 'completed') {
                lines.push(`  > ${entry.outputSummary.substring(0, 200)}`);
            }
            if (entry.reviewNotes && entry.status === 'failed') {
                lines.push(`  > Failed: ${entry.reviewNotes.substring(0, 200)}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Get statistics about subagent usage.
     */
    getStats(): {
        total: number;
        completed: number;
        failed: number;
        cancelled: number;
        escalations: number;
        avgDurationMs: number;
        modelsUsed: string[];
    } {
        const completed = this.entries.filter(e => e.status === 'completed');
        const failed = this.entries.filter(e => e.status === 'failed');
        const cancelled = this.entries.filter(e => e.status === 'cancelled');
        const escalations = this.entries.filter(e => e.isEscalation);
        const durations = this.entries
            .filter(e => e.durationMs !== undefined)
            .map(e => e.durationMs!);
        const avgDuration = durations.length > 0
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : 0;
        const modelsUsed = [...new Set(this.entries.map(e => e.modelId))];

        return {
            total: this.entries.length,
            completed: completed.length,
            failed: failed.length,
            cancelled: cancelled.length,
            escalations: escalations.length,
            avgDurationMs: avgDuration,
            modelsUsed,
        };
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    /**
     * Debounce timer for save operations.
     * Rapid state transitions (spawned → running → completed) are coalesced
     * into a single disk write instead of racing.
     */
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private savePromise: Promise<void> | undefined;

    private scheduleSave(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.savePromise = this.save();
        }, 100); // 100ms debounce — coalesces rapid state changes
    }

    private async save(): Promise<void> {
        if (!this.registryUri) return;

        const snapshot: RegistrySnapshot = {
            sessionId: this.sessionId,
            entries: this.entries,
            lastUpdated: new Date().toISOString(),
        };

        try {
            const content = JSON.stringify(snapshot, null, 2);
            await safeWrite(this.registryUri, content);
        } catch {
            // Silently fail
        }
    }

    private generateId(): string {
        return `sa-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 5)}`;
    }
}

// ============================================================================
// STATIC HELPERS — Load and query across sessions
// ============================================================================

/**
 * Load a registry snapshot from a file.
 */
export async function loadRegistrySnapshot(uri: vscode.Uri): Promise<RegistrySnapshot | undefined> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return JSON.parse(new TextDecoder().decode(bytes)) as RegistrySnapshot;
    } catch {
        return undefined;
    }
}

/**
 * List all registry files, sorted newest first.
 */
export async function listRegistries(): Promise<string[]> {
    const base = getJohannWorkspaceUri();
    if (!base) return [];

    const registryDir = vscode.Uri.joinPath(base, 'registry');

    try {
        const entries = await vscode.workspace.fs.readDirectory(registryDir);
        return entries
            .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
            .map(([name]) => name)
            .sort()
            .reverse();
    } catch {
        return [];
    }
}
