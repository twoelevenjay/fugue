import * as vscode from 'vscode';
import * as path from 'path';
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
        if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

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
        if (!workspaceFolders || workspaceFolders.length === 0) return undefined;
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
        if (!memDir) return;

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
        if (!memDir) return [];

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
    async getRecentMemoryContext(maxEntries: number = 10, maxChars: number = 5000): Promise<string> {
        const memories = await this.readAllMemory();
        if (memories.length === 0) return '';

        const lines: string[] = ['=== JOHANN MEMORY (Recent) ===', ''];
        let totalChars = 0;

        for (const mem of memories.slice(0, maxEntries)) {
            if (totalChars + mem.content.length > maxChars) break;
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
        overallSuccess: boolean
    ): Promise<void> {
        const content: string[] = [];
        content.push(`## Overall: ${overallSuccess ? 'SUCCESS' : 'FAILED'}`);
        content.push('');
        content.push(`### Task: ${taskSummary}`);
        content.push('');
        content.push('### Subtask Results:');
        for (const result of subtaskResults) {
            content.push(`- **${result.title}** — Model: ${result.model}, ${result.success ? 'OK' : 'FAILED'}`);
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
        alternatives: string[] = []
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
    async recordLearning(
        what: string,
        details: string,
        tags: string[] = []
    ): Promise<void> {
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
    async recordError(
        error: string,
        context: string,
        resolution?: string
    ): Promise<void> {
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
        if (!memDir) return 0;

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
        if (!memDir) return [];

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

// === Memory Hardening & Self-Reflection Additions ===
// Imports are local to this appended block to avoid interfering with existing module scope.
import * as fs from 'fs';

/** Result of validating Johann memory files. */
export interface ValidationResult {
  valid: boolean;
  issues: { file: string; issue: string; autoFixed: boolean }[];
}

/** A single memory search match result. */
export interface MemorySearchResult {
  source: string; // file path
  section: string; // section header
  content: string; // matching content
  relevance: number; // 0-1 score
}

/** Result of processing heartbeat checks. */
export interface HeartbeatResult {
  checkedItems: string[];
  needsAttention: string[];
  summary: string;
}

/** Utility: get Johann memory directory path. */
function getJohannDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.vscode', 'johann');
}

/** Utility: get daily note path for a date. */
function getDailyNotePath(workspaceRoot: string, d = new Date()): string {
  const dir = path.join(getJohannDir(workspaceRoot), 'memory');
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return path.join(dir, `${yyyy}-${mm}-${dd}.md`);
}

/** Utility: safe mkdir -p. */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/** Utility: read file text if exists, else ''. */
function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Utility: write text to file, creating parent dir if needed. */
function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

/** Utility: append text to file with trailing newline. */
function appendText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, content.endsWith('\n') ? content : content + '\n', 'utf8');
}

/** Expected memory files and minimal header titles. */
const EXPECTED_FILES: { name: string; header: string }[] = [
  { name: 'MEMORY.md', header: '# Memory' },
  { name: 'SOUL.md', header: '# Soul' },
  { name: 'IDENTITY.md', header: '# Identity' },
  { name: 'USER.md', header: '# User' },
  { name: 'AGENTS.md', header: '# Agents' },
  { name: 'TOOLS.md', header: '# Tools' },
  { name: 'HEARTBEAT.md', header: '# Heartbeat' },
];

/** Validate Johann memory files, auto-fixing missing directories and stub headers when possible. */
export function validateMemoryFiles(workspaceRoot: string): ValidationResult {
  const johannDir = getJohannDir(workspaceRoot);
  const issues: ValidationResult['issues'] = [];

  // Ensure base directories exist
  if (!fs.existsSync(johannDir)) {
    ensureDir(johannDir);
    issues.push({ file: johannDir, issue: 'Missing memory directory', autoFixed: true });
  }

  const memoryDir = path.join(johannDir, 'memory');
  if (!fs.existsSync(memoryDir)) {
    ensureDir(memoryDir);
    issues.push({ file: memoryDir, issue: 'Missing memory subdirectory', autoFixed: true });
  }

  // Validate expected files
  for (const { name, header } of EXPECTED_FILES) {
    const fp = path.join(johannDir, name);
    if (!fs.existsSync(fp)) {
      writeText(fp, `${header}\n\n> Auto-created by Johann to initialize persistent memory.\n`);
      issues.push({ file: fp, issue: 'Missing file', autoFixed: true });
      continue;
    }
    const text = readText(fp).trim();
    if (text.length === 0) {
      writeText(fp, `${header}\n\n> Initialized empty file.\n`);
      issues.push({ file: fp, issue: 'Empty markdown', autoFixed: true });
      continue;
    }
    const hasHeader = text.startsWith(header) || text.includes(`\n${header}\n`);
    if (!hasHeader) {
      // Prepend header if missing
      writeText(fp, `${header}\n\n${text}`);
      issues.push({ file: fp, issue: 'Missing expected header', autoFixed: true });
    }
  }

  // Validate that daily note contains at least a top-level header
  const todayNote = getDailyNotePath(workspaceRoot);
  if (!fs.existsSync(todayNote)) {
    writeText(todayNote, `# Daily Notes ${new Date().toISOString().slice(0, 10)}\n`);
    issues.push({ file: todayNote, issue: 'Missing today daily note', autoFixed: true });
  } else {
    const t = readText(todayNote);
    if (!/^#\s/.test(t)) {
      writeText(todayNote, `# Daily Notes ${new Date().toISOString().slice(0, 10)}\n\n${t}`);
      issues.push({ file: todayNote, issue: 'Daily note missing header', autoFixed: true });
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Split markdown into sections by h2/h3 headings. */
function splitSections(md: string): { header: string; content: string }[] {
  const lines = md.split(/\r?\n/);
  const sections: { header: string; content: string }[] = [];
  let currentHeader = 'ROOT';
  let buffer: string[] = [];
  const flush = () => {
    sections.push({ header: currentHeader, content: buffer.join('\n').trim() });
    buffer = [];
  };
  for (const line of lines) {
    if (/^#{2,3}\s+/.test(line)) {
      flush();
      currentHeader = line.replace(/^#{2,3}\s+/, '').trim();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return sections.filter(s => s.content.length > 0);
}

/** Tokenize a query string into lowercase keywords. */
function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Simple relevance score: fraction of query tokens present in content. */
function relevance(content: string, qTokens: string[]): number {
  if (qTokens.length === 0) return 0;
  const lc = content.toLowerCase();
  let hits = 0;
  for (const t of qTokens) {
    if (lc.includes(t)) hits++;
  }
  return Math.min(1, hits / qTokens.length);
}

/** Read daily notes within last N days present in memory folder. */
function readRecentDailyNotes(workspaceRoot: string, days: number): { file: string; text: string }[] {
  const memoryDir = path.join(getJohannDir(workspaceRoot), 'memory');
  const results: { file: string; text: string }[] = [];
  if (!fs.existsSync(memoryDir)) return results;
  const files = fs.readdirSync(memoryDir).filter(f => /\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  for (const f of files) {
    const [yyyy, mm, dd] = f.replace('.md', '').split('-').map(n => parseInt(n, 10));
    const dt = new Date(yyyy, mm - 1, dd);
    if (dt >= cutoff) {
      const fp = path.join(memoryDir, f);
      results.push({ file: fp, text: readText(fp) });
    }
  }
  return results;
}

/** Search MEMORY.md and recent daily notes (last 7 days) for keyword matches, returning matching sections. */
export function searchMemory(workspaceRoot: string, query: string): MemorySearchResult[] {
  const johannDir = getJohannDir(workspaceRoot);
  const qTokens = tokenize(query);
  const results: MemorySearchResult[] = [];

  const memoryFile = path.join(johannDir, 'MEMORY.md');
  if (fs.existsSync(memoryFile)) {
    const text = readText(memoryFile);
    for (const s of splitSections(text)) {
      const rel = relevance(s.content, qTokens);
      if (rel > 0) {
        results.push({ source: memoryFile, section: s.header, content: s.content, relevance: rel });
      }
    }
  }

  for (const note of readRecentDailyNotes(workspaceRoot, 7)) {
    for (const s of splitSections(note.text)) {
      const rel = relevance(s.content, qTokens);
      if (rel > 0) {
        results.push({ source: note.file, section: s.header, content: s.content, relevance: rel });
      }
    }
  }

  // Sort by relevance descending then by source name
  results.sort((a, b) => b.relevance - a.relevance || a.source.localeCompare(b.source));
  return results;
}

/** Write a timestamped reflection entry to today's daily note, and elevate key learnings to MEMORY.md. */
export function writeReflection(workspaceRoot: string, reflection: string): void {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const stamp = `${hh}:${mm}:${ss}`;
  const todayNote = getDailyNotePath(workspaceRoot, now);

  if (!fs.existsSync(todayNote)) {
    writeText(todayNote, `# Daily Notes ${now.toISOString().slice(0, 10)}\n`);
  }

  appendText(todayNote, `\n### ${stamp} — [reflection]`);
  appendText(todayNote, reflection.trim());

  // Elevate key learnings
  const keyWords = ['learned', 'discovered', 'important', 'remember'];
  const lc = reflection.toLowerCase();
  const isKey = keyWords.some(k => lc.includes(k));
  if (isKey) {
    const memoryFile = path.join(getJohannDir(workspaceRoot), 'MEMORY.md');
    let text = readText(memoryFile);
    if (!text) {
      text = '# Memory\n\n';
    }
    // Ensure a Reflections section exists
    if (!/\n##\s+Reflections\s*/.test(text)) {
      text += '\n## Reflections\n';
    }
    // Append under Reflections
    const entry = `\n### ${now.toISOString()}\n${reflection.trim()}\n`;
    if (text.endsWith('\n')) {
      text += entry;
    } else {
      text += '\n' + entry;
    }
    writeText(memoryFile, text);
  }
}

/** Process HEARTBEAT.md recurring checks and summarize recent notes. */
export function processHeartbeat(workspaceRoot: string): HeartbeatResult {
  const heartbeatFile = path.join(getJohannDir(workspaceRoot), 'HEARTBEAT.md');
  const text = readText(heartbeatFile);
  const unchecked: string[] = [];
  const checked: string[] = [];

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[( |x)\]\s*(.+)$/i);
    if (m) {
      const isChecked = m[1].toLowerCase() === 'x';
      const item = m[2].trim();
      if (!isChecked) unchecked.push(item); else checked.push(item);
    }
  }

  const attention: string[] = [];
  const performed: string[] = [];
  const summaries: string[] = [];

  for (const item of unchecked) {
    const lower = item.toLowerCase();
    if (lower.includes('review recent daily notes')) {
      const notes = readRecentDailyNotes(workspaceRoot, 3);
      const bulletPoints: string[] = [];
      for (const n of notes) {
        const secs = splitSections(n.text);
        const firstThree = secs.filter(s => s.header !== 'ROOT').slice(0, 3);
        for (const s of firstThree) {
          const firstLine = s.content.split(/\r?\n/)[0];
          bulletPoints.push(`- ${s.header}: ${firstLine}`);
        }
      }
      if (bulletPoints.length > 0) {
        summaries.push(`Recent notes summary:\n${bulletPoints.join('\n')}`);
        performed.push(item);
      } else {
        attention.push(item);
      }
    } else {
      // Not auto-processable; flag for attention
      attention.push(item);
    }
  }

  const summaryText = summaries.length > 0 ? summaries.join('\n\n') : 'No auto-processed heartbeat items.';
  return { checkedItems: performed, needsAttention: attention, summary: summaryText };
}

/** Trim MEMORY.md when exceeding maxSizeKB by archiving oldest reflection sections. */
export function trimMemory(workspaceRoot: string, maxSizeKB = 50): void {
  const johannDir = getJohannDir(workspaceRoot);
  const memoryFile = path.join(johannDir, 'MEMORY.md');
  if (!fs.existsSync(memoryFile)) return;

  const buf = fs.readFileSync(memoryFile);
  const sizeKB = Math.ceil(buf.length / 1024);
  if (sizeKB <= maxSizeKB) return;

  const md = buf.toString('utf8');
  const sections = md.split(/\n(?=###\s+)/); // split by reflection-level headings primarily
  if (sections.length < 2) return; // nothing to trim safely

  // Archive oldest quarter of sections
  const toArchiveCount = Math.max(1, Math.floor(sections.length * 0.25));
  const toArchive = sections.slice(0, toArchiveCount).join('\n');
  const remaining = sections.slice(toArchiveCount).join('\n');

  const now = new Date();
  const archiveDir = path.join(johannDir, 'memory', 'archive');
  ensureDir(archiveDir);
  const archiveFile = path.join(archiveDir, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.md`);
  const archiveHeader = fs.existsSync(archiveFile) ? '' : `# Memory Archive ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}\n\n`;
  appendText(archiveFile, archiveHeader + toArchive.trim() + '\n');

  writeText(memoryFile, remaining.trim() + '\n');
}
