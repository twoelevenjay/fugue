import * as vscode from 'vscode';
import * as path from 'path';
import { BackgroundTask, BackgroundTaskStatus, BackgroundTaskProgress } from './types';

// ============================================================================
// BACKGROUND TASK MANAGER
//
// Manages background orchestration tasks that run asynchronously.
// Provides:
// - Task registry (in-memory + disk persistence)
// - Progress tracking and notifications
// - Cancellation support
// - Auto-resume on VS Code restart
// ============================================================================

/**
 * Persisted task metadata (saved to disk).
 */
interface TaskMetadata {
    id: string;
    sessionId: string;
    type: 'orchestration';
    status: BackgroundTaskStatus;
    startedAt: string;
    completedAt?: string;
    progress: BackgroundTaskProgress;
    request: string;
    summary: string;
    error?: string;
}

/**
 * Singleton manager for background tasks.
 */
export class BackgroundTaskManager {
    private static instance: BackgroundTaskManager | null = null;
    private tasks: Map<string, BackgroundTask> = new Map();
    private taskDir: vscode.Uri | null = null;
    private statusBarItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];

    private constructor() {
        // Create status bar item for showing active tasks
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'johann.showBackgroundTasks';
        this.disposables.push(this.statusBarItem);
        
        // Initialize task directory
        this.initializeTaskDir();
    }

    /**
     * Get the singleton instance.
     */
    static getInstance(): BackgroundTaskManager {
        if (!BackgroundTaskManager.instance) {
            BackgroundTaskManager.instance = new BackgroundTaskManager();
        }
        return BackgroundTaskManager.instance;
    }

    /**
     * Initialize the task persistence directory.
     */
    private async initializeTaskDir(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return;
        }

        this.taskDir = vscode.Uri.joinPath(folders[0].uri, '.vscode', 'johann', 'tasks');
        
        try {
            await vscode.workspace.fs.createDirectory(this.taskDir);
        } catch {
            // Directory exists or can't be created
        }
    }

    /**
     * Create and register a new background task.
     */
    async createTask(
        sessionId: string,
        request: string,
        summary: string,
        totalSubtasks: number
    ): Promise<BackgroundTask> {
        const id = `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        
        const task: BackgroundTask = {
            id,
            sessionId,
            type: 'orchestration',
            status: 'running',
            startedAt: new Date().toISOString(),
            progress: {
                phase: 'planning',
                completedSubtasks: 0,
                totalSubtasks,
                percentage: 0,
            },
            cancellationToken: new vscode.CancellationTokenSource(),
            request,
            summary,
        };

        this.tasks.set(id, task);
        await this.persistTask(task);
        this.updateStatusBar();

        return task;
    }

    /**
     * Get a task by ID.
     */
    getTask(id: string): BackgroundTask | undefined {
        return this.tasks.get(id);
    }

    /**
     * Get all tasks.
     */
    getAllTasks(): BackgroundTask[] {
        return Array.from(this.tasks.values());
    }

    /**
     * Get all running tasks.
     */
    getRunningTasks(): BackgroundTask[] {
        return Array.from(this.tasks.values()).filter(t => t.status === 'running');
    }

    /**
     * Update task progress.
     */
    async updateProgress(
        id: string,
        progress: Partial<BackgroundTaskProgress>
    ): Promise<void> {
        const task = this.tasks.get(id);
        if (!task) {
            return;
        }

        task.progress = { ...task.progress, ...progress };
        
        // Recalculate percentage
        if (task.progress.totalSubtasks > 0) {
            task.progress.percentage = Math.round(
                (task.progress.completedSubtasks / task.progress.totalSubtasks) * 100
            );
        }

        await this.persistTask(task);
        this.updateStatusBar();
    }

    /**
     * Update task status.
     */
    async updateStatus(
        id: string,
        status: BackgroundTaskStatus,
        error?: string
    ): Promise<void> {
        const task = this.tasks.get(id);
        if (!task) {
            return;
        }

        task.status = status;
        if (error) {
            task.error = error;
        }
        
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
            task.completedAt = new Date().toISOString();
            
            // Show notification
            if (status === 'completed') {
                vscode.window.showInformationMessage(
                    `✅ Johann completed: "${task.summary}"`,
                    'View Results',
                    'Show Memory'
                ).then(choice => {
                    if (choice === 'View Results') {
                        vscode.commands.executeCommand('johann.showTaskStatus', id);
                    } else if (choice === 'Show Memory') {
                        vscode.commands.executeCommand('johann.showMemory');
                    }
                });
            } else if (status === 'failed') {
                vscode.window.showErrorMessage(
                    `❌ Johann task failed: "${error || 'Unknown error'}"`,
                    'View Logs',
                    'Retry'
                ).then(choice => {
                    if (choice === 'View Logs') {
                        vscode.commands.executeCommand('johann.showDebugLog');
                    } else if (choice === 'Retry') {
                        // TODO: Implement retry logic
                    }
                });
            }
        }

        await this.persistTask(task);
        this.updateStatusBar();
    }

    /**
     * Cancel a running task.
     * Returns true if the task was cancelled, false if it wasn't found or couldn't be cancelled.
     */
    async cancelTask(id: string): Promise<boolean> {
        const task = this.tasks.get(id);
        if (!task) {
            return false;
        }

        if (task.status === 'running' || task.status === 'paused') {
            task.cancellationToken.cancel();
            await this.updateStatus(id, 'cancelled');
            return true;
        }

        return false;
    }

    /**
     * Remove completed/failed/cancelled tasks from registry.
     */
    async clearCompletedTasks(): Promise<void> {
        const toRemove: string[] = [];
        
        for (const [id, task] of this.tasks.entries()) {
            if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
                toRemove.push(id);
            }
        }

        for (const id of toRemove) {
            this.tasks.delete(id);
            await this.deleteTaskFile(id);
        }

        this.updateStatusBar();
    }

    /**
     * Load incomplete tasks from disk (for auto-resume on restart).
     */
    async loadIncompleteTasks(): Promise<TaskMetadata[]> {
        if (!this.taskDir) {
            return [];
        }

        const incomplete: TaskMetadata[] = [];

        try {
            const entries = await vscode.workspace.fs.readDirectory(this.taskDir);
            
            for (const [name, type] of entries) {
                if (type === vscode.FileType.File && name.endsWith('.json')) {
                    const taskUri = vscode.Uri.joinPath(this.taskDir, name);
                    try {
                        const content = await vscode.workspace.fs.readFile(taskUri);
                        const metadata: TaskMetadata = JSON.parse(content.toString());
                        
                        // Only include incomplete tasks
                        if (metadata.status === 'running' || metadata.status === 'paused') {
                            incomplete.push(metadata);
                        }
                    } catch {
                        // Ignore malformed files
                    }
                }
            }
        } catch {
            // Directory doesn't exist or can't be read
        }

        return incomplete;
    }

    /**
     * Get a formatted summary of a task's status and progress.
     */
    getTaskSummary(id: string): string {
        const task = this.tasks.get(id);
        if (!task) {
            return `Task ${id} not found.`;
        }

        const lines: string[] = [];
        lines.push(`# Johann Background Task`);
        lines.push('');
        lines.push(`**Task ID:** ${task.id}`);
        lines.push(`**Session:** ${task.sessionId}`);
        lines.push(`**Type:** ${task.type}`);
        lines.push(`**Status:** ${task.status}`);
        lines.push(`**Started:** ${new Date(task.startedAt).toLocaleString()}`);
        
        if (task.completedAt) {
            lines.push(`**Completed:** ${new Date(task.completedAt).toLocaleString()}`);
            const duration = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
            lines.push(`**Duration:** ${this.formatDuration(duration)}`);
        }

        lines.push('');
        lines.push(`## Request`);
        lines.push('');
        lines.push(task.request || 'No request recorded');
        lines.push('');

        if (task.progress) {
            lines.push(`## Progress`);
            lines.push('');
            lines.push(`**Phase:** ${task.progress.phase}`);
            lines.push(`**Subtasks:** ${task.progress.completedSubtasks}/${task.progress.totalSubtasks} (${task.progress.percentage}%)`);
            lines.push('');
        }

        if (task.summary) {
            lines.push(`## Summary`);
            lines.push('');
            lines.push(task.summary);
            lines.push('');
        }

        if (task.error) {
            lines.push(`## Error`);
            lines.push('');
            lines.push('```');
            lines.push(task.error);
            lines.push('```');
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Format a duration in milliseconds for display.
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
     * Persist task metadata to disk.
     */
    private async persistTask(task: BackgroundTask): Promise<void> {
        if (!this.taskDir) {
            return;
        }

        const metadata: TaskMetadata = {
            id: task.id,
            sessionId: task.sessionId,
            type: task.type,
            status: task.status,
            startedAt: task.startedAt,
            completedAt: task.completedAt,
            progress: task.progress,
            request: task.request,
            summary: task.summary,
            error: task.error,
        };

        const taskUri = vscode.Uri.joinPath(this.taskDir, `${task.id}.json`);
        const content = JSON.stringify(metadata, null, 2);
        
        try {
            await vscode.workspace.fs.writeFile(taskUri, Buffer.from(content, 'utf-8'));
        } catch {
            // Ignore write errors
        }
    }

    /**
     * Delete a task file from disk.
     */
    private async deleteTaskFile(id: string): Promise<void> {
        if (!this.taskDir) {
            return;
        }

        const taskUri = vscode.Uri.joinPath(this.taskDir, `${id}.json`);
        
        try {
            await vscode.workspace.fs.delete(taskUri);
        } catch {
            // Ignore deletion errors
        }
    }

    /**
     * Update the status bar item to show active tasks.
     */
    private updateStatusBar(): void {
        const runningTasks = this.getRunningTasks();
        
        if (runningTasks.length === 0) {
            this.statusBarItem.hide();
            return;
        }

        if (runningTasks.length === 1) {
            const task = runningTasks[0];
            this.statusBarItem.text = `$(sync~spin) Johann: ${task.progress.percentage}%`;
            this.statusBarItem.tooltip = `${task.summary}\n${task.progress.completedSubtasks}/${task.progress.totalSubtasks} subtasks`;
        } else {
            this.statusBarItem.text = `$(sync~spin) Johann: ${runningTasks.length} tasks`;
            this.statusBarItem.tooltip = runningTasks.map(t => t.summary).join('\n');
        }

        this.statusBarItem.show();
    }

    /**
     * Dispose of all resources.
     */
    dispose(): void {
        for (const task of this.tasks.values()) {
            task.cancellationToken.dispose();
        }
        
        for (const disposable of this.disposables) {
            disposable.dispose();
        }

        this.tasks.clear();
        BackgroundTaskManager.instance = null;
    }
}
