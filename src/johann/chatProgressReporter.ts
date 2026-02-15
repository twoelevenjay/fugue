import * as vscode from 'vscode';
import { OrchestrationPlan } from './types';
import {
    ProgressEvent,
    ProgressReporter,
    PhaseEvent,
    TaskStartedEvent,
    TaskProgressEvent,
    TaskCompletedEvent,
    TaskFailedEvent,
    FileSetDiscoveredEvent,
    NoteEvent,
} from './progressEvents';

// ============================================================================
// CHAT PROGRESS REPORTER — Native Copilot-like UX for Johann
//
// Maps structured ProgressEvents to VS Code ChatResponseStream primitives
// so the user sees a progress experience identical to Copilot's own agent:
//
//   Phase          → stream.progress("Planning…")      (transient spinner)
//   TaskStarted    → stream.progress("Working on: …")  (transient spinner)
//   TaskProgress   → stream.progress("…: message")     (transient spinner)
//   TaskCompleted  → stream.markdown("✅ **label**…")  (permanent line)
//   TaskFailed     → stream.markdown("❌ **label**…")  (permanent line)
//   FileSet        → stream.filetree(…)                (native file tree)
//   Note           → stream.markdown("> message")      (callout block)
//   Buttons        → stream.button(…)                  (native action buttons)
//
// Raw stream access is available via .stream for sub-methods that need
// to stream LLM output directly.
// ============================================================================

/** Internal state for a tracked task. */
interface TrackedTask {
    label: string;
    metadata?: Record<string, string>;
    startTime: number;
}

/**
 * ChatProgressReporter — renders Johann orchestration progress as
 * native-feeling VS Code Chat UI elements.
 */
export class ChatProgressReporter implements ProgressReporter {
    private readonly _stream: vscode.ChatResponseStream;
    private readonly tasks = new Map<string, TrackedTask>();
    private _debugLogUri?: vscode.Uri;
    private _totalSubtasks = 0;
    private _completedSubtasks = 0;
    private _failedSubtasks = 0;

    constructor(stream: vscode.ChatResponseStream) {
        this._stream = stream;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * The underlying ChatResponseStream for raw writes.
     * Always available in synchronous (chat) mode.
     */
    get stream(): vscode.ChatResponseStream {
        return this._stream;
    }

    /**
     * Store the debug log URI so it can be passed to the
     * "Open Debug Log" button.
     */
    setDebugLogUri(uri: vscode.Uri | undefined): void {
        this._debugLogUri = uri;
    }

    /**
     * Dispatch a structured progress event.
     * Each event type is mapped to appropriate chat response parts.
     */
    emit(event: ProgressEvent): void {
        switch (event.type) {
            case 'phase':
                this.onPhase(event);
                break;
            case 'task-started':
                this.onTaskStarted(event);
                break;
            case 'task-progress':
                this.onTaskProgress(event);
                break;
            case 'task-completed':
                this.onTaskCompleted(event);
                break;
            case 'task-failed':
                this.onTaskFailed(event);
                break;
            case 'fileset-discovered':
                this.onFileSetDiscovered(event);
                break;
            case 'note':
                this.onNote(event);
                break;
        }
    }

    /**
     * Convenience: emit a phase transition as a transient progress spinner.
     * Equivalent to emit({ type: 'phase', label, detail }).
     */
    phase(label: string, detail?: string): void {
        this.emit({ type: 'phase', label, detail });
    }

    // -----------------------------------------------------------------------
    // Convenience rendering methods
    // -----------------------------------------------------------------------

    /**
     * Render a compact plan summary with a subtask table.
     */
    showPlan(plan: OrchestrationPlan): void {
        this._totalSubtasks = plan.subtasks.length;
        this._completedSubtasks = 0;
        this._failedSubtasks = 0;

        const lines: string[] = [];

        lines.push(`**${plan.summary}**\n`);
        lines.push(
            `${plan.strategy} · ` +
            `${plan.overallComplexity} complexity · ` +
            `${plan.subtasks.length} subtask${plan.subtasks.length !== 1 ? 's' : ''}\n`
        );

        if (plan.subtasks.length > 1) {
            lines.push('| # | Task | Complexity | Deps |');
            lines.push('|---|------|-----------|------|');
            for (const st of plan.subtasks) {
                const deps = st.dependsOn.length > 0 ? st.dependsOn.join(', ') : '—';
                lines.push(`| ${st.id} | ${st.title} | ${st.complexity} | ${deps} |`);
            }
            lines.push('');
        }

        if (plan.successCriteria.length > 0) {
            lines.push('<details><summary>Success criteria</summary>\n');
            for (const sc of plan.successCriteria) {
                lines.push(`- ${sc}`);
            }
            lines.push('\n</details>\n');
        }

        this._stream.markdown(lines.join('\n') + '\n');
    }

    /**
     * Render an expandable block listing available models.
     */
    showModels(modelSummary: string): void {
        this._stream.markdown(
            `<details><summary>Available models</summary>\n\n` +
            `\`\`\`\n${modelSummary}\n\`\`\`\n\n</details>\n\n`
        );
    }

    /**
     * Render action buttons at the end of the response.
     * Uses native stream.button() for Copilot-like UX.
     */
    showButtons(): void {
        this._stream.button({
            command: 'workbench.view.scm',
            title: '$(git-compare) Changed Files',
        });

        this._stream.button({
            command: 'johann.showLog',
            title: '$(output) Output Log',
        });

        if (this._debugLogUri) {
            this._stream.button({
                command: 'johann.showDebugLog',
                title: '$(debug-console) Debug Log',
                arguments: [this._debugLogUri],
            });
        }

        this._stream.button({
            command: 'johann.showMemory',
            title: '$(database) Memory',
        });
    }

    // -----------------------------------------------------------------------
    // Event handlers — map each event to chat response parts
    // -----------------------------------------------------------------------

    /**
     * Phase → transient progress spinner. No permanent markdown.
     */
    private onPhase(event: PhaseEvent): void {
        const msg = event.detail
            ? `${event.label} — ${event.detail}`
            : `${event.label}…`;
        this._stream.progress(msg);
    }

    /**
     * TaskStarted → store task state + show transient progress spinner.
     */
    private onTaskStarted(event: TaskStartedEvent): void {
        this.tasks.set(event.id, {
            label: event.label,
            metadata: event.metadata,
            startTime: Date.now(),
        });

        const progressCtx = this._totalSubtasks > 0
            ? ` (${this._completedSubtasks + this._failedSubtasks + 1}/${this._totalSubtasks})`
            : '';

        this._stream.progress(`${this.formatProgressMessage(event)}${progressCtx}`);
    }

    /**
     * TaskProgress → update the transient progress spinner.
     */
    private onTaskProgress(event: TaskProgressEvent): void {
        const task = this.tasks.get(event.id);
        const prefix = task ? task.label : event.id;
        this._stream.progress(`${prefix}: ${event.message}`);
    }

    /**
     * TaskCompleted → permanent ✅ checklist line.
     */
    private onTaskCompleted(event: TaskCompletedEvent): void {
        const task = this.tasks.get(event.id);
        const label = event.label || task?.label || event.id;
        const model = task?.metadata?.model;

        this._completedSubtasks++;

        let line = `✅ **${label}**`;
        if (model) {
            line += ` · \`${model}\``;
        }
        if (event.durationMs !== undefined) {
            line += ` · ${this.formatDuration(event.durationMs)}`;
        }
        line += '\n';
        if (event.summary) {
            line += `> ${event.summary}\n`;
        }

        this._stream.markdown(line + '\n');
        this.tasks.delete(event.id);
    }

    /**
     * TaskFailed → permanent ❌ line.
     */
    private onTaskFailed(event: TaskFailedEvent): void {
        const task = this.tasks.get(event.id);
        const label = event.label || task?.label || event.id;

        this._failedSubtasks++;

        this._stream.markdown(`❌ **${label}** — ${event.error}\n\n`);
        this.tasks.delete(event.id);
    }

    /**
     * FileSetDiscovered → native file tree or individual references.
     */
    private onFileSetDiscovered(event: FileSetDiscoveredEvent): void {
        if (event.files.length === 0) {
            return;
        }

        const baseUri = event.baseUri
            ? vscode.Uri.file(event.baseUri)
            : vscode.workspace.workspaceFolders?.[0]?.uri;

        // Use stream.reference() for small file sets — renders inline anchors
        if (event.files.length <= 5 && baseUri) {
            this._stream.markdown(`**${event.label}:** `);
            for (let i = 0; i < event.files.length; i++) {
                const fileUri = vscode.Uri.joinPath(baseUri, event.files[i]);
                this._stream.reference(fileUri);
                if (i < event.files.length - 1) {
                    this._stream.markdown(' ');
                }
            }
            this._stream.markdown('\n\n');
            return;
        }

        // Use stream.filetree() for larger sets — renders a collapsible tree
        if (baseUri) {
            try {
                this._stream.markdown(`**${event.label}**\n\n`);
                const tree = buildFileTree(event.files);
                this._stream.filetree(tree, baseUri);
                return;
            } catch {
                // Fall through to markdown
            }
        }

        // Fallback: grouped markdown list
        this._stream.markdown(this.formatFileListMarkdown(event.label, event.files));
    }

    /**
     * Note → quoted markdown block with optional style.
     */
    private onNote(event: NoteEvent): void {
        switch (event.style) {
            case 'warning':
                this._stream.markdown(`> ⚠️ ${event.message}\n\n`);
                break;
            case 'success':
                this._stream.markdown(`> ✅ ${event.message}\n\n`);
                break;
            default:
                this._stream.markdown(`> ${event.message}\n\n`);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // Formatting helpers
    // -----------------------------------------------------------------------

    /**
     * Build a progress indicator string from a TaskStartedEvent.
     * Includes model name and attempt number when available.
     */
    private formatProgressMessage(event: TaskStartedEvent): string {
        let msg = event.label;
        const model = event.metadata?.model;
        const attempt = event.metadata?.attempt;

        if (model) {
            msg += ` → ${model}`;
        }
        if (attempt) {
            msg += ` [attempt ${attempt}]`;
        }

        return msg;
    }

    /**
     * Format a duration for display. Uses compact human-readable form.
     */
    private formatDuration(ms: number): string {
        if (ms < 1000) {
            return `${ms}ms`;
        }
        if (ms < 60_000) {
            return `${(ms / 1000).toFixed(1)}s`;
        }
        const mins = Math.floor(ms / 60_000);
        const secs = Math.round((ms % 60_000) / 1000);
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }

    /**
     * Format a file list as grouped markdown when native file tree
     * is not available.
     */
    private formatFileListMarkdown(label: string, files: string[]): string {
        const byDir = new Map<string, string[]>();
        for (const file of files) {
            const parts = file.split('/');
            const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
            const name = parts[parts.length - 1];
            if (!byDir.has(dir)) {
                byDir.set(dir, []);
            }
            byDir.get(dir)!.push(name);
        }

        const lines = [`**${label}**\n`];
        for (const [dir, names] of byDir) {
            lines.push(`\`${dir}/\``);
            for (const name of names) {
                lines.push(`  - ${name}`);
            }
        }
        lines.push('');
        return lines.join('\n');
    }
}

// ============================================================================
// FILE TREE BUILDER
// ============================================================================

/**
 * Convert flat workspace-relative file paths into a ChatResponseFileTree
 * hierarchy suitable for stream.filetree().
 */
export function buildFileTree(files: string[]): vscode.ChatResponseFileTree[] {
    const root: vscode.ChatResponseFileTree[] = [];

    for (const filePath of files) {
        const parts = filePath.split('/').filter(Boolean);
        let current = root;

        for (let i = 0; i < parts.length; i++) {
            const name = parts[i];
            const isLast = i === parts.length - 1;

            let found = current.find(n => n.name === name);
            if (!found) {
                found = { name };
                if (!isLast) {
                    found.children = [];
                }
                current.push(found);
            }

            if (!isLast) {
                if (!found.children) {
                    found.children = [];
                }
                current = found.children;
            }
        }
    }

    return root;
}
