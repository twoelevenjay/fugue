import * as vscode from 'vscode';
import { MemoryEntry, OrchestratorConfig, DEFAULT_CONFIG } from './types';

// ============================================================================
// PERSISTENT MEMORY — .vscode/johann/ directory
//
// Stores timestamped memory files for:
// - Task history and results
// - Decisions made and why
// - Learnings (what worked, what didn't)
// - Project context accumulated over sessions
// - Error patterns
//
// Strict rules:
// - All files are timestamped
// - Memory is detailed and extensive
// - Periodic cleanup removes old low-value entries
// ============================================================================

export class MemorySystem {
    private memoryDir: string;
    private config: OrchestratorConfig;

    constructor(config: OrchestratorConfig = DEFAULT_CONFIG) {
        this.config = config;
        this.memoryDir = config.memoryDir;
    }

    /**
     * Ensure the memory directory exists.
     */
    async ensureMemoryDir(): Promise<vscode.Uri | undefined> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }

        const rootUri = workspaceFolders[0].uri;
        const memoryUri = vscode.Uri.joinPath(rootUri, this.memoryDir);

        try {
            await vscode.workspace.fs.createDirectory(memoryUri);
        } catch {
            // Directory may already exist
        }

        return memoryUri;
    }

    /**
     * Get the memory directory URI.
     */
    private getMemoryUri(): vscode.Uri | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return undefined;
        }
        return vscode.Uri.joinPath(workspaceFolders[0].uri, this.memoryDir);
    }

    /**
     * Generate a timestamped filename.
     */
    private generateFilename(category: string, title: string): string {
        const now = new Date();
        const ts = now.toISOString().replace(/[:.]/g, '-');
        const slug = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 50);
        return `${ts}_${category}_${slug}.md`;
    }

    /**
     * Write a memory entry to disk.
     */
    async writeMemory(entry: MemoryEntry): Promise<void> {
        const memDir = await this.ensureMemoryDir();
        if (!memDir) {
            return;
        }

        const filename = this.generateFilename(entry.category, entry.title);
        const fileUri = vscode.Uri.joinPath(memDir, filename);

        const content = this.formatMemoryEntry(entry);
        const encoder = new TextEncoder();
        await vscode.workspace.fs.writeFile(fileUri, encoder.encode(content));
    }

    /**
     * Format a memory entry as Markdown.
     */
    private formatMemoryEntry(entry: MemoryEntry): string {
        const lines: string[] = [];
        lines.push(`# ${entry.title}`);
        lines.push('');
        lines.push(`**Timestamp:** ${entry.timestamp}`);
        lines.push(`**Category:** ${entry.category}`);
        if (entry.tags.length > 0) {
            lines.push(`**Tags:** ${entry.tags.join(', ')}`);
        }
        if (entry.relatedSubtasks && entry.relatedSubtasks.length > 0) {
            lines.push(`**Related Subtasks:** ${entry.relatedSubtasks.join(', ')}`);
        }
        lines.push('');
        lines.push('---');
        lines.push('');
        lines.push(entry.content);
        lines.push('');
        return lines.join('\n');
    }

    /**
     * Read all memory entries from disk, sorted by timestamp (newest first).
     */
    async readAllMemory(): Promise<Array<{ filename: string; content: string }>> {
        const memDir = this.getMemoryUri();
        if (!memDir) {
            return [];
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(memDir);
            const results: Array<{ filename: string; content: string }> = [];

            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.md')) {
                    const fileUri = vscode.Uri.joinPath(memDir, name);
                    const contentBytes = await vscode.workspace.fs.readFile(fileUri);
                    const content = new TextDecoder().decode(contentBytes);
                    results.push({ filename: name, content });
                }
            }

            // Sort by filename (which starts with timestamp) — newest first
            results.sort((a, b) => b.filename.localeCompare(a.filename));
            return results;
        } catch {
            return [];
        }
    }

    /**
     * Get recent memory as a context string for the orchestrator.
     * Limits to the most recent N entries to keep context manageable.
     */
    async getRecentMemoryContext(
        maxEntries: number = 10,
        maxChars: number = 5000,
    ): Promise<string> {
        const memories = await this.readAllMemory();
        if (memories.length === 0) {
            return '';
        }

        const lines: string[] = ['=== JOHANN MEMORY (Recent) ===', ''];
        let totalChars = 0;

        for (const mem of memories.slice(0, maxEntries)) {
            if (totalChars + mem.content.length > maxChars) {
                break;
            }
            lines.push(`--- ${mem.filename} ---`);
            lines.push(mem.content);
            lines.push('');
            totalChars += mem.content.length;
        }

        return lines.join('\n');
    }

    /**
     * Record a task completion to memory.
     */
    async recordTaskCompletion(
        taskSummary: string,
        subtaskResults: Array<{ title: string; model: string; success: boolean; notes: string }>,
        overallSuccess: boolean,
    ): Promise<void> {
        const content: string[] = [];
        content.push(`## Overall: ${overallSuccess ? 'SUCCESS' : 'FAILED'}`);
        content.push('');
        content.push(`### Task: ${taskSummary}`);
        content.push('');
        content.push('### Subtask Results:');
        for (const result of subtaskResults) {
            content.push(
                `- **${result.title}** — Model: ${result.model}, ${result.success ? 'OK' : 'FAILED'}`,
            );
            if (result.notes) {
                content.push(`  - Notes: ${result.notes}`);
            }
        }

        await this.writeMemory({
            timestamp: new Date().toISOString(),
            category: 'task',
            title: `Task: ${taskSummary.substring(0, 80)}`,
            content: content.join('\n'),
            tags: ['task-completion', overallSuccess ? 'success' : 'failure'],
            relatedSubtasks: subtaskResults.map((_, i) => `subtask-${i}`),
        });
    }

    /**
     * Record a decision to memory.
     */
    async recordDecision(
        decision: string,
        reasoning: string,
        alternatives: string[] = [],
    ): Promise<void> {
        const content: string[] = [];
        content.push(`## Decision: ${decision}`);
        content.push('');
        content.push(`### Reasoning:`);
        content.push(reasoning);
        if (alternatives.length > 0) {
            content.push('');
            content.push('### Alternatives Considered:');
            for (const alt of alternatives) {
                content.push(`- ${alt}`);
            }
        }

        await this.writeMemory({
            timestamp: new Date().toISOString(),
            category: 'decision',
            title: `Decision: ${decision.substring(0, 80)}`,
            content: content.join('\n'),
            tags: ['decision'],
        });
    }

    /**
     * Record a learning to memory.
     */
    async recordLearning(what: string, details: string, tags: string[] = []): Promise<void> {
        await this.writeMemory({
            timestamp: new Date().toISOString(),
            category: 'learning',
            title: `Learning: ${what.substring(0, 80)}`,
            content: `## ${what}\n\n${details}`,
            tags: ['learning', ...tags],
        });
    }

    /**
     * Record an error to memory.
     */
    async recordError(error: string, context: string, resolution?: string): Promise<void> {
        const content: string[] = [];
        content.push(`## Error: ${error}`);
        content.push('');
        content.push(`### Context:`);
        content.push(context);
        if (resolution) {
            content.push('');
            content.push(`### Resolution:`);
            content.push(resolution);
        }

        await this.writeMemory({
            timestamp: new Date().toISOString(),
            category: 'error',
            title: `Error: ${error.substring(0, 80)}`,
            content: content.join('\n'),
            tags: ['error'],
        });
    }

    /**
     * Clear all memory files.
     */
    async clearMemory(): Promise<number> {
        const memDir = this.getMemoryUri();
        if (!memDir) {
            return 0;
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(memDir);
            let count = 0;
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.md')) {
                    await vscode.workspace.fs.delete(vscode.Uri.joinPath(memDir, name));
                    count++;
                }
            }
            return count;
        } catch {
            return 0;
        }
    }

    /**
     * List all memory files with basic info.
     */
    async listMemory(): Promise<string[]> {
        const memDir = this.getMemoryUri();
        if (!memDir) {
            return [];
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(memDir);
            return entries
                .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
                .map(([name]) => name)
                .sort()
                .reverse();
        } catch {
            return [];
        }
    }
}
