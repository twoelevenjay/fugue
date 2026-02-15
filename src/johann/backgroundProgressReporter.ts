import * as vscode from 'vscode';
import {
    ProgressEvent,
    PhaseEvent,
    TaskStartedEvent,
    TaskProgressEvent,
    TaskCompletedEvent,
    TaskFailedEvent,
    FileSetDiscoveredEvent,
    NoteEvent,
} from './progressEvents';
import { BackgroundTaskManager } from './backgroundTaskManager';

// ============================================================================
// BACKGROUND PROGRESS REPORTER — Maps progress events to background task updates
//
// Instead of streaming to the chat UI, this reporter sends updates to the
// BackgroundTaskManager which:
// - Updates the status bar with current progress
// - Persists task state to disk
// - Shows notifications on completion/failure
// - Maintains a task history for user review
//
// This allows long-running orchestrations to execute without blocking the
// chat interface.
// ============================================================================

/** Internal state for a tracked task. */
interface TrackedTask {
    label: string;
    metadata?: Record<string, string>;
    startTime: number;
}

/**
 * BackgroundProgressReporter — renders Johann orchestration progress
 * as background task updates.
 */
export class BackgroundProgressReporter {
    private readonly taskId: string;
    private readonly tasks = new Map<string, TrackedTask>();
    private _totalSubtasks = 0;
    private _completedSubtasks = 0;
    private _failedSubtasks = 0;
    private _currentPhase = 'Starting';
    private readonly notes: string[] = [];
    private readonly discoveredFiles: string[] = [];

    constructor(taskId: string) {
        this.taskId = taskId;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * The underlying stream property is not available in background mode.
     * This throws an error if accessed, as background tasks should not
     * attempt to stream to the chat UI.
     */
    get stream(): vscode.ChatResponseStream {
        throw new Error(
            'ChatResponseStream not available in background mode. ' +
            'Use ChatProgressReporter for synchronous execution.'
        );
    }

    /**
     * Dispatch a structured progress event.
     * Each event type is mapped to appropriate background task updates.
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
     * Convenience: emit a phase transition.
     * Equivalent to emit({ type: 'phase', label, detail }).
     */
    phase(label: string, detail?: string): void {
        this.emit({ type: 'phase', label, detail });
    }

    /**
     * Set the total number of subtasks for progress calculation.
     */
    setTotalSubtasks(count: number): void {
        this._totalSubtasks = count;
        this.updateProgress();
    }

    /**
     * Show buttons — no-op in background mode.
     * Buttons are only relevant in chat UI.
     */
    showButtons(): void {
        // No-op in background mode
    }

    /**
     * Show plan — collect for summary.
     */
    showPlan(plan: any): void {
        this.notes.push(`📋 Plan: ${plan.summary} (${plan.subtasks.length} subtasks)`);
        this._totalSubtasks = plan.subtasks.length;
        this.updateProgress();
    }

    /**
     * Show models — collect for summary.
     */
    showModels(modelSummary: string): void {
        // Store model summary for debugging if needed
        // No UI display in background mode
    }

    /**
     * Get collected notes and discovered files for final summary.
     */
    getSummary(): {
        notes: string[];
        discoveredFiles: string[];
        completedSubtasks: number;
        failedSubtasks: number;
        totalSubtasks: number;
    } {
        return {
            notes: [...this.notes],
            discoveredFiles: [...this.discoveredFiles],
            completedSubtasks: this._completedSubtasks,
            failedSubtasks: this._failedSubtasks,
            totalSubtasks: this._totalSubtasks,
        };
    }

    // -----------------------------------------------------------------------
    // Event handlers — map each event to background task updates
    // -----------------------------------------------------------------------

    /**
     * Phase → update current phase and progress.
     */
    private onPhase(event: PhaseEvent): void {
        this._currentPhase = event.detail
            ? `${event.label} — ${event.detail}`
            : event.label;
        this.updateProgress();
    }

    /**
     * TaskStarted → store task state + update progress with current task.
     */
    private onTaskStarted(event: TaskStartedEvent): void {
        this.tasks.set(event.id, {
            label: event.label,
            metadata: event.metadata,
            startTime: Date.now(),
        });

        // Update progress with current task information
        this.updateProgress(event.label);
    }

    /**
     * TaskProgress → update progress message with task's progress.
     */
    private onTaskProgress(event: TaskProgressEvent): void {
        const task = this.tasks.get(event.id);
        const prefix = task ? task.label : event.id;
        this.updateProgress(`${prefix}: ${event.message}`);
    }

    /**
     * TaskCompleted → increment completed count and update progress.
     */
    private onTaskCompleted(event: TaskCompletedEvent): void {
        const task = this.tasks.get(event.id);
        const label = event.label || task?.label || event.id;

        this._completedSubtasks++;

        // Store completion note with summary if available
        if (event.summary) {
            this.notes.push(`✅ ${label}: ${event.summary}`);
        }

        this.updateProgress();
        this.tasks.delete(event.id);
    }

    /**
     * TaskFailed → increment failed count and update progress.
     */
    private onTaskFailed(event: TaskFailedEvent): void {
        const task = this.tasks.get(event.id);
        const label = event.label || task?.label || event.id;

        this._failedSubtasks++;

        // Store failure note
        this.notes.push(`❌ ${label}: ${event.error}`);

        this.updateProgress();
        this.tasks.delete(event.id);
    }

    /**
     * FileSetDiscovered → collect discovered files for summary.
     */
    private onFileSetDiscovered(event: FileSetDiscoveredEvent): void {
        if (event.files.length === 0) {
            return;
        }

        // Add files to discovered list
        this.discoveredFiles.push(...event.files);

        // Add note about discovered files
        this.notes.push(`📁 ${event.label}: ${event.files.length} file(s)`);
    }

    /**
     * Note → collect notes for summary.
     */
    private onNote(event: NoteEvent): void {
        let prefix = '';
        switch (event.style) {
            case 'warning':
                prefix = '⚠️ ';
                break;
            case 'success':
                prefix = '✅ ';
                break;
        }
        this.notes.push(prefix + event.message);
    }

    // -----------------------------------------------------------------------
    // Progress update helper
    // -----------------------------------------------------------------------

    /**
     * Update the background task progress based on current state.
     */
    private updateProgress(currentTask?: string): void {
        const manager = BackgroundTaskManager.getInstance();
        const percentage = this._totalSubtasks > 0
            ? Math.round((this._completedSubtasks / this._totalSubtasks) * 100)
            : 0;

        // Map current phase to standardized phase name
        let phase: 'planning' | 'executing' | 'reviewing' | 'merging' | 'finalizing' = 'executing';
        const phaseLabel = this._currentPhase.toLowerCase();
        if (phaseLabel.includes('plan')) {
            phase = 'planning';
        } else if (phaseLabel.includes('review')) {
            phase = 'reviewing';
        } else if (phaseLabel.includes('merg') || phaseLabel.includes('synthesis')) {
            phase = 'merging';
        } else if (phaseLabel.includes('final')) {
            phase = 'finalizing';
        }

        manager.updateProgress(this.taskId, {
            phase,
            completedSubtasks: this._completedSubtasks,
            totalSubtasks: this._totalSubtasks,
            percentage,
            currentSubtask: currentTask,
        });
    }
}
