import * as vscode from 'vscode';
import { getJohannWorkspaceUri } from './bootstrap';
import { safeAppend } from './safeIO';

// ============================================================================
// DAILY NOTES — Append-only daily log files
//
// Inspired by OpenClaw's memory architecture:
// - Each day gets a single file: memory/YYYY-MM-DD.md
// - New entries are APPENDED (never overwritten)
// - Raw observations, learnings, events go here
// - Agent distills daily notes into curated MEMORY.md during heartbeats
// - This is the "working memory" vs MEMORY.md's "long-term memory"
// ============================================================================

/**
 * A single daily note entry before appending.
 */
export interface DailyNoteEntry {
    /** ISO timestamp */
    timestamp: string;
    /** Category tag (observation, learning, decision, event, error, user) */
    category: 'observation' | 'learning' | 'decision' | 'event' | 'error' | 'user';
    /** Short title */
    title: string;
    /** Full content */
    content: string;
}

/**
 * Get today's date string in YYYY-MM-DD format.
 */
function todayDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
}

/**
 * Get the memory subdirectory URI.
 */
function getMemoryDirUri(): vscode.Uri | undefined {
    const base = getJohannWorkspaceUri();
    if (!base) {
        return undefined;
    }
    return vscode.Uri.joinPath(base, 'memory');
}

/**
 * Get the URI for a specific day's note file.
 */
function getDailyNoteUri(date?: string): vscode.Uri | undefined {
    const memDir = getMemoryDirUri();
    if (!memDir) {
        return undefined;
    }
    const d = date || todayDateString();
    return vscode.Uri.joinPath(memDir, `${d}.md`);
}

/**
 * Ensure the memory directory exists.
 */
async function ensureMemoryDir(): Promise<vscode.Uri | undefined> {
    const memDir = getMemoryDirUri();
    if (!memDir) {
        return undefined;
    }
    try {
        await vscode.workspace.fs.createDirectory(memDir);
    } catch {
        // Already exists
    }
    return memDir;
}

/**
 * Read a file's content, returning empty string if not found.
 */
async function readFileContent(uri: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

/**
 * Format a daily note entry as markdown text.
 */
function formatEntry(entry: DailyNoteEntry): string {
    const time = entry.timestamp.split('T')[1]?.replace('Z', '') || entry.timestamp;
    const lines: string[] = [];
    lines.push(`### ${time} — [${entry.category}] ${entry.title}`);
    lines.push('');
    lines.push(entry.content);
    lines.push('');
    return lines.join('\n');
}

/**
 * Create the header for a new daily note file.
 */
function createDailyHeader(date: string): string {
    const lines: string[] = [];
    lines.push(`# Daily Notes — ${date}`);
    lines.push('');
    lines.push('> Raw observations, learnings, and events.');
    lines.push('> Distill important items into MEMORY.md during heartbeats.');
    lines.push('');
    lines.push('---');
    lines.push('');
    return lines.join('\n');
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Append an entry to today's daily notes file.
 * Creates the file with a header if it doesn't exist.
 *
 * Uses safeAppend() which provides:
 *   - Per-file mutex to prevent concurrent-write corruption
 *   - Atomic write (temp file + rename) to prevent half-written files
 *   - Deduplication guard to prevent double-appends from retries
 */
export async function appendDailyNote(entry: DailyNoteEntry): Promise<void> {
    await ensureMemoryDir();
    const noteUri = getDailyNoteUri();
    if (!noteUri) {
        return;
    }

    const date = todayDateString();
    const formattedEntry = '\n' + formatEntry(entry);

    await safeAppend(noteUri, formattedEntry, createDailyHeader(date), true);
}

/**
 * Shorthand: log a quick observation to today's daily notes.
 */
export async function logObservation(title: string, content: string): Promise<void> {
    await appendDailyNote({
        timestamp: new Date().toISOString(),
        category: 'observation',
        title,
        content,
    });
}

/**
 * Shorthand: log a learning to today's daily notes.
 */
export async function logLearning(title: string, content: string): Promise<void> {
    await appendDailyNote({
        timestamp: new Date().toISOString(),
        category: 'learning',
        title,
        content,
    });
}

/**
 * Shorthand: log a decision to today's daily notes.
 */
export async function logDecision(title: string, content: string): Promise<void> {
    await appendDailyNote({
        timestamp: new Date().toISOString(),
        category: 'decision',
        title,
        content,
    });
}

/**
 * Shorthand: log an event to today's daily notes.
 */
export async function logEvent(title: string, content: string): Promise<void> {
    await appendDailyNote({
        timestamp: new Date().toISOString(),
        category: 'event',
        title,
        content,
    });
}

/**
 * Shorthand: log an error to today's daily notes.
 */
export async function logError(title: string, content: string): Promise<void> {
    await appendDailyNote({
        timestamp: new Date().toISOString(),
        category: 'error',
        title,
        content,
    });
}

/**
 * Shorthand: log user info to today's daily notes.
 */
export async function logUserInfo(title: string, content: string): Promise<void> {
    await appendDailyNote({
        timestamp: new Date().toISOString(),
        category: 'user',
        title,
        content,
    });
}

/**
 * Read today's daily notes.
 */
export async function readTodayNotes(): Promise<string> {
    const noteUri = getDailyNoteUri();
    if (!noteUri) {
        return '';
    }
    return readFileContent(noteUri);
}

/**
 * Read daily notes for a specific date.
 */
export async function readDailyNotes(date: string): Promise<string> {
    const noteUri = getDailyNoteUri(date);
    if (!noteUri) {
        return '';
    }
    return readFileContent(noteUri);
}

/**
 * List all daily note files, sorted newest first.
 */
export async function listDailyNotes(): Promise<string[]> {
    const memDir = getMemoryDirUri();
    if (!memDir) {
        return [];
    }

    try {
        const entries = await vscode.workspace.fs.readDirectory(memDir);
        return entries
            .filter(
                ([name, type]) =>
                    type === vscode.FileType.File && /^\d{4}-\d{2}-\d{2}\.md$/.test(name),
            )
            .map(([name]) => name.replace('.md', ''))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

/**
 * Read the N most recent daily notes as a combined string.
 * Useful for injecting recent context into prompts.
 */
export async function getRecentDailyNotesContext(
    maxDays: number = 3,
    maxChars: number = 4000,
): Promise<string> {
    const dates = await listDailyNotes();
    if (dates.length === 0) {
        return '';
    }

    const lines: string[] = ['=== Recent Daily Notes ===', ''];
    let totalChars = 0;

    for (const date of dates.slice(0, maxDays)) {
        const content = await readDailyNotes(date);
        if (totalChars + content.length > maxChars) {
            // Truncate this day's notes
            const remaining = maxChars - totalChars - 100;
            if (remaining > 200) {
                lines.push(content.substring(0, remaining));
                lines.push('\n[... truncated ...]');
            }
            break;
        }
        lines.push(content);
        lines.push('');
        totalChars += content.length;
    }

    return lines.join('\n');
}
