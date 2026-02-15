import * as vscode from 'vscode';

// ============================================================================
// PROGRESS EVENTS — Structured event model for Johann orchestration progress
//
// The orchestrator emits these events instead of writing raw markdown.
// A ProgressReporter maps them to VS Code Chat response parts:
//   - PhaseChanged        → stream.progress("Phase description…")
//   - TaskStarted         → stream.progress("Working on: label…")
//   - TaskProgress        → stream.progress("label: message")
//   - TaskCompleted       → stream.markdown("✅ label — 2.3s")
//   - TaskFailed          → stream.markdown("❌ label — error")
//   - FileSetDiscovered   → stream.filetree(…) or stream.reference(…)
//   - Note                → stream.markdown("> message")
//
// This decouples orchestration logic from UI rendering, so the same events
// can drive the chat UI, a raw log, or tests.
// ============================================================================

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/**
 * Emitted when the orchestrator transitions to a new phase
 * (Planning → Executing → Synthesizing).
 * Rendered as a transient progress spinner via stream.progress().
 */
export interface PhaseEvent {
    type: 'phase';
    /** Short phase name: "Planning", "Executing", "Synthesizing Results". */
    label: string;
    /** Optional detail appended to the progress spinner. */
    detail?: string;
}

/**
 * Emitted when a subtask begins execution.
 * The reporter shows a transient progress indicator
 * and stores metadata for the completion line.
 */
export interface TaskStartedEvent {
    type: 'task-started';
    /** Unique task identifier (e.g., subtask id). */
    id: string;
    /** Human-readable label shown in progress and status lines. */
    label: string;
    /** Optional key-value pairs rendered alongside the label (model, tier, attempt). */
    metadata?: Record<string, string>;
}

/**
 * Emitted while a task is running to update the progress indicator.
 */
export interface TaskProgressEvent {
    type: 'task-progress';
    /** Task identifier. */
    id: string;
    /** Short progress message (replaces the current indicator). */
    message: string;
}

/**
 * Emitted when a subtask finishes successfully.
 * The reporter renders a permanent ✅ checklist line.
 */
export interface TaskCompletedEvent {
    type: 'task-completed';
    /** Task identifier. */
    id: string;
    /** Wall-clock duration in milliseconds. */
    durationMs?: number;
    /** One-line summary appended below the status line. */
    summary?: string;
    /** Override label if task was never formally started via TaskStartedEvent. */
    label?: string;
}

/**
 * Emitted when a subtask fails definitively.
 * The reporter renders a permanent ❌ line.
 */
export interface TaskFailedEvent {
    type: 'task-failed';
    /** Task identifier. */
    id: string;
    /** Error description shown to the user. */
    error: string;
    /** Override label if task was never formally started. */
    label?: string;
}

/**
 * Emitted when a set of files is discovered or changed.
 * The reporter renders a native file tree (ChatResponseFileTreePart)
 * or falls back to a grouped markdown list.
 */
export interface FileSetDiscoveredEvent {
    type: 'fileset-discovered';
    /** Description of the file set (e.g., "Changed files", "Conflicting files"). */
    label: string;
    /** Workspace-relative file paths. */
    files: string[];
    /** Optional base URI for the file tree (defaults to first workspace folder). */
    baseUri?: string;
}

/**
 * Emitted for informational / warning / success messages
 * that are not tied to a specific task lifecycle.
 */
export interface NoteEvent {
    type: 'note';
    /** Markdown-safe message text. */
    message: string;
    /** Visual style: info (default), warning (⚠️), or success (✅). */
    style?: 'info' | 'warning' | 'success';
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

/**
 * All progress events that can be emitted by the orchestrator.
 */
export type ProgressEvent =
    | PhaseEvent
    | TaskStartedEvent
    | TaskProgressEvent
    | TaskCompletedEvent
    | TaskFailedEvent
    | FileSetDiscoveredEvent
    | NoteEvent;

// ---------------------------------------------------------------------------
// Reporter interface
// ---------------------------------------------------------------------------

/**
 * A consumer of ProgressEvents that maps them to some output target.
 *
 * The primary implementation is ChatProgressReporter which renders events
 * to a VS Code ChatResponseStream. BackgroundProgressReporter sends updates
 * to BackgroundTaskManager for asynchronous execution.
 */
export interface ProgressReporter {
    /** Dispatch a structured progress event. */
    emit(event: ProgressEvent): void;

    /** Convenience: emit a phase transition as a transient progress spinner. */
    phase(label: string, detail?: string): void;

    /**
     * Access the underlying chat response stream for raw writes (e.g., LLM output streaming).
     * Only available in synchronous (chat) mode. Background reporters throw an error if accessed.
     */
    readonly stream?: vscode.ChatResponseStream;
}
