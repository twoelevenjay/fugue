/**
 * workerActivityPanel.ts — Live visibility into ACP worker activity.
 *
 * Problem: ACP workers run as background child processes. The Copilot chat
 * shows final results but junior devs can't see what's happening in between.
 *
 * Solution: Each worker gets a dedicated LogOutputChannel that streams
 * tool calls, agent messages, and stderr in real-time. The orchestrator
 * can render "Open Log" buttons in the chat response.
 *
 * Architecture:
 * - WorkerActivityPanel is a singleton that manages per-worker output channels
 * - AcpWorkerManager calls panel.logTool(), panel.logMessage(), etc.
 * - Orchestrator can call panel.createChatButton() to render a button in chat
 * - Channels auto-dispose when workers finish
 */

import * as vscode from 'vscode';

// ============================================================================
// Types
// ============================================================================

export interface WorkerActivity {
    workerId: string;
    subtaskTitle: string;
    model: string;
    channel: vscode.LogOutputChannel;
    startTime: number;
    toolCalls: number;
    messageChunks: number;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
}

// ============================================================================
// Singleton
// ============================================================================

let _instance: WorkerActivityPanel | undefined;

export function getActivityPanel(): WorkerActivityPanel {
    if (!_instance) {
        _instance = new WorkerActivityPanel();
    }
    return _instance;
}

// ============================================================================
// Panel
// ============================================================================

export class WorkerActivityPanel implements vscode.Disposable {
    private workers: Map<string, WorkerActivity> = new Map();
    private disposables: vscode.Disposable[] = [];

    constructor() {
        // Register the "show all workers" command
        this.disposables.push(
            vscode.commands.registerCommand('johann.showWorkerActivity', () => {
                this.showWorkerPicker();
            }),
        );
    }

    /**
     * Start tracking a new worker. Creates a dedicated LogOutputChannel.
     */
    startWorker(workerId: string, subtaskTitle: string, model: string): void {
        // Clean up existing channel for this worker if somehow reused
        const existing = this.workers.get(workerId);
        if (existing) {
            existing.channel.dispose();
        }

        const channelName = `Johann Worker: ${subtaskTitle.substring(0, 40)}`;
        const channel = vscode.window.createOutputChannel(channelName, { log: true });

        const activity: WorkerActivity = {
            workerId,
            subtaskTitle,
            model,
            channel,
            startTime: Date.now(),
            toolCalls: 0,
            messageChunks: 0,
            status: 'running',
        };

        this.workers.set(workerId, activity);

        channel.info(`═══════════════════════════════════════════════════════`);
        channel.info(`Worker: ${workerId}`);
        channel.info(`Task:   ${subtaskTitle}`);
        channel.info(`Model:  ${model}`);
        channel.info(`Started: ${new Date().toLocaleTimeString()}`);
        channel.info(`═══════════════════════════════════════════════════════`);
        channel.info('');
    }

    /**
     * Log a tool call (file edit, terminal command, search, etc.)
     */
    logTool(workerId: string, kind: string, title: string, approved: boolean): void {
        const activity = this.workers.get(workerId);
        if (!activity) {
            return;
        }

        activity.toolCalls++;
        const icon = approved ? '✅' : '🚫';
        activity.channel.info(`${icon} [${kind}] ${title}`);
    }

    /**
     * Log an agent message chunk (the worker's "thinking out loud").
     */
    logMessage(workerId: string, text: string): void {
        const activity = this.workers.get(workerId);
        if (!activity) {
            return;
        }

        activity.messageChunks++;
        // Trim and prefix each line so it's clearly agent output
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.trim()) {
                activity.channel.info(`💬 ${line}`);
            }
        }
    }

    /**
     * Log stderr output from the worker process.
     */
    logStderr(workerId: string, text: string): void {
        const activity = this.workers.get(workerId);
        if (!activity) {
            return;
        }

        const lines = text.split('\n');
        for (const line of lines) {
            if (line.trim()) {
                activity.channel.warn(`⚠️ ${line}`);
            }
        }
    }

    /**
     * Log a custom info/debug message.
     */
    logInfo(workerId: string, message: string): void {
        const activity = this.workers.get(workerId);
        if (!activity) {
            return;
        }
        activity.channel.info(message);
    }

    /**
     * Mark a worker as completed and log summary.
     */
    finishWorker(
        workerId: string,
        status: 'completed' | 'failed' | 'cancelled',
        summary?: string,
    ): void {
        const activity = this.workers.get(workerId);
        if (!activity) {
            return;
        }

        activity.status = status;
        const elapsed = ((Date.now() - activity.startTime) / 1000).toFixed(1);
        const icon = status === 'completed' ? '✅' : status === 'failed' ? '❌' : '⏹️';

        activity.channel.info('');
        activity.channel.info(`═══════════════════════════════════════════════════════`);
        activity.channel.info(`${icon} Worker ${status.toUpperCase()}`);
        activity.channel.info(`Duration:   ${elapsed}s`);
        activity.channel.info(`Tool calls: ${activity.toolCalls}`);
        if (summary) {
            activity.channel.info(`Summary:    ${summary}`);
        }
        activity.channel.info(`═══════════════════════════════════════════════════════`);

        // Don't dispose the channel immediately — user might want to review
        // Clean up after 5 minutes
        setTimeout(
            () => {
                const w = this.workers.get(workerId);
                if (w && w.status !== 'running') {
                    w.channel.dispose();
                    this.workers.delete(workerId);
                }
            },
            5 * 60 * 1000,
        );
    }

    /**
     * Show the worker's log channel (brings it to focus in the Output panel).
     */
    showWorkerLog(workerId: string): void {
        const activity = this.workers.get(workerId);
        if (activity) {
            activity.channel.show();
        }
    }

    /**
     * Render a "View Live Log" button in the chat stream.
     */
    renderLogButton(stream: vscode.ChatResponseStream, workerId: string): void {
        stream.button({
            command: 'johann.showWorkerActivity',
            title: '📋 View Worker Logs',
            arguments: [workerId],
        });
    }

    /**
     * Show a QuickPick to select which worker's log to view.
     * If a workerId is passed directly, skip the picker.
     */
    private async showWorkerPicker(directWorkerId?: string): Promise<void> {
        if (directWorkerId) {
            this.showWorkerLog(directWorkerId);
            return;
        }

        const items: (vscode.QuickPickItem & { workerId: string })[] = [];

        for (const [id, activity] of this.workers) {
            const elapsed = ((Date.now() - activity.startTime) / 1000).toFixed(0);
            const statusIcon =
                activity.status === 'running'
                    ? '🔄'
                    : activity.status === 'completed'
                      ? '✅'
                      : activity.status === 'failed'
                        ? '❌'
                        : '⏹️';

            items.push({
                label: `${statusIcon} ${activity.subtaskTitle}`,
                description: `${activity.model} · ${activity.toolCalls} tools · ${elapsed}s`,
                detail: `Worker: ${id}`,
                workerId: id,
            });
        }

        if (items.length === 0) {
            vscode.window.showInformationMessage('No active or recent workers.');
            return;
        }

        // Sort: running first, then by start time
        items.sort((a, b) => {
            const aRunning = this.workers.get(a.workerId)!.status === 'running' ? 0 : 1;
            const bRunning = this.workers.get(b.workerId)!.status === 'running' ? 0 : 1;
            if (aRunning !== bRunning) {
                return aRunning - bRunning;
            }
            return (
                this.workers.get(b.workerId)!.startTime - this.workers.get(a.workerId)!.startTime
            );
        });

        const pick = await vscode.window.showQuickPick(items, {
            title: 'Johann — Worker Activity',
            placeHolder: 'Select a worker to view its live log',
        });

        if (pick) {
            this.showWorkerLog(pick.workerId);
        }
    }

    /**
     * Get a summary of all active workers (for status displays).
     */
    getActiveWorkerSummary(): string[] {
        const summaries: string[] = [];
        for (const [, activity] of this.workers) {
            if (activity.status === 'running') {
                const elapsed = ((Date.now() - activity.startTime) / 1000).toFixed(0);
                summaries.push(
                    `${activity.subtaskTitle} (${activity.model}, ${activity.toolCalls} tools, ${elapsed}s)`,
                );
            }
        }
        return summaries;
    }

    dispose(): void {
        for (const [, activity] of this.workers) {
            activity.channel.dispose();
        }
        this.workers.clear();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
