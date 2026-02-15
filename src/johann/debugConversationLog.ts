import * as vscode from 'vscode';
import { getConfig } from './config';
import { extractErrorMessage } from './retry';

// ============================================================================
// DEBUG CONVERSATION LOG — Full LLM conversation capture
//
// Writes complete LLM request/response transcripts to:
//   .vscode/johann/debug/<date>_<sessionId>.md
//
// This captures EVERYTHING Johann sends to and receives from Copilot's
// language models so you can inspect the exact conversation when things
// hang, fail, or behave unexpectedly.
//
// Each LLM call is logged as a section with:
//   - Timestamp
//   - Phase (planning, subtask execution, review, merge)
//   - Model used
//   - Full prompt sent
//   - Full response received (streamed chunks assembled)
//   - Duration
//   - Error info (if any)
//
// Toggle: johann.debugConversationLog (default: true)
// ============================================================================

/**
 * Phase labels for organizing the log.
 */
export type DebugPhase =
    | 'planning'
    | 'subtask-execution'
    | 'review'
    | 'merge'
    | 'worktree'
    | 'resume'
    | 'other';

/**
 * A single logged LLM exchange.
 */
export interface DebugLogEntry {
    /** When this call started */
    timestamp: string;
    /** Which phase of orchestration */
    phase: DebugPhase;
    /** Label / description (e.g., subtask title) */
    label: string;
    /** Model identifier */
    model: string;
    /** The full prompt(s) sent to the LLM */
    promptMessages: string[];
    /** The full response text received */
    responseText: string;
    /** Duration in ms */
    durationMs: number;
    /** Error message (if the call failed) */
    error?: string;
    /** Whether this call was a retry attempt */
    retryAttempt?: number;
}

/**
 * Manages a debug conversation log file for a single orchestration session.
 *
 * Usage:
 *   const debugLog = new DebugConversationLog(sessionId);
 *   await debugLog.initialize();
 *   // ... during orchestration:
 *   await debugLog.logLLMCall({ ... });
 *   // at end:
 *   await debugLog.finalize('completed');
 */
export class DebugConversationLog {
    private sessionId: string;
    private logUri: vscode.Uri | undefined;
    private entries: DebugLogEntry[] = [];
    private enabled: boolean;
    private startTime: string;
    private buffer: string[] = [];
    private initialized = false;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
        this.enabled = getConfig().debugConversationLog ?? true;
        this.startTime = new Date().toISOString();
    }

    /**
     * Whether debug logging is active for this session.
     */
    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Initialize — create the debug directory and log file with a header.
     */
    async initialize(): Promise<boolean> {
        if (!this.enabled) {
            return false;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return false;
        }

        const rootUri = workspaceFolders[0].uri;
        const debugDir = vscode.Uri.joinPath(rootUri, '.vscode', 'johann', 'debug');

        try {
            await vscode.workspace.fs.createDirectory(debugDir);
        } catch {
            // Already exists
        }

        const datePrefix = new Date().toISOString().split('T')[0];
        const timeSlug = new Date().toISOString().split('T')[1]?.replace(/[:.]/g, '-').substring(0, 8) || '';
        const filename = `${datePrefix}_${timeSlug}_${this.sessionId}.md`;
        this.logUri = vscode.Uri.joinPath(debugDir, filename);

        // Write the header
        this.buffer.push(`# Johann Debug Log — ${this.sessionId}\n`);
        this.buffer.push(`**Started:** ${this.startTime}  `);
        this.buffer.push(`**Log file:** \`${filename}\`\n`);
        this.buffer.push(`---\n`);

        await this.flush();
        this.initialized = true;
        return true;
    }

    /**
     * Log a complete LLM call (request + response).
     * Call this after the LLM response has been fully streamed.
     */
    async logLLMCall(entry: DebugLogEntry): Promise<void> {
        if (!this.enabled || !this.initialized) {
            return;
        }

        this.entries.push(entry);

        const section: string[] = [];
        const callNumber = this.entries.length;

        section.push(`## Call #${callNumber} — ${entry.phase} — ${entry.label}\n`);
        section.push(`| Field | Value |`);
        section.push(`|-------|-------|`);
        section.push(`| **Timestamp** | ${entry.timestamp} |`);
        section.push(`| **Phase** | ${entry.phase} |`);
        section.push(`| **Model** | \`${entry.model}\` |`);
        section.push(`| **Duration** | ${entry.durationMs}ms (${(entry.durationMs / 1000).toFixed(1)}s) |`);
        if (entry.retryAttempt !== undefined) {
            section.push(`| **Retry** | Attempt #${entry.retryAttempt} |`);
        }
        if (entry.error) {
            section.push(`| **Error** | ⚠️ ${entry.error.substring(0, 200)} |`);
        }
        section.push('');

        // Prompt
        section.push(`### Prompt Sent\n`);
        for (let i = 0; i < entry.promptMessages.length; i++) {
            section.push(`<details><summary>Message ${i + 1} (${entry.promptMessages[i].length.toLocaleString()} chars)</summary>\n`);
            section.push('```');
            // Truncate extremely long prompts but keep enough to be useful
            const prompt = entry.promptMessages[i];
            if (prompt.length > 20000) {
                section.push(prompt.substring(0, 10000));
                section.push(`\n... [TRUNCATED: ${(prompt.length - 20000).toLocaleString()} chars omitted] ...\n`);
                section.push(prompt.substring(prompt.length - 10000));
            } else {
                section.push(prompt);
            }
            section.push('```\n');
            section.push('</details>\n');
        }

        // Response
        section.push(`### Response Received (${entry.responseText.length.toLocaleString()} chars)\n`);
        if (entry.responseText.length > 0) {
            section.push(`<details><summary>Full response</summary>\n`);
            section.push('```');
            const resp = entry.responseText;
            if (resp.length > 30000) {
                section.push(resp.substring(0, 15000));
                section.push(`\n... [TRUNCATED: ${(resp.length - 30000).toLocaleString()} chars omitted] ...\n`);
                section.push(resp.substring(resp.length - 15000));
            } else {
                section.push(resp);
            }
            section.push('```\n');
            section.push('</details>\n');
        } else if (entry.error) {
            section.push(`*No response — call failed with error.*\n`);
        } else {
            section.push(`*Empty response.*\n`);
        }

        section.push(`---\n`);

        this.buffer.push(...section);
        await this.flush();
    }

    /**
     * Log a non-LLM event (phase transitions, errors, notes).
     */
    async logEvent(phase: DebugPhase, message: string): Promise<void> {
        if (!this.enabled || !this.initialized) {
            return;
        }

        this.buffer.push(`> **[${new Date().toISOString()}] [${phase}]** ${message}\n`);
        await this.flush();
    }

    /**
     * Finalize the log with session summary.
     */
    async finalize(outcome: 'completed' | 'failed' | 'cancelled', errorMessage?: string): Promise<void> {
        if (!this.enabled || !this.initialized) {
            return;
        }

        const endTime = new Date().toISOString();
        const totalDuration = Date.now() - new Date(this.startTime).getTime();

        const summary: string[] = [];
        summary.push(`## Session Summary\n`);
        summary.push(`| Field | Value |`);
        summary.push(`|-------|-------|`);
        summary.push(`| **Outcome** | ${outcome} |`);
        summary.push(`| **Started** | ${this.startTime} |`);
        summary.push(`| **Ended** | ${endTime} |`);
        summary.push(`| **Total Duration** | ${(totalDuration / 1000).toFixed(1)}s |`);
        summary.push(`| **Total LLM Calls** | ${this.entries.length} |`);

        const successful = this.entries.filter(e => !e.error).length;
        const failed = this.entries.filter(e => e.error).length;
        summary.push(`| **Successful** | ${successful} |`);
        summary.push(`| **Failed** | ${failed} |`);

        if (errorMessage) {
            summary.push(`| **Final Error** | ${errorMessage.substring(0, 200)} |`);
        }

        // Duration breakdown by phase
        const byPhase = new Map<DebugPhase, { count: number; totalMs: number }>();
        for (const entry of this.entries) {
            const existing = byPhase.get(entry.phase) || { count: 0, totalMs: 0 };
            existing.count++;
            existing.totalMs += entry.durationMs;
            byPhase.set(entry.phase, existing);
        }

        summary.push('');
        summary.push(`### Duration by Phase\n`);
        summary.push(`| Phase | Calls | Total Time |`);
        summary.push(`|-------|-------|------------|`);
        for (const [phase, stats] of byPhase) {
            summary.push(`| ${phase} | ${stats.count} | ${(stats.totalMs / 1000).toFixed(1)}s |`);
        }

        // Timeline of calls
        summary.push('');
        summary.push(`### Call Timeline\n`);
        summary.push(`| # | Time | Phase | Label | Model | Duration | Status |`);
        summary.push(`|---|------|-------|-------|-------|----------|--------|`);
        for (let i = 0; i < this.entries.length; i++) {
            const e = this.entries[i];
            const timeOffset = new Date(e.timestamp).getTime() - new Date(this.startTime).getTime();
            const status = e.error ? `⚠️ ${e.error.substring(0, 40)}` : '✅';
            summary.push(
                `| ${i + 1} | +${(timeOffset / 1000).toFixed(1)}s | ${e.phase} | ${e.label.substring(0, 40)} | \`${e.model}\` | ${(e.durationMs / 1000).toFixed(1)}s | ${status} |`
            );
        }

        summary.push('');
        this.buffer.push(...summary);
        await this.flush();
    }

    /**
     * Get the number of LLM calls logged so far.
     */
    getCallCount(): number {
        return this.entries.length;
    }

    /**
     * Get the file URI for this debug log (if created).
     */
    getLogUri(): vscode.Uri | undefined {
        return this.logUri;
    }

    // ========================================================================
    // PRIVATE
    // ========================================================================

    /**
     * Flush the buffer to disk.
     * Appends to the file rather than rewriting to handle large logs efficiently.
     */
    private async flush(): Promise<void> {
        if (!this.logUri || this.buffer.length === 0) {
            return;
        }

        const newContent = this.buffer.join('\n') + '\n';
        this.buffer = [];

        try {
            // Read existing content and append
            let existing = '';
            try {
                const bytes = await vscode.workspace.fs.readFile(this.logUri);
                existing = new TextDecoder().decode(bytes);
            } catch {
                // File doesn't exist yet — that's fine
            }

            const updated = existing + newContent;
            await vscode.workspace.fs.writeFile(
                this.logUri,
                new TextEncoder().encode(updated)
            );
        } catch {
            // Silently fail — debug logging is non-critical
        }
    }
}
