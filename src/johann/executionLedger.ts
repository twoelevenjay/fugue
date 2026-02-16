import * as vscode from 'vscode';
import * as path from 'path';
import { safeWrite, safeAppend, withFileLock } from './safeIO';

// ============================================================================
// EXECUTION LEDGER — Shared real-time coordination for subagents
//
// The Ledger is the single source of truth that all subagents can read from
// and the orchestrator writes to. It solves the "triple-nested directory"
// problem by giving every subagent awareness of:
//
//   1. WHAT happened — which subtasks ran, what they created, what failed
//   2. WHERE it happened — directory tree snapshot refreshed before each subtask
//   3. WHO is doing what — for parallel execution, which agents are active
//      and what worktree paths they're operating in
//
// File layout (under .vscode/johann/sessions/<sessionId>/):
//
//   ledger.json              ← Global state: all subtask statuses + file manifests
//   workspace-snapshot.txt   ← Refreshable directory tree of the workspace
//   journal/
//     ├── subtask-1.md       ← Chronological log of subtask-1's actions
//     ├── subtask-2.md       ← Chronological log of subtask-2's actions
//     └── ...
//
// Design principles:
//   - File-based, not in-memory → works across process boundaries
//   - Append-only journals → safe for concurrent writes
//   - Snapshots are always fresh → generated right before each subtask
//   - Ledger updates are atomic → written after each subtask completes
//   - Size-limited summaries → prevent prompt overflow
//   - Subagents READ the ledger; the orchestrator WRITES it
//
// Inspired by OpenClaw's multi-agent coordination patterns.
// ============================================================================

/**
 * A record of files/directories created or modified by a subtask.
 */
export interface FileManifestEntry {
    /** Relative path from workspace root (or worktree root) */
    relativePath: string;
    /** Whether this is a file or directory */
    type: 'file' | 'directory';
    /** Action taken */
    action: 'created' | 'modified' | 'deleted';
    /** Optional description */
    description?: string;
}

/**
 * Status of a single subtask in the ledger.
 */
export interface LedgerSubtaskEntry {
    /** Subtask ID */
    id: string;
    /** Human-readable title */
    title: string;
    /** Current status */
    status: 'pending' | 'running' | 'completed' | 'failed';
    /** Model being used (if running or completed) */
    modelId?: string;
    /** Where this subtask is executing (main workspace or worktree path) */
    workingDirectory?: string;
    /** When this subtask started */
    startedAt?: string;
    /** When this subtask completed */
    completedAt?: string;
    /** Duration in ms */
    durationMs?: number;
    /** Files/directories touched by this subtask */
    fileManifest: FileManifestEntry[];
    /** Brief summary of what was accomplished (max ~500 chars) */
    accomplishmentSummary?: string;
    /** Key commands that were run */
    keyCommands?: string[];
    /** Error message if failed */
    error?: string;
}

/**
 * The full global ledger — serialized to ledger.json.
 */
export interface LedgerState {
    /** Session ID */
    sessionId: string;
    /** When the ledger was last updated */
    lastUpdated: string;
    /** The original user request (for context) */
    originalRequest: string;
    /** Overall plan summary */
    planSummary: string;
    /** Main workspace root path */
    workspaceRoot: string;
    /** All subtask entries, in execution order */
    subtasks: LedgerSubtaskEntry[];
    /** Active worktree mappings: subtaskId → worktree path */
    activeWorktrees: Record<string, string>;
    /** Global notes (e.g., environment setup, shared dependencies installed) */
    globalNotes: string[];
    /** Delegation policy stats snapshot (written at session end / periodically) */
    delegationStats?: {
        mode: string;
        totalSpawned: number;
        delegationsBlocked: number;
        maxDepthReached: number;
        frozen: boolean;
        runawaySignals: number;
    };
}

/**
 * A single journal entry for a subtask's chronological log.
 */
export interface JournalEntry {
    /** ISO timestamp */
    timestamp: string;
    /** Type of action */
    type: 'command' | 'file-create' | 'file-edit' | 'file-delete' | 'note' | 'error' | 'directory-create' | 'delegation-blocked';
    /** Brief description */
    description: string;
    /** The path affected (if applicable) */
    path?: string;
    /** Additional details */
    details?: string;
}

/**
 * Manages the shared execution ledger for a Johann session.
 *
 * The orchestrator creates one ledger per session and updates it as subtasks
 * execute. Subagents receive a formatted summary of the ledger in their
 * prompts so they know what's already been done and what the workspace
 * looks like.
 */
export class ExecutionLedger {
    private sessionId: string;
    private sessionDir: vscode.Uri | undefined;
    private state: LedgerState;
    private initialized = false;

    constructor(sessionId: string, originalRequest: string, planSummary: string) {
        this.sessionId = sessionId;
        this.state = {
            sessionId,
            lastUpdated: new Date().toISOString(),
            originalRequest: originalRequest.substring(0, 500),
            planSummary,
            workspaceRoot: '',
            subtasks: [],
            activeWorktrees: {},
            globalNotes: [],
        };
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Initialize the ledger — create directories and write initial state.
     */
    async initialize(): Promise<boolean> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return false;
        }

        this.state.workspaceRoot = folders[0].uri.fsPath;

        const johannDir = vscode.Uri.joinPath(folders[0].uri, '.vscode', 'johann');
        this.sessionDir = vscode.Uri.joinPath(johannDir, 'sessions', this.sessionId);

        try {
            await vscode.workspace.fs.createDirectory(this.sessionDir);
            await vscode.workspace.fs.createDirectory(
                vscode.Uri.joinPath(this.sessionDir, 'journal')
            );
        } catch {
            // Directories may already exist
        }

        await this.saveLedger();
        this.initialized = true;
        return true;
    }

    /**
     * Check if the ledger is initialized.
     */
    isReady(): boolean {
        return this.initialized;
    }

    // ========================================================================
    // SUBTASK REGISTRATION
    // ========================================================================

    /**
     * Register all subtasks from the plan into the ledger.
     * Call this after task decomposition, before execution begins.
     */
    registerSubtasks(subtasks: Array<{ id: string; title: string }>): void {
        for (const st of subtasks) {
            if (!this.state.subtasks.find(e => e.id === st.id)) {
                this.state.subtasks.push({
                    id: st.id,
                    title: st.title,
                    status: 'pending',
                    fileManifest: [],
                });
            }
        }
        this.saveLedger().catch(() => {});
    }

    // ========================================================================
    // SUBTASK LIFECYCLE UPDATES
    // ========================================================================

    /**
     * Mark a subtask as starting execution.
     */
    async markRunning(
        subtaskId: string,
        modelId: string,
        workingDirectory?: string
    ): Promise<void> {
        const entry = this.findOrCreate(subtaskId);
        entry.status = 'running';
        entry.modelId = modelId;
        entry.startedAt = new Date().toISOString();
        entry.workingDirectory = workingDirectory || this.state.workspaceRoot;

        if (workingDirectory && workingDirectory !== this.state.workspaceRoot) {
            this.state.activeWorktrees[subtaskId] = workingDirectory;
        }

        await this.saveLedger();
        await this.appendJournal(subtaskId, {
            timestamp: new Date().toISOString(),
            type: 'note',
            description: `Subtask started — model: ${modelId}, working in: ${workingDirectory || 'main workspace'}`,
        });
    }

    /**
     * Mark a subtask as completed, with a summary of what it accomplished.
     */
    async markCompleted(
        subtaskId: string,
        output: string,
        fileManifest?: FileManifestEntry[]
    ): Promise<void> {
        const entry = this.findOrCreate(subtaskId);
        entry.status = 'completed';
        entry.completedAt = new Date().toISOString();
        if (entry.startedAt) {
            entry.durationMs = new Date(entry.completedAt).getTime() -
                new Date(entry.startedAt).getTime();
        }
        entry.accomplishmentSummary = this.extractAccomplishmentSummary(output);
        entry.keyCommands = this.extractKeyCommands(output);

        // Merge file manifest from explicit parameter + auto-extracted from output
        const autoManifest = this.extractFileManifest(output);
        entry.fileManifest = [
            ...(fileManifest || []),
            ...autoManifest,
        ];

        // Deduplicate file manifest by path
        const seen = new Set<string>();
        entry.fileManifest = entry.fileManifest.filter(f => {
            if (seen.has(f.relativePath)) return false;
            seen.add(f.relativePath);
            return true;
        });

        // Remove from active worktrees
        delete this.state.activeWorktrees[subtaskId];

        await this.saveLedger();
        await this.appendJournal(subtaskId, {
            timestamp: new Date().toISOString(),
            type: 'note',
            description: `Subtask completed — ${entry.fileManifest.length} files affected`,
            details: entry.accomplishmentSummary,
        });
    }

    /**
     * Mark a subtask as failed.
     */
    async markFailed(subtaskId: string, error: string): Promise<void> {
        const entry = this.findOrCreate(subtaskId);
        entry.status = 'failed';
        entry.completedAt = new Date().toISOString();
        if (entry.startedAt) {
            entry.durationMs = new Date(entry.completedAt).getTime() -
                new Date(entry.startedAt).getTime();
        }
        entry.error = error.substring(0, 300);

        delete this.state.activeWorktrees[subtaskId];

        await this.saveLedger();
        await this.appendJournal(subtaskId, {
            timestamp: new Date().toISOString(),
            type: 'error',
            description: `Subtask failed: ${error.substring(0, 200)}`,
        });
    }

    // ========================================================================
    // GLOBAL NOTES
    // ========================================================================

    /**
     * Add a global note (e.g., "DDEV environment set up", "npm dependencies installed").
     */
    async addGlobalNote(note: string): Promise<void> {
        this.state.globalNotes.push(`[${new Date().toISOString()}] ${note}`);
        // Keep only last 20 notes
        if (this.state.globalNotes.length > 20) {
            this.state.globalNotes = this.state.globalNotes.slice(-20);
        }
        await this.saveLedger();
    }

    /**
     * Register an active worktree mapping.
     */
    async registerWorktree(subtaskId: string, worktreePath: string): Promise<void> {
        this.state.activeWorktrees[subtaskId] = worktreePath;
        const entry = this.findOrCreate(subtaskId);
        entry.workingDirectory = worktreePath;
        await this.saveLedger();
    }

    // ========================================================================
    // WORKSPACE SNAPSHOT
    // ========================================================================

    /**
     * Capture a fresh snapshot of the workspace directory tree.
     * Called right before each subtask to give agents current state.
     *
     * @param targetDir  Override directory to snapshot (e.g., worktree path).
     *                   Defaults to the main workspace root.
     * @param maxDepth   How deep to recurse (default: 4)
     * @param maxEntries Maximum entries to include (default: 200)
     */
    async captureWorkspaceSnapshot(
        targetDir?: string,
        maxDepth: number = 4,
        maxEntries: number = 200
    ): Promise<string> {
        const rootPath = targetDir || this.state.workspaceRoot;
        if (!rootPath) {
            return 'No workspace root available.';
        }

        const rootUri = vscode.Uri.file(rootPath);
        const lines: string[] = [];
        lines.push(`Directory snapshot of: ${rootPath}`);
        lines.push(`Captured at: ${new Date().toISOString()}`);
        lines.push('---');

        let entryCount = 0;

        const walk = async (dir: vscode.Uri, prefix: string, depth: number): Promise<void> => {
            if (depth > maxDepth || entryCount >= maxEntries) return;

            let entries: [string, vscode.FileType][];
            try {
                entries = await vscode.workspace.fs.readDirectory(dir);
            } catch {
                return;
            }

            // Sort: directories first, then files
            entries.sort(([aName, aType], [bName, bType]) => {
                if (aType === bType) return aName.localeCompare(bName);
                return aType === vscode.FileType.Directory ? -1 : 1;
            });

            for (const [name, type] of entries) {
                if (entryCount >= maxEntries) {
                    lines.push(`${prefix}... (truncated, ${entries.length - entryCount} more)`);
                    break;
                }

                // Skip noise directories
                if (this.shouldSkipDir(name)) continue;

                const isDir = type === vscode.FileType.Directory;
                const icon = isDir ? '📁' : '📄';
                lines.push(`${prefix}${icon} ${name}${isDir ? '/' : ''}`);
                entryCount++;

                if (isDir) {
                    const childUri = vscode.Uri.joinPath(dir, name);
                    await walk(childUri, prefix + '  ', depth + 1);
                }
            }
        };

        await walk(rootUri, '', 0);

        if (entryCount >= maxEntries) {
            lines.push(`\n(Snapshot truncated at ${maxEntries} entries)`);
        }

        const snapshot = lines.join('\n');

        // Persist the snapshot for reference
        if (this.sessionDir) {
            try {
                const snapshotUri = vscode.Uri.joinPath(this.sessionDir, 'workspace-snapshot.txt');
                await vscode.workspace.fs.writeFile(
                    snapshotUri,
                    new TextEncoder().encode(snapshot)
                );
            } catch {
                // Non-critical
            }
        }

        return snapshot;
    }

    // ========================================================================
    // CONTEXT GENERATION — What subagents receive in their prompts
    // ========================================================================

    /**
     * Build the full execution context to inject into a subagent's prompt.
     * This is the key method — it assembles everything a subagent needs to
     * understand the current state of the orchestration.
     *
     * @param forSubtaskId  The subtask that will receive this context
     * @param freshSnapshot A just-captured workspace snapshot
     * @param includeJournals  Whether to include journal excerpts from other subtasks
     */
    buildContextForSubagent(
        forSubtaskId: string,
        freshSnapshot: string,
        includeJournals: boolean = true
    ): string {
        const parts: string[] = [];

        // --- Section 1: Current Workspace State ---
        parts.push('=== CURRENT WORKSPACE STATE ===');
        parts.push('This is the LIVE directory structure right now (not from the start of the session).');
        parts.push('Any files/directories listed here ALREADY EXIST. Do NOT recreate them.');
        parts.push('');
        parts.push(this.truncate(freshSnapshot, 3000));
        parts.push('');

        // --- Section 2: What Other Subtasks Have Done ---
        const completedSubtasks = this.state.subtasks.filter(
            st => st.status === 'completed' && st.id !== forSubtaskId
        );
        const runningSubtasks = this.state.subtasks.filter(
            st => st.status === 'running' && st.id !== forSubtaskId
        );
        const pendingSubtasks = this.state.subtasks.filter(
            st => st.status === 'pending' && st.id !== forSubtaskId
        );

        if (completedSubtasks.length > 0) {
            parts.push('=== COMPLETED SUBTASKS (what has already been done) ===');
            parts.push('These subtasks have ALREADY finished. Their results are ALREADY in the workspace.');
            parts.push('Do NOT redo their work. Build upon what they created.\n');

            for (const st of completedSubtasks) {
                parts.push(`### ✅ ${st.title} (${st.id})`);
                if (st.accomplishmentSummary) {
                    parts.push(`Summary: ${st.accomplishmentSummary}`);
                }
                if (st.fileManifest.length > 0) {
                    parts.push('Files created/modified:');
                    // Show up to 30 files per subtask
                    for (const f of st.fileManifest.slice(0, 30)) {
                        const actionIcon = f.action === 'created' ? '+' : f.action === 'modified' ? '~' : '-';
                        parts.push(`  ${actionIcon} ${f.type === 'directory' ? '📁' : '📄'} ${f.relativePath}`);
                    }
                    if (st.fileManifest.length > 30) {
                        parts.push(`  ... and ${st.fileManifest.length - 30} more files`);
                    }
                }
                if (st.keyCommands && st.keyCommands.length > 0) {
                    parts.push('Key commands run:');
                    for (const cmd of st.keyCommands.slice(0, 5)) {
                        parts.push(`  $ ${cmd}`);
                    }
                }
                parts.push('');
            }
        }

        // --- Section 3: Currently Running Subtasks (parallel awareness) ---
        if (runningSubtasks.length > 0) {
            parts.push('=== CURRENTLY RUNNING SUBTASKS (parallel agents) ===');
            parts.push('These subtasks are being executed RIGHT NOW by other agents.');
            parts.push('Be aware of potential conflicts. DO NOT modify files they are likely editing.\n');

            for (const st of runningSubtasks) {
                parts.push(`### 🔄 ${st.title} (${st.id})`);
                parts.push(`  Model: ${st.modelId || 'unknown'}`);
                parts.push(`  Working in: ${st.workingDirectory || 'main workspace'}`);
                if (st.startedAt) {
                    const elapsed = Date.now() - new Date(st.startedAt).getTime();
                    parts.push(`  Running for: ${(elapsed / 1000).toFixed(0)}s`);
                }
                parts.push('');
            }
        }

        // --- Section 4: Active Worktrees (for parallel isolation) ---
        const worktreeEntries = Object.entries(this.state.activeWorktrees);
        if (worktreeEntries.length > 0) {
            parts.push('=== ACTIVE GIT WORKTREES ===');
            parts.push('Each parallel subtask has its own isolated directory. Changes will be merged later.\n');
            for (const [stId, wtPath] of worktreeEntries) {
                const st = this.state.subtasks.find(s => s.id === stId);
                const label = st?.title || stId;
                const isSelf = stId === forSubtaskId;
                parts.push(`  ${isSelf ? '👉 (YOU)' : '  '} ${label}: ${wtPath}`);
            }
            parts.push('');
        }

        // --- Section 5: Pending Subtasks (what's coming next) ---
        if (pendingSubtasks.length > 0) {
            parts.push('=== UPCOMING SUBTASKS ===');
            parts.push('These will run AFTER you finish. Be aware of their scope to avoid conflicts.\n');
            for (const st of pendingSubtasks) {
                parts.push(`  ⏳ ${st.title} (${st.id})`);
            }
            parts.push('');
        }

        // --- Section 6: Global Notes ---
        if (this.state.globalNotes.length > 0) {
            parts.push('=== ENVIRONMENT NOTES ===');
            for (const note of this.state.globalNotes.slice(-10)) {
                parts.push(`  • ${note}`);
            }
            parts.push('');
        }

        // --- Section 7: Your Location ---
        const myEntry = this.state.subtasks.find(st => st.id === forSubtaskId);
        if (myEntry?.workingDirectory) {
            parts.push('=== YOUR WORKING DIRECTORY ===');
            parts.push(`You are operating in: ${myEntry.workingDirectory}`);
            if (myEntry.workingDirectory !== this.state.workspaceRoot) {
                parts.push(`Main workspace root: ${this.state.workspaceRoot}`);
                parts.push('Your changes are in an isolated git worktree and will be merged back automatically.');
            }
            parts.push('');
        }

        return parts.join('\n');
    }

    /**
     * Build a compact summary of the ledger state (for dependency context).
     * Smaller than the full context — used when injecting into dependency results.
     */
    buildCompactSummary(): string {
        const parts: string[] = [];
        parts.push('=== ORCHESTRATION PROGRESS ===');

        const completed = this.state.subtasks.filter(s => s.status === 'completed');
        const running = this.state.subtasks.filter(s => s.status === 'running');
        const pending = this.state.subtasks.filter(s => s.status === 'pending');
        const failed = this.state.subtasks.filter(s => s.status === 'failed');

        parts.push(`Completed: ${completed.length} | Running: ${running.length} | Pending: ${pending.length} | Failed: ${failed.length}`);
        parts.push('');

        for (const st of completed) {
            const files = st.fileManifest.length > 0
                ? ` (${st.fileManifest.length} files: ${st.fileManifest.slice(0, 5).map(f => f.relativePath).join(', ')}${st.fileManifest.length > 5 ? '...' : ''})`
                : '';
            parts.push(`  ✅ ${st.title}${files}`);
        }

        for (const st of running) {
            parts.push(`  🔄 ${st.title} — in ${st.workingDirectory || 'main workspace'}`);
        }

        for (const st of failed) {
            parts.push(`  ❌ ${st.title}: ${st.error || 'unknown error'}`);
        }

        return parts.join('\n');
    }

    // ========================================================================
    // JOURNAL MANAGEMENT
    // ========================================================================

    /**
     * Append an entry to a subtask's journal file.
     * Uses safeAppend() with per-file mutex to prevent corruption from
     * concurrent journal writes (e.g., parallel subtasks + hive mind updates).
     */
    async appendJournal(subtaskId: string, entry: JournalEntry): Promise<void> {
        if (!this.sessionDir) return;

        const journalUri = vscode.Uri.joinPath(
            this.sessionDir, 'journal', `${subtaskId}.md`
        );

        const line = `[${entry.timestamp}] **${entry.type}** — ${entry.description}` +
            (entry.path ? ` | Path: \`${entry.path}\`` : '') +
            (entry.details ? `\n  > ${entry.details.substring(0, 300)}` : '') +
            '\n';

        try {
            await safeAppend(
                journalUri,
                line,
                `# Journal — ${subtaskId}\n\n`,
                true  // dedup: skip if line is already at the end
            );
        } catch {
            // Non-critical
        }
    }

    /**
     * Read a subtask's journal (for injecting into another subtask's context).
     */
    async readJournal(subtaskId: string, maxChars: number = 2000): Promise<string> {
        if (!this.sessionDir) return '';

        const journalUri = vscode.Uri.joinPath(
            this.sessionDir, 'journal', `${subtaskId}.md`
        );

        try {
            const bytes = await vscode.workspace.fs.readFile(journalUri);
            const content = new TextDecoder().decode(bytes);
            return content.length > maxChars
                ? content.substring(content.length - maxChars)  // Take the LATEST entries
                : content;
        } catch {
            return '';
        }
    }

    // ========================================================================
    // HIVE MIND — Mid-round refresh for live inter-agent awareness
    // ========================================================================

    /**
     * Reload the ledger state from disk.
     *
     * During a subagent's tool loop the orchestrator may update the ledger
     * (e.g. marking other subtasks as completed). This method re-reads
     * ledger.json so the in-memory state reflects those changes. Non-critical
     * — returns silently if the file is missing or unparseable.
     */
    async reloadFromDisk(): Promise<boolean> {
        if (!this.sessionDir) return false;

        const ledgerUri = vscode.Uri.joinPath(this.sessionDir, 'ledger.json');
        try {
            const bytes = await vscode.workspace.fs.readFile(ledgerUri);
            const parsed = JSON.parse(new TextDecoder().decode(bytes)) as LedgerState;
            this.state = parsed;
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Build a compact mid-round refresh for injection into a running agent's
     * conversation. This is the **inbound** half of the hive mind — it tells
     * the agent what changed since it last checked.
     *
     * Much smaller than the full `buildContextForSubagent()` output so it
     * doesn't bloat the conversation context.
     *
     * @param forSubtaskId  The subtask receiving this update
     * @param currentRound  The tool-loop round that triggered this refresh
     */
    buildMidRoundRefresh(forSubtaskId: string, currentRound: number): string {
        const parts: string[] = [];
        parts.push(`\n\n=== 🐝 HIVE MIND UPDATE (round ${currentRound}) ===`);

        // ── Completed subtasks (may have finished while we were working) ──
        const completed = this.state.subtasks.filter(
            st => st.status === 'completed' && st.id !== forSubtaskId
        );
        const running = this.state.subtasks.filter(
            st => st.status === 'running' && st.id !== forSubtaskId
        );
        const failed = this.state.subtasks.filter(
            st => st.status === 'failed' && st.id !== forSubtaskId
        );

        if (completed.length > 0) {
            parts.push('\n**Completed by other agents:**');
            for (const st of completed) {
                const files = st.fileManifest.length > 0
                    ? ` → ${st.fileManifest.slice(0, 8).map(f => f.relativePath).join(', ')}${st.fileManifest.length > 8 ? '…' : ''}`
                    : '';
                parts.push(`  ✅ ${st.title}${files}`);
            }
        }

        if (running.length > 0) {
            parts.push('\n**Currently running (parallel agents):**');
            for (const st of running) {
                parts.push(`  🔄 ${st.title} — in ${st.workingDirectory || 'main workspace'}`);
            }
        }

        if (failed.length > 0) {
            parts.push('\n**Failed:**');
            for (const st of failed) {
                parts.push(`  ❌ ${st.title}: ${st.error || 'unknown'}`);
            }
        }

        // ── Global notes (environment changes) ──
        if (this.state.globalNotes.length > 0) {
            parts.push('\n**Environment notes:**');
            for (const note of this.state.globalNotes.slice(-5)) {
                parts.push(`  • ${note}`);
            }
        }

        // ── Conflict warnings ──
        // Check if any completed subtask touched paths we might also be touching
        // (basic heuristic — flag recently completed work in the same directories)
        const myEntry = this.state.subtasks.find(st => st.id === forSubtaskId);
        const myDir = myEntry?.workingDirectory || this.state.workspaceRoot;
        const recentlyTouched = completed
            .filter(st => st.workingDirectory === myDir || !st.workingDirectory)
            .flatMap(st => st.fileManifest.map(f => f.relativePath));
        if (recentlyTouched.length > 0) {
            parts.push('\n⚠️ **Files recently created/modified in YOUR working directory by other agents:**');
            for (const p of recentlyTouched.slice(0, 15)) {
                parts.push(`  • ${p}`);
            }
            parts.push('  → Do NOT overwrite these. Read them first if you need to integrate.');
        }

        parts.push('\n=== END HIVE MIND UPDATE ===\n');
        return parts.join('\n');
    }

    /**
     * Build a journal entry summarizing what tools a subagent called in a
     * given round. This is the **outbound** half of the hive mind — it lets
     * other agents know what this one has been doing.
     */
    buildToolRoundJournalEntry(
        toolCalls: Array<{ name: string; input?: unknown }>,
        roundText: string
    ): JournalEntry[] {
        const entries: JournalEntry[] = [];

        for (const tc of toolCalls) {
            let description = `Called tool: ${tc.name}`;
            let entryPath: string | undefined;
            let type: JournalEntry['type'] = 'note';

            const input = tc.input as Record<string, unknown> | undefined;

            if (tc.name === 'create_file' && input?.filePath) {
                type = 'file-create';
                entryPath = String(input.filePath);
                description = `Created file: ${entryPath}`;
            } else if (tc.name === 'replace_string_in_file' && input?.filePath) {
                type = 'file-edit';
                entryPath = String(input.filePath);
                description = `Edited file: ${entryPath}`;
            } else if (tc.name === 'multi_replace_string_in_file') {
                type = 'file-edit';
                description = `Edited multiple files`;
            } else if (tc.name === 'run_in_terminal' && input?.command) {
                type = 'command';
                description = `Ran command: ${String(input.command).substring(0, 120)}`;
            } else if (tc.name === 'create_directory' && input?.path) {
                type = 'directory-create';
                entryPath = String(input.path);
                description = `Created directory: ${entryPath}`;
            }

            entries.push({
                timestamp: new Date().toISOString(),
                type,
                description,
                path: entryPath,
            });
        }

        return entries;
    }

    // ========================================================================
    // ACCESSORS
    // ========================================================================

    /**
     * Get all files created across all completed subtasks.
     * Useful for understanding total workspace impact.
     */
    getAllCreatedFiles(): FileManifestEntry[] {
        const all: FileManifestEntry[] = [];
        for (const st of this.state.subtasks) {
            if (st.status === 'completed') {
                all.push(...st.fileManifest.filter(f => f.action === 'created'));
            }
        }
        return all;
    }

    /**
     * Get the current state for serialization.
     */
    getState(): Readonly<LedgerState> {
        return this.state;
    }

    /**
     * Get the session directory URI.
     */
    getSessionDir(): vscode.Uri | undefined {
        return this.sessionDir;
    }

    // ========================================================================
    // EXTRACTION HELPERS
    // ========================================================================

    /**
     * Extract an accomplishment summary from subagent output.
     * Looks for patterns like "I created...", "Set up...", "Installed...".
     */
    private extractAccomplishmentSummary(output: string): string {
        // Try to find a summary section at the end of the output
        const summaryPatterns = [
            /(?:^|\n)(?:##?\s*)?(?:Summary|What I did|Accomplishments?|Changes made):?\s*\n([\s\S]{50,800}?)(?:\n##|\n---|\n\*\*|$)/im,
            /(?:^|\n)(?:I |Here's what I |Successfully )([\s\S]{50,500}?)(?:\n\n|\n##|$)/im,
        ];

        for (const pattern of summaryPatterns) {
            const match = output.match(pattern);
            if (match) {
                return match[1].trim().substring(0, 500);
            }
        }

        // Fallback: take the last ~500 chars which usually contains a summary
        if (output.length > 500) {
            const lastPart = output.substring(output.length - 600);
            const lastParagraph = lastPart.split('\n\n').pop();
            if (lastParagraph && lastParagraph.length > 30) {
                return lastParagraph.trim().substring(0, 500);
            }
        }

        return output.substring(0, 500);
    }

    /**
     * Extract file creation/modification actions from subagent output.
     * Parses tool call patterns like [Tool: create_file] and terminal commands.
     */
    private extractFileManifest(output: string): FileManifestEntry[] {
        const manifest: FileManifestEntry[] = [];
        const seen = new Set<string>();

        // Pattern 1: [Tool: create_file] with filePath
        const createFilePattern = /\[Tool: create_file\].*?"filePath":\s*"([^"]+)"/g;
        let match;
        while ((match = createFilePattern.exec(output)) !== null) {
            const filePath = this.toRelativePath(match[1]);
            if (!seen.has(filePath)) {
                seen.add(filePath);
                manifest.push({ relativePath: filePath, type: 'file', action: 'created' });
            }
        }

        // Pattern 2: [Tool: replace_string_in_file] or [Tool: multi_replace_string_in_file]
        const editFilePattern = /\[Tool: (?:replace_string_in_file|multi_replace_string_in_file)\].*?"filePath":\s*"([^"]+)"/g;
        while ((match = editFilePattern.exec(output)) !== null) {
            const filePath = this.toRelativePath(match[1]);
            if (!seen.has(filePath)) {
                seen.add(filePath);
                manifest.push({ relativePath: filePath, type: 'file', action: 'modified' });
            }
        }

        // Pattern 3: mkdir commands in terminal
        const mkdirPattern = /mkdir\s+(?:-p\s+)?["']?([^\s"';&|]+)/g;
        while ((match = mkdirPattern.exec(output)) !== null) {
            const dirPath = this.toRelativePath(match[1]);
            if (!seen.has(dirPath)) {
                seen.add(dirPath);
                manifest.push({ relativePath: dirPath, type: 'directory', action: 'created' });
            }
        }

        // Pattern 4: Simple file path mentions after "Created" or "Created file"
        const createdPattern = /(?:Created|Wrote|Generated)\s+(?:file\s+)?[`"']?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/g;
        while ((match = createdPattern.exec(output)) !== null) {
            const filePath = this.toRelativePath(match[1]);
            if (!seen.has(filePath) && filePath.includes('/')) {
                seen.add(filePath);
                manifest.push({ relativePath: filePath, type: 'file', action: 'created' });
            }
        }

        return manifest;
    }

    /**
     * Extract key commands from subagent output.
     */
    private extractKeyCommands(output: string): string[] {
        const commands: string[] = [];
        const seen = new Set<string>();

        // Look for terminal tool calls
        const terminalPattern = /\[Tool: run_in_terminal\].*?"command":\s*"([^"]+)"/g;
        let match;
        while ((match = terminalPattern.exec(output)) !== null) {
            const cmd = match[1].substring(0, 120);
            if (!seen.has(cmd)) {
                seen.add(cmd);
                commands.push(cmd);
            }
        }

        // Keep only the most relevant commands (max 10)
        return commands.slice(0, 10);
    }

    /**
     * Convert absolute path to relative (from workspace root).
     */
    private toRelativePath(absPath: string): string {
        if (!this.state.workspaceRoot) return absPath;

        // Handle worktree paths too
        if (absPath.startsWith(this.state.workspaceRoot)) {
            return absPath.substring(this.state.workspaceRoot.length).replace(/^\//, '');
        }

        // Check active worktree paths
        for (const wtPath of Object.values(this.state.activeWorktrees)) {
            if (absPath.startsWith(wtPath)) {
                return absPath.substring(wtPath.length).replace(/^\//, '');
            }
        }

        return absPath;
    }

    // ========================================================================
    // SKIP RULES
    // ========================================================================

    private shouldSkipDir(name: string): boolean {
        const skip = new Set([
            'node_modules', '.git', '.vscode', '__pycache__', '.next',
            '.nuxt', 'dist', 'build', '.cache', '.turbo', '.parcel-cache',
            'vendor', '.idea', '.vs', 'coverage', '.nyc_output',
            '.tox', '.mypy_cache', '.pytest_cache', 'venv', '.venv',
            'env', '.env', '.angular', '.svelte-kit',
        ]);
        return skip.has(name) || name.startsWith('.');
    }

    // ========================================================================
    // PERSISTENCE
    // ========================================================================

    /**
     * Persist the ledger state to disk.
     * Uses atomic write + per-file mutex to prevent corruption from
     * concurrent updates (e.g., parallel subtasks completing at the same time).
     */
    private async saveLedger(): Promise<void> {
        if (!this.sessionDir) return;

        this.state.lastUpdated = new Date().toISOString();

        const ledgerUri = vscode.Uri.joinPath(this.sessionDir, 'ledger.json');
        try {
            const content = JSON.stringify(this.state, null, 2);
            await safeWrite(ledgerUri, content);
        } catch {
            // Non-critical
        }
    }

    /**
     * Find or create a subtask entry in the ledger.
     */
    private findOrCreate(subtaskId: string): LedgerSubtaskEntry {
        let entry = this.state.subtasks.find(s => s.id === subtaskId);
        if (!entry) {
            entry = {
                id: subtaskId,
                title: subtaskId,
                status: 'pending',
                fileManifest: [],
            };
            this.state.subtasks.push(entry);
        }
        return entry;
    }

    /**
     * Truncate text with a notice.
     */
    private truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength) + `\n... (truncated, ${text.length - maxLength} chars omitted)`;
    }
}
