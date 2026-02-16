import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises'; // eslint-disable-line no-restricted-imports -- Required: worktrees live in os.tmpdir(), outside workspace (vscode.workspace.fs cannot reach)
import { execFile } from 'child_process'; // eslint-disable-line no-restricted-imports -- Required: no VS Code API for git worktree operations
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ============================================================================
// GIT WORKTREE MANAGER — Filesystem isolation for parallel subtasks
//
// When Johann runs multiple subtasks in parallel, they can stomp on each
// other's file changes. Git worktrees solve this by giving each parallel
// subtask its own working directory on its own branch:
//
// main workspace (branch: main)
//   ├── /tmp/johann-worktrees/<session>/<task-1>/  (branch: johann/<session>/task-1)
//   ├── /tmp/johann-worktrees/<session>/<task-2>/  (branch: johann/<session>/task-2)
//   └── /tmp/johann-worktrees/<session>/<task-3>/  (branch: johann/<session>/task-3)
//
// After parallel execution completes, branches are merged back sequentially.
// If a merge conflict occurs (two subtasks edited the same lines), the merge
// is aborted and the conflict is reported — never silently overwritten.
//
// Lifecycle:
//   1. initialize()                — Verify git repo, record base branch
//   2. createWorktree(subtaskId)   — One per parallel subtask
//   3. [subagents execute, targeting their worktree paths]
//   4. mergeAllSequentially(ids)   — Commit, merge, report conflicts
//   5. cleanupAll()                — Remove worktrees and temp branches
// ============================================================================

/**
 * Information about a single git worktree created for a subtask.
 */
export interface WorktreeInfo {
    /** The subtask ID this worktree belongs to */
    subtaskId: string;
    /** The git branch created for this worktree */
    branch: string;
    /** Absolute filesystem path to the worktree checkout */
    worktreePath: string;
}

/**
 * Result of merging a worktree's branch back to the base branch.
 */
export interface WorktreeMergeResult {
    /** Which subtask this merge result is for */
    subtaskId: string;
    /** Whether the merge succeeded */
    success: boolean;
    /** Files that had merge conflicts (only set on conflict) */
    conflictFiles?: string[];
    /** Error message if the merge failed */
    error?: string;
    /** Whether the worktree had any changes to merge */
    hasChanges: boolean;
}

export class WorktreeManager {
    private worktrees = new Map<string, WorktreeInfo>();
    private repoRoot: string;
    private sessionId: string;
    private baseBranch: string = '';
    private baseDir: string;
    private initialized = false;

    constructor(repoRoot: string, sessionId: string) {
        this.repoRoot = repoRoot;
        this.sessionId = sessionId;
        // Keep worktrees in OS temp to avoid polluting the workspace
        this.baseDir = path.join(os.tmpdir(), 'johann-worktrees', sessionId);
    }

    /**
     * SECURITY: Validate that a path is under the expected worktree base
     * before performing destructive operations (fs.rm).
     * Prevents accidental deletion of paths outside the temp directory.
     */
    private assertSafePath(targetPath: string): void {
        const expectedPrefix = path.join(os.tmpdir(), 'johann-worktrees');
        const resolved = path.resolve(targetPath);
        if (!resolved.startsWith(expectedPrefix)) {
            throw new Error(
                `SECURITY: Refusing to delete path outside worktree base: ${resolved}`
            );
        }
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Initialize the manager. Verifies git is available, workspace is a git repo,
     * and records the current branch for later merges.
     *
     * Also cleans up orphaned worktrees and branches from previous crashed sessions.
     *
     * @returns true if initialization succeeded, false if worktrees can't be used
     */
    async initialize(): Promise<boolean> {
        try {
            // Verify git is available
            await this.execGit(this.repoRoot, ['--version']);

            // Verify workspace is inside a git repo
            await this.execGit(this.repoRoot, ['rev-parse', '--is-inside-work-tree']);

            // Record the current branch (we'll merge worktree branches back to this)
            const branchOutput = await this.execGit(this.repoRoot, [
                'rev-parse', '--abbrev-ref', 'HEAD'
            ]);
            this.baseBranch = branchOutput.trim();

            // Handle detached HEAD — use short commit hash as reference
            if (this.baseBranch === 'HEAD') {
                const hash = await this.execGit(this.repoRoot, [
                    'rev-parse', '--short', 'HEAD'
                ]);
                this.baseBranch = hash.trim();
            }

            // Clean up orphaned worktrees and branches from previous crashed sessions
            await this.cleanupOrphanedWorktrees();

            this.initialized = true;
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create a dedicated worktree for a subtask.
     * Forks a new branch from the current HEAD and checks it out at a temp path.
     */
    async createWorktree(subtaskId: string): Promise<WorktreeInfo> {
        if (!this.initialized) {
            throw new Error('WorktreeManager not initialized — call initialize() first');
        }

        const sanitizedId = subtaskId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const shortSession = this.sessionId.substring(0, 16);
        const branch = `johann/${shortSession}/${sanitizedId}`;
        const worktreePath = path.join(this.baseDir, sanitizedId);

        // Ensure parent directory exists
        await fs.mkdir(path.dirname(worktreePath), { recursive: true });

        // Create worktree with a new branch forked from HEAD
        await this.execGit(this.repoRoot, [
            'worktree', 'add', '-b', branch, worktreePath
        ]);

        // Configure git identity in the worktree so commits don't fail
        // even if the user hasn't set global git config
        try {
            await this.execGit(worktreePath, ['config', 'user.name', 'Johann']);
            await this.execGit(worktreePath, ['config', 'user.email', 'johann@orchestrator.local']);
        } catch { /* non-fatal — global config may suffice */ }

        const info: WorktreeInfo = { subtaskId, branch, worktreePath };
        this.worktrees.set(subtaskId, info);
        return info;
    }

    // ========================================================================
    // COMMIT & MERGE
    // ========================================================================

    /**
     * Stage and commit any uncommitted changes in a worktree.
     * Called automatically before merging, but can be called explicitly.
     *
     * @returns true if changes were committed, false if worktree was clean
     */
    async commitWorktreeChanges(subtaskId: string): Promise<boolean> {
        const info = this.worktrees.get(subtaskId);
        if (!info) { return false; }

        try {
            // Check for any changes (staged, unstaged, or untracked)
            const status = await this.execGit(info.worktreePath, ['status', '--porcelain']);
            if (!status.trim()) {
                return false; // Worktree is clean
            }

            // Stage everything
            await this.execGit(info.worktreePath, ['add', '-A']);

            // Commit with a descriptive message
            await this.execGit(info.worktreePath, [
                'commit',
                '-m', `Johann subtask: ${subtaskId}`,
                '--author', 'Johann <johann@orchestrator.local>',
                '--allow-empty-message',
            ]);

            return true;
        } catch {
            return false;
        }
    }

    /**
     * Merge a single worktree's branch back into the base branch.
     *
     * If merge conflicts occur, the merge is aborted and conflict details
     * are returned. The repo is left in a clean state either way.
     */
    async mergeWorktree(subtaskId: string): Promise<WorktreeMergeResult> {
        const info = this.worktrees.get(subtaskId);
        if (!info) {
            return { subtaskId, success: false, error: 'Worktree not found', hasChanges: false };
        }

        try {
            // Auto-commit any remaining changes in the worktree
            await this.commitWorktreeChanges(subtaskId);

            // Check if the branch has any commits beyond the base
            const log = await this.execGit(this.repoRoot, [
                'log', `${this.baseBranch}..${info.branch}`, '--oneline'
            ]);

            if (!log.trim()) {
                return { subtaskId, success: true, hasChanges: false };
            }

            // Attempt the merge
            try {
                await this.execGit(this.repoRoot, [
                    'merge', info.branch, '--no-ff',
                    '-m', `Johann: merge subtask "${subtaskId}"`,
                ]);
                return { subtaskId, success: true, hasChanges: true };
            } catch {
                // Check if this is a merge conflict
                return await this.handleMergeFailure(subtaskId);
            }
        } catch (err) {
            return {
                subtaskId,
                success: false,
                error: err instanceof Error ? err.message : String(err),
                hasChanges: false,
            };
        }
    }

    /**
     * Merge all worktrees sequentially, handling stash/unstash of the main
     * workspace's uncommitted changes.
     *
     * Sequential merge order matters: if subtask A and B both modified a file,
     * A merges first, then B's merge will detect the conflict.
     */
    async mergeAllSequentially(subtaskIds: string[]): Promise<WorktreeMergeResult[]> {
        const results: WorktreeMergeResult[] = [];

        // Stash any uncommitted changes in the main workspace to ensure
        // a clean working tree for merges
        let stashed = false;
        try {
            const status = await this.execGit(this.repoRoot, ['status', '--porcelain']);
            if (status.trim()) {
                await this.execGit(this.repoRoot, [
                    'stash', 'push', '-m', 'Johann: auto-stash before worktree merge'
                ]);
                stashed = true;
            }
        } catch { /* proceed without stashing */ }

        try {
            for (const id of subtaskIds) {
                const result = await this.mergeWorktree(id);
                results.push(result);
            }
        } finally {
            // Restore stashed changes
            if (stashed) {
                try {
                    await this.execGit(this.repoRoot, ['stash', 'pop']);
                } catch { /* stash pop may conflict — leave in stash list */ }
            }
        }

        return results;
    }

    // ========================================================================
    // CLEANUP
    // ========================================================================

    /**
     * Remove a single worktree and delete its tracking branch.
     */
    async cleanupWorktree(subtaskId: string): Promise<void> {
        const info = this.worktrees.get(subtaskId);
        if (!info) { return; }

        // Remove the git worktree
        try {
            await this.execGit(this.repoRoot, [
                'worktree', 'remove', info.worktreePath, '--force'
            ]);
        } catch {
            // Force-remove the directory if git worktree remove fails
            try { this.assertSafePath(info.worktreePath); await fs.rm(info.worktreePath, { recursive: true, force: true }); } catch { /* */ }
        }

        // Delete the tracking branch
        try {
            await this.execGit(this.repoRoot, ['branch', '-D', info.branch]);
        } catch { /* branch may already be deleted or merged */ }

        this.worktrees.delete(subtaskId);
    }

    /**
     * Clean up ALL worktrees and branches for this session.
     * Safe to call multiple times — idempotent.
     */
    async cleanupAll(): Promise<void> {
        const ids = [...this.worktrees.keys()];
        for (const id of ids) {
            await this.cleanupWorktree(id);
        }

        // Remove the session temp directory
        try {
            this.assertSafePath(this.baseDir);
            await fs.rm(this.baseDir, { recursive: true, force: true });
        } catch { /* may already be gone */ }

        // Prune any dangling worktree refs
        try {
            await this.execGit(this.repoRoot, ['worktree', 'prune']);
        } catch { /* non-fatal */ }
    }

    // ========================================================================
    // ACCESSORS
    // ========================================================================

    /** Get the worktree path for a subtask, if one exists. */
    getWorktreePath(subtaskId: string): string | undefined {
        return this.worktrees.get(subtaskId)?.worktreePath;
    }

    /** Get the base branch name. */
    getBaseBranch(): string {
        return this.baseBranch;
    }

    /** Check if the manager is initialized and ready. */
    isReady(): boolean {
        return this.initialized;
    }

    /** Get a summary of all managed worktrees (for debugging). */
    getSummary(): string {
        if (this.worktrees.size === 0) {
            return 'No active worktrees';
        }
        const lines = [`Base branch: ${this.baseBranch}`, `Session: ${this.sessionId}`, ''];
        for (const [, info] of this.worktrees) {
            lines.push(`  - ${info.subtaskId}: ${info.branch} → ${info.worktreePath}`);
        }
        return lines.join('\n');
    }

    // ========================================================================
    // ORPHAN CLEANUP — Recover from previous crashed sessions
    // ========================================================================

    /**
     * Clean up orphaned worktrees, branches, and temp directories from
     * previous crashed sessions that didn't get a chance to run cleanupAll().
     *
     * This scans for:
     *   1. Stale git worktrees (via `git worktree prune`)
     *   2. Orphaned `johann/*` branches (not associated with current session)
     *   3. Leftover temp directories under /tmp/johann-worktrees/
     *
     * Called automatically during initialize() to prevent resource accumulation.
     */
    private async cleanupOrphanedWorktrees(): Promise<void> {
        // Step 1: Prune stale worktree refs from git
        try {
            await this.execGit(this.repoRoot, ['worktree', 'prune']);
        } catch { /* non-fatal */ }

        // Step 2: Find and delete orphaned johann/* branches
        // Keep branches belonging to the CURRENT session (this.sessionId)
        try {
            const branchOutput = await this.execGit(this.repoRoot, [
                'branch', '--list', 'johann/*'
            ]);
            const branches = branchOutput
                .split('\n')
                .map(b => b.trim().replace(/^\*\s*/, ''))
                .filter(b => b.length > 0);

            const shortSession = this.sessionId.substring(0, 16);

            for (const branch of branches) {
                // Don't delete branches belonging to the current session
                if (branch.includes(shortSession)) continue;

                try {
                    // Check if this branch has an active worktree
                    // If so, remove the worktree first
                    const worktreeList = await this.execGit(this.repoRoot, [
                        'worktree', 'list', '--porcelain'
                    ]);
                    const hasWorktree = worktreeList.includes(`branch refs/heads/${branch}`);

                    if (hasWorktree) {
                        // Find the worktree path for this branch
                        const lines = worktreeList.split('\n');
                        let worktreePath = '';
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i] === `branch refs/heads/${branch}`) {
                                // Walk backwards to find the "worktree" line
                                for (let j = i - 1; j >= 0; j--) {
                                    if (lines[j].startsWith('worktree ')) {
                                        worktreePath = lines[j].substring('worktree '.length);
                                        break;
                                    }
                                }
                                break;
                            }
                        }
                        if (worktreePath) {
                            try {
                                await this.execGit(this.repoRoot, [
                                    'worktree', 'remove', worktreePath, '--force'
                                ]);
                            } catch {
                                // Force-remove the directory
                                try { this.assertSafePath(worktreePath); await fs.rm(worktreePath, { recursive: true, force: true }); } catch { /* */ }
                            }
                        }
                    }

                    // Delete the orphaned branch
                    await this.execGit(this.repoRoot, ['branch', '-D', branch]);
                } catch {
                    // Non-fatal — branch may already be gone or locked
                }
            }
        } catch {
            // Non-fatal — branch listing may fail in edge cases
        }

        // Step 3: Clean up orphaned temp directories
        // Scan /tmp/johann-worktrees/ for session dirs that aren't ours
        try {
            const worktreeBase = path.join(os.tmpdir(), 'johann-worktrees');
            const entries = await fs.readdir(worktreeBase).catch(() => [] as string[]);

            for (const entry of entries) {
                // Don't delete the current session's temp dir
                if (entry === this.sessionId) continue;

                const entryPath = path.join(worktreeBase, entry);
                try {
                    const stat = await fs.stat(entryPath);
                    if (stat.isDirectory()) {
                        // Only clean up dirs older than 1 hour to avoid
                        // racing with a concurrent session that just started
                        const ageMs = Date.now() - stat.mtimeMs;
                        if (ageMs > 60 * 60 * 1000) {
                            this.assertSafePath(entryPath);
                            await fs.rm(entryPath, { recursive: true, force: true });
                        }
                    }
                } catch {
                    // Non-fatal
                }
            }
        } catch {
            // Non-fatal — /tmp/johann-worktrees/ may not exist
        }
    }

    // ========================================================================
    // INTERNALS
    // ========================================================================

    /**
     * Handle a failed merge — check for conflicts, abort if needed.
     */
    private async handleMergeFailure(subtaskId: string): Promise<WorktreeMergeResult> {
        try {
            const status = await this.execGit(this.repoRoot, ['status', '--porcelain']);
            const conflictFiles = status
                .split('\n')
                .filter(line => /^(UU|AA|DD|AU|UA|DU|UD)\s/.test(line))
                .map(line => line.substring(3).trim());

            if (conflictFiles.length > 0) {
                // Abort merge to leave the repo in a clean state
                try {
                    await this.execGit(this.repoRoot, ['merge', '--abort']);
                } catch { /* already aborted or no merge in progress */ }

                return {
                    subtaskId,
                    success: false,
                    conflictFiles,
                    error: `Merge conflicts in ${conflictFiles.length} file(s): ${conflictFiles.join(', ')}`,
                    hasChanges: true,
                };
            }

            // Non-conflict merge failure
            try {
                await this.execGit(this.repoRoot, ['merge', '--abort']);
            } catch { /* */ }

            return {
                subtaskId,
                success: false,
                error: 'Merge failed (non-conflict error)',
                hasChanges: true,
            };
        } catch (err) {
            return {
                subtaskId,
                success: false,
                error: err instanceof Error ? err.message : String(err),
                hasChanges: false,
            };
        }
    }

    /**
     * Run a git command safely using execFile (no shell injection).
     */
    private async execGit(cwd: string, args: string[]): Promise<string> {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            timeout: 30_000,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
        });
        return stdout;
    }
}
