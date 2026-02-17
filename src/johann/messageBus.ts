/**
 * messageBus.ts — Lightweight Inter-Agent Communication
 *
 * Inspired by Gas Town's mail system and the CLI System's inject_context.
 * Provides a shared message board for subagents to communicate during
 * parallel execution.
 *
 * Key capabilities:
 * - Broadcast announcements (global installs, shared discoveries)
 * - Signal conflicts (file contention, lock warnings)
 * - Request orchestrator decisions
 * - Persisted to disk via JSONL (survives crashes)
 *
 * Storage:
 *   .vscode/johann/sessions/<sessionId>/messages/
 *     broadcast.jsonl     — global announcements
 *     <subtaskId>.jsonl   — direct messages to a specific subtask
 */

import * as vscode from 'vscode';
import { getJohannWorkspaceUri } from './bootstrap';
import { safeAppend } from './safeIO';

// ============================================================================
// Types
// ============================================================================

/**
 * Message types that subagents can send.
 */
export type MessageType = 'broadcast' | 'conflict' | 'request' | 'info';

/**
 * A message on the inter-agent message board.
 */
export interface AgentMessage {
    /** Unique message ID */
    id: string;
    /** Subtask ID of the sender */
    from: string;
    /** Subtask ID of the recipient, or '*' for broadcast */
    to: string;
    /** Message type */
    type: MessageType;
    /** Short subject line */
    subject: string;
    /** Message body */
    body: string;
    /** ISO timestamp */
    timestamp: string;
    /** Whether the recipient has read this message */
    read: boolean;
}

/**
 * HIVE_SIGNAL pattern parsed from subagent output.
 */
export interface HiveSignal {
    type: MessageType;
    content: string;
}

// ============================================================================
// Signal Parsing
// ============================================================================

/**
 * The instruction block to add to subagent prompts so they know how to
 * emit signals for the message bus.
 */
export const HIVE_SIGNAL_INSTRUCTION = `
=== INTER-AGENT COMMUNICATION ===
When you make a discovery, install something globally, or encounter a conflict,
emit a HIVE_SIGNAL in your output. These signals will be shared with other
parallel agents working on related tasks.

Format (place EXACTLY as shown — do NOT modify the format):
<!--HIVE_SIGNAL:broadcast:Your message here-->
<!--HIVE_SIGNAL:conflict:Modifying package.json — wait before editing-->
<!--HIVE_SIGNAL:info:Found that auth uses JWT, not sessions-->
<!--HIVE_SIGNAL:request:Need a decision on database choice — PostgreSQL or SQLite?-->

Types:
- broadcast: Global announcement (e.g., installed a package, found a pattern)
- conflict: Warning about a resource you're modifying
- info: Useful context for other agents
- request: Ask the orchestrator for a decision
`;

/**
 * Parse HIVE_SIGNAL patterns from subagent output text.
 *
 * Pattern: `<!--HIVE_SIGNAL:type:content-->`
 */
export function parseHiveSignals(text: string): HiveSignal[] {
    const signals: HiveSignal[] = [];
    const regex = /<!--HIVE_SIGNAL:(broadcast|conflict|request|info):(.+?)-->/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        signals.push({
            type: match[1] as MessageType,
            content: match[2].trim(),
        });
    }

    return signals;
}

// ============================================================================
// Message Bus
// ============================================================================

export class MessageBus {
    private messagesDir: vscode.Uri;
    private broadcastUri: vscode.Uri;
    private readSet = new Set<string>();

    constructor(sessionId: string) {
        const base = getJohannWorkspaceUri();
        if (!base) {
            throw new Error('Johann workspace not available');
        }

        this.messagesDir = vscode.Uri.joinPath(base, 'sessions', sessionId, 'messages');
        this.broadcastUri = vscode.Uri.joinPath(this.messagesDir, 'broadcast.jsonl');
    }

    /**
     * Initialize the message bus — create the messages directory.
     */
    async initialize(): Promise<boolean> {
        try {
            await vscode.workspace.fs.createDirectory(this.messagesDir);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Send a message to the message board.
     */
    async send(msg: Omit<AgentMessage, 'id' | 'timestamp' | 'read'>): Promise<void> {
        const message: AgentMessage = {
            ...msg,
            id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
            timestamp: new Date().toISOString(),
            read: false,
        };

        const line = JSON.stringify(message) + '\n';

        if (msg.to === '*') {
            // Broadcast — write to broadcast file
            await safeAppend(this.broadcastUri, line, '', false);
        } else {
            // Direct message — write to recipient's file
            const recipientUri = vscode.Uri.joinPath(this.messagesDir, `${msg.to}.jsonl`);
            await safeAppend(recipientUri, line, '', false);
        }
    }

    /**
     * Convert parsed HIVE_SIGNALs from a subagent's output into messages.
     */
    async processSignals(fromSubtaskId: string, signals: HiveSignal[]): Promise<void> {
        for (const signal of signals) {
            await this.send({
                from: fromSubtaskId,
                to: signal.type === 'request' ? 'orchestrator' : '*',
                type: signal.type,
                subject: signal.content.substring(0, 80),
                body: signal.content,
            });
        }
    }

    /**
     * Get unread messages for a subtask (includes broadcasts).
     */
    async getUnread(subtaskId: string): Promise<AgentMessage[]> {
        const messages: AgentMessage[] = [];

        // Read broadcasts
        messages.push(...(await this.readJsonl(this.broadcastUri)));

        // Read direct messages
        const directUri = vscode.Uri.joinPath(this.messagesDir, `${subtaskId}.jsonl`);
        messages.push(...(await this.readJsonl(directUri)));

        // Filter to unread only (excluding messages from the subtask itself)
        return messages.filter((m) => !this.readSet.has(m.id) && m.from !== subtaskId);
    }

    /**
     * Mark messages as read.
     */
    markRead(messageIds: string[]): void {
        for (const id of messageIds) {
            this.readSet.add(id);
        }
    }

    /**
     * Get all messages (for orchestrator monitoring).
     */
    async getAll(): Promise<AgentMessage[]> {
        const messages: AgentMessage[] = [];

        // Read broadcasts
        messages.push(...(await this.readJsonl(this.broadcastUri)));

        // Read all direct message files
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.messagesDir);
            for (const [name, type] of entries) {
                if (
                    type === vscode.FileType.File &&
                    name.endsWith('.jsonl') &&
                    name !== 'broadcast.jsonl'
                ) {
                    const uri = vscode.Uri.joinPath(this.messagesDir, name);
                    messages.push(...(await this.readJsonl(uri)));
                }
            }
        } catch {
            // Directory might not exist yet
        }

        return messages;
    }

    /**
     * Get pending requests (for orchestrator between-wave processing).
     */
    async getPendingRequests(): Promise<AgentMessage[]> {
        const all = await this.getAll();
        return all.filter((m) => m.type === 'request' && !this.readSet.has(m.id));
    }

    /**
     * Format unread messages for hive mind refresh injection.
     */
    formatForHiveMind(messages: AgentMessage[]): string {
        if (messages.length === 0) {
            return '';
        }

        const lines: string[] = ['**Messages from other agents:**'];
        for (const msg of messages) {
            const icon =
                msg.type === 'broadcast'
                    ? '📢'
                    : msg.type === 'conflict'
                      ? '⚠️'
                      : msg.type === 'request'
                        ? '❓'
                        : 'ℹ️';
            lines.push(`  ${icon} [${msg.from}] ${msg.type.toUpperCase()}: "${msg.subject}"`);
        }
        return lines.join('\n');
    }

    // ────────────────────────────────────────────────────────────────────
    // Private helpers
    // ────────────────────────────────────────────────────────────────────

    private async readJsonl(uri: vscode.Uri): Promise<AgentMessage[]> {
        try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            const text = new TextDecoder().decode(bytes);
            return text
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => {
                    try {
                        return JSON.parse(line) as AgentMessage;
                    } catch {
                        return null;
                    }
                })
                .filter((m): m is AgentMessage => m !== null);
        } catch {
            return [];
        }
    }
}
