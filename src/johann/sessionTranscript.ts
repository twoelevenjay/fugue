import * as vscode from 'vscode';
import { getJohannWorkspaceUri } from './bootstrap';

// ============================================================================
// SESSION TRANSCRIPTS — JSONL conversation recording
//
// Each conversation gets a transcript file in .vscode/johann/sessions/.
// Format: one JSON object per line (JSONL) for easy appending.
// Transcripts enable:
// - Session continuity ("what were we just doing?")
// - Replay and audit
// - Memory distillation source material
// - Context injection for follow-up conversations
// ============================================================================

/**
 * A single transcript entry — one line in the JSONL file.
 */
export interface TranscriptEntry {
    /** ISO timestamp */
    ts: string;
    /** Role: user, agent, system, subtask */
    role: 'user' | 'agent' | 'system' | 'subtask';
    /** Message content */
    content: string;
    /** Optional metadata */
    meta?: Record<string, unknown>;
}

/**
 * Session metadata stored alongside the transcript.
 */
export interface SessionMeta {
    /** Session ID */
    sessionId: string;
    /** When the session started */
    startedAt: string;
    /** When the session ended (updated on close) */
    endedAt?: string;
    /** Summary of what was accomplished */
    summary?: string;
    /** Whether the session is still active */
    active: boolean;
}

/**
 * Manages session transcripts for a single session.
 */
export class SessionTranscript {
    private sessionId: string;
    private sessionDir: vscode.Uri | undefined;
    private transcriptUri: vscode.Uri | undefined;
    private metaUri: vscode.Uri | undefined;
    private meta: SessionMeta;

    constructor(sessionId?: string) {
        this.sessionId = sessionId || this.generateSessionId();
        this.meta = {
            sessionId: this.sessionId,
            startedAt: new Date().toISOString(),
            active: true,
        };
    }

    /**
     * Initialize the session — create the directory and meta file.
     */
    async initialize(): Promise<boolean> {
        const base = getJohannWorkspaceUri();
        if (!base) return false;

        this.sessionDir = vscode.Uri.joinPath(base, 'sessions');
        try {
            await vscode.workspace.fs.createDirectory(this.sessionDir);
        } catch {
            // Already exists
        }

        // Use date prefix for sorting + session ID for uniqueness
        const datePrefix = new Date().toISOString().split('T')[0];
        const filename = `${datePrefix}_${this.sessionId}`;

        this.transcriptUri = vscode.Uri.joinPath(this.sessionDir, `${filename}.jsonl`);
        this.metaUri = vscode.Uri.joinPath(this.sessionDir, `${filename}.meta.json`);

        // Write initial meta
        await this.writeMeta();
        return true;
    }

    /**
     * Append a user message to the transcript.
     */
    async recordUser(content: string, meta?: Record<string, unknown>): Promise<void> {
        await this.append({
            ts: new Date().toISOString(),
            role: 'user',
            content,
            meta,
        });
    }

    /**
     * Append an agent response to the transcript.
     */
    async recordAgent(content: string, meta?: Record<string, unknown>): Promise<void> {
        await this.append({
            ts: new Date().toISOString(),
            role: 'agent',
            content,
            meta,
        });
    }

    /**
     * Append a system event to the transcript.
     */
    async recordSystem(content: string, meta?: Record<string, unknown>): Promise<void> {
        await this.append({
            ts: new Date().toISOString(),
            role: 'system',
            content,
            meta,
        });
    }

    /**
     * Append a subtask result to the transcript.
     */
    async recordSubtask(
        subtaskId: string,
        content: string,
        success: boolean,
        modelUsed: string
    ): Promise<void> {
        await this.append({
            ts: new Date().toISOString(),
            role: 'subtask',
            content,
            meta: { subtaskId, success, modelUsed },
        });
    }

    /**
     * Close the session — update meta with end time and summary.
     */
    async close(summary?: string): Promise<void> {
        this.meta.endedAt = new Date().toISOString();
        this.meta.active = false;
        this.meta.summary = summary;
        await this.writeMeta();
    }

    /**
     * Get the session ID.
     */
    getSessionId(): string {
        return this.sessionId;
    }

    /**
     * Read back the full transcript as an array of entries.
     */
    async readTranscript(): Promise<TranscriptEntry[]> {
        if (!this.transcriptUri) return [];

        try {
            const bytes = await vscode.workspace.fs.readFile(this.transcriptUri);
            const text = new TextDecoder().decode(bytes);
            return text
                .split('\n')
                .filter(line => line.trim().length > 0)
                .map(line => {
                    try {
                        return JSON.parse(line) as TranscriptEntry;
                    } catch {
                        return null;
                    }
                })
                .filter((entry): entry is TranscriptEntry => entry !== null);
        } catch {
            return [];
        }
    }

    /**
     * Get a compact summary of the current session for context injection.
     * Returns the last N messages as a formatted string.
     */
    async getRecentContext(maxEntries: number = 10, maxChars: number = 3000): Promise<string> {
        const entries = await this.readTranscript();
        if (entries.length === 0) return '';

        const recent = entries.slice(-maxEntries);
        const lines: string[] = [`=== Session ${this.sessionId} (recent) ===`, ''];
        let totalChars = 0;

        for (const entry of recent) {
            const line = `[${entry.role}] ${entry.content.substring(0, 500)}`;
            if (totalChars + line.length > maxChars) break;
            lines.push(line);
            totalChars += line.length;
        }

        return lines.join('\n');
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    private async append(entry: TranscriptEntry): Promise<void> {
        if (!this.transcriptUri) return;

        const line = JSON.stringify(entry) + '\n';

        try {
            // Read existing content and append
            let existing = '';
            try {
                const bytes = await vscode.workspace.fs.readFile(this.transcriptUri);
                existing = new TextDecoder().decode(bytes);
            } catch {
                // File doesn't exist yet
            }

            const updated = existing + line;
            await vscode.workspace.fs.writeFile(
                this.transcriptUri,
                new TextEncoder().encode(updated)
            );
        } catch {
            // Silently fail — transcripts are non-critical
        }
    }

    private async writeMeta(): Promise<void> {
        if (!this.metaUri) return;
        try {
            const content = JSON.stringify(this.meta, null, 2);
            await vscode.workspace.fs.writeFile(
                this.metaUri,
                new TextEncoder().encode(content)
            );
        } catch {
            // Silently fail
        }
    }

    private generateSessionId(): string {
        return `s-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    }
}

// ============================================================================
// STATIC HELPERS — List and manage sessions
// ============================================================================

/**
 * List all session transcript files, sorted newest first.
 */
export async function listSessions(): Promise<SessionMeta[]> {
    const base = getJohannWorkspaceUri();
    if (!base) return [];

    const sessionsDir = vscode.Uri.joinPath(base, 'sessions');

    try {
        const entries = await vscode.workspace.fs.readDirectory(sessionsDir);
        const metaFiles = entries
            .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.meta.json'))
            .map(([name]) => name)
            .sort()
            .reverse();

        const sessions: SessionMeta[] = [];
        for (const metaFile of metaFiles) {
            try {
                const metaUri = vscode.Uri.joinPath(sessionsDir, metaFile);
                const bytes = await vscode.workspace.fs.readFile(metaUri);
                const meta = JSON.parse(new TextDecoder().decode(bytes)) as SessionMeta;
                sessions.push(meta);
            } catch {
                // Skip corrupt meta files
            }
        }

        return sessions;
    } catch {
        return [];
    }
}

/**
 * Get a compact summary of recent sessions for context injection.
 */
export async function getRecentSessionsSummary(maxSessions: number = 5): Promise<string> {
    const sessions = await listSessions();
    if (sessions.length === 0) return '';

    const lines: string[] = ['=== Recent Sessions ===', ''];
    for (const session of sessions.slice(0, maxSessions)) {
        const status = session.active ? '🟢 active' : '⚪ closed';
        const summary = session.summary ? ` — ${session.summary}` : '';
        lines.push(`- ${session.startedAt} [${status}] ${session.sessionId}${summary}`);
    }

    return lines.join('\n');
}
