import * as vscode from 'vscode';
import * as crypto from 'crypto';

// ============================================================================
// SAFE I/O — Atomic writes and mutex-protected read-modify-write
//
// Prevents the file corruption that occurs when:
//   1. Two concurrent writers (parallel subagents) race on the same file
//   2. A process crash mid-write leaves a half-written file
//   3. Repeated appends duplicate content due to read-modify-write races
//
// Core patterns:
//   - atomicWrite(): Write to a temp file, then rename → crash-safe
//   - withFileLock(): Per-file async mutex → serializes concurrent writers
//   - safeAppend(): Locked read-modify-write with dedup guard
//
// All functions use vscode.workspace.fs for consistency with the rest of
// Johann (works across remote workspaces, virtual file systems, etc.)
// ============================================================================

/**
 * In-process per-file mutex.
 *
 * Maps file URI strings to a promise chain. Each writer awaits the previous
 * writer's promise before proceeding, ensuring serial access per file.
 *
 * This protects against in-process concurrency (e.g., multiple parallel
 * subagents running in the same extension host). It does NOT protect against
 * cross-process races, but Johann runs in a single extension host so this
 * is sufficient.
 */
const fileLocks = new Map<string, Promise<void>>();

/**
 * Acquire a per-file lock and run the callback while holding it.
 *
 * Multiple concurrent calls to `withFileLock` for the SAME URI will execute
 * serially in FIFO order. Calls for DIFFERENT URIs run in parallel.
 *
 * @param uri  The file URI to lock on
 * @param fn   The callback to run while holding the lock
 * @returns    The callback's return value
 */
export async function withFileLock<T>(uri: vscode.Uri, fn: () => Promise<T>): Promise<T> {
    const key = uri.toString();

    // Chain onto the existing lock (or start a new chain)
    const prev = fileLocks.get(key) ?? Promise.resolve();

    let resolve: () => void;
    const next = new Promise<void>((r) => {
        resolve = r;
    });
    fileLocks.set(key, next);

    // Wait for the previous holder to finish
    await prev;

    try {
        return await fn();
    } finally {
        resolve!();
        // Clean up the lock entry if nothing else queued after us
        if (fileLocks.get(key) === next) {
            fileLocks.delete(key);
        }
    }
}

/**
 * Write content to a file atomically.
 *
 * Strategy: write to a `.tmp` sibling, then rename over the target.
 * If the process crashes during the write, the temp file is left behind
 * (harmless) and the original file is intact.
 *
 * Falls back to a direct write when rename is not supported (some virtual
 * file system providers don't implement rename).
 *
 * @param uri      Target file URI
 * @param content  Content to write (string or Uint8Array)
 */
export async function atomicWrite(uri: vscode.Uri, content: string | Uint8Array): Promise<void> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    // Generate a unique temp file name adjacent to the target
    const suffix = crypto.randomBytes(6).toString('hex');
    const tmpUri = vscode.Uri.joinPath(
        uri.with({ path: uri.path.replace(/\/[^/]+$/, '') }), // parent dir
        `.${uri.path.split('/').pop()}.${suffix}.tmp`,
    );

    try {
        // Step 1: Write to temp file
        await vscode.workspace.fs.writeFile(tmpUri, data);

        // Step 2: Rename temp → target (atomic on most filesystems)
        await vscode.workspace.fs.rename(tmpUri, uri, { overwrite: true });
    } catch {
        // Fallback for providers that don't support rename:
        // Write directly (less safe, but better than failing)
        try {
            await vscode.workspace.fs.delete(tmpUri);
        } catch {
            // Temp file may not exist if write failed
        }

        // Direct write as fallback
        await vscode.workspace.fs.writeFile(uri, data);
    }
}

/**
 * Safely append content to a file with mutex protection.
 *
 * Uses `withFileLock` to serialize concurrent appends, and `atomicWrite`
 * to ensure the final write is crash-safe.
 *
 * @param uri        Target file URI
 * @param newContent Content to append
 * @param header     Header to write if the file doesn't exist yet
 * @param dedup      If true, skips the append when the file already ends with `newContent`
 */
export async function safeAppend(
    uri: vscode.Uri,
    newContent: string,
    header?: string,
    dedup: boolean = true,
): Promise<void> {
    await withFileLock(uri, async () => {
        let existing = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            existing = new TextDecoder().decode(bytes);
        } catch {
            // File doesn't exist yet
        }

        // Deduplication: skip if the content we're about to append is already
        // at the end of the file (protects against double-appends from retries)
        if (dedup && existing.length > 0 && existing.trimEnd().endsWith(newContent.trimEnd())) {
            return;
        }

        let finalContent: string;
        if (existing.trim().length === 0 && header) {
            finalContent = header + newContent;
        } else {
            finalContent = existing + newContent;
        }

        await atomicWrite(uri, finalContent);
    });
}

/**
 * Safely write a file with mutex protection and atomic write.
 *
 * Use this for files that are fully overwritten (not appended to),
 * where you still need concurrency protection (e.g., ledger.json).
 *
 * @param uri     Target file URI
 * @param content Content to write
 */
export async function safeWrite(uri: vscode.Uri, content: string | Uint8Array): Promise<void> {
    await withFileLock(uri, async () => {
        await atomicWrite(uri, content);
    });
}

/**
 * Read a file's content safely, returning empty string if not found.
 * Uses the file lock to prevent reading a half-written file.
 *
 * Note: This only protects against in-process races. If you just need
 * a quick read without concurrency concerns, use `vscode.workspace.fs.readFile`
 * directly.
 *
 * @param uri The file URI to read
 */
export async function safeRead(uri: vscode.Uri): Promise<string> {
    return withFileLock(uri, async () => {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return new TextDecoder().decode(bytes);
        } catch {
            return '';
        }
    });
}

/**
 * Clean up any leftover `.tmp` files from previous interrupted atomic writes.
 * Call this during initialization to tidy up.
 *
 * @param dirUri Directory to scan for orphaned temp files
 */
export async function cleanupTempFiles(dirUri: vscode.Uri): Promise<number> {
    let cleaned = 0;
    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.endsWith('.tmp') && name.startsWith('.')) {
                try {
                    await vscode.workspace.fs.delete(vscode.Uri.joinPath(dirUri, name));
                    cleaned++;
                } catch {
                    // Non-critical
                }
            }
        }
    } catch {
        // Directory may not exist
    }
    return cleaned;
}
