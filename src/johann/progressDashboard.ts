/*
  ProgressDashboard
  Maintains a human-readable progress file at .vscode/johann/PROGRESS.md
  Uses VS Code workspace.fs for atomic writes.
*/

import * as vscode from 'vscode';

// Minimal logger interface to avoid tight coupling
type LoggerLike = {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
};

// Event types captured for recent log
export type DashboardEvent = {
    timestamp: number; // ms since epoch
    type:
        | 'phase-started'
        | 'phase-completed'
        | 'phase-failed'
        | 'workstream-started'
        | 'workstream-completed'
        | 'workstream-paused'
        | 'workstream-failed'
        | 'subtask-started'
        | 'subtask-completed'
        | 'subtask-failed'
        | 'model-escalation'
        | 'error-recovery'
        | 'paused-for-review';
    message: string;
    streamId?: string;
    subtaskId?: string;
};

// Weakly-typed state to keep compatibility with evolving runner
export type AutonomousRunStateLike = Record<string, any>;

export class ProgressDashboard {
    private readonly logger: LoggerLike;
    private readonly workspaceFolder: vscode.WorkspaceFolder;
    private readonly projectName: string;
    private readonly startTime: number;
    private readonly events: DashboardEvent[] = [];
    private readonly maxEvents: number = 200; // keep more, render last 20

    constructor(opts: {
        logger: LoggerLike;
        workspaceFolder: vscode.WorkspaceFolder;
        projectName: string;
        startTime?: number | Date;
    }) {
        this.logger = opts.logger;
        this.workspaceFolder = opts.workspaceFolder;
        this.projectName = opts.projectName;
        this.startTime =
            typeof opts.startTime === 'number'
                ? opts.startTime
                : opts.startTime
                  ? (opts.startTime as Date).getTime()
                  : Date.now();
    }

    recordEvent(ev: DashboardEvent) {
        this.events.push(ev);
        if (this.events.length > this.maxEvents) {
            this.events.splice(0, this.events.length - this.maxEvents);
        }
    }

    async updateDashboard(state: AutonomousRunStateLike): Promise<void> {
        const now = Date.now();
        const elapsedMs = now - this.startTime;
        const elapsedStr = this.formatDuration(elapsedMs);

        const header = `# Johann Autonomous Progress\n\n- Project: **${this.projectName}**\n- Start: ${new Date(this.startTime).toLocaleString()}\n- Elapsed: ${elapsedStr}`;

        const overall = this.computeOverall(state);
        const bar = this.renderBar(overall.percent);
        const overallSection = `\n\n## Overall\n\n${bar} ${overall.percent.toFixed(0)}% — Phase ${overall.phaseIndex}/${overall.phaseTotal}`;

        const streamsSection = this.renderStreams(state);
        const eventsSection = this.renderEvents();
        const errorSection = this.renderErrors(state);
        const nextUpSection = this.renderNextUp(state);

        const md = [
            header,
            overallSection,
            streamsSection,
            eventsSection,
            errorSection,
            nextUpSection,
        ].join('\n\n');

        await this.writeProgress(md);
    }

    private computeOverall(state: AutonomousRunStateLike): {
        percent: number;
        phaseIndex: number;
        phaseTotal: number;
    } {
        const phases = (state?.phases as any[]) ?? [];
        const phaseTotal = phases.length || (state?.phaseTotal as number) || 3;
        const phaseIndex = (state?.currentPhaseIndex as number) ?? 1;

        let total = (state?.metrics?.totalSubtasks as number) ?? 0;
        let done = (state?.metrics?.completedSubtasks as number) ?? 0;

        if (!total) {
            const planSubtasks = (state?.plan?.subtasks as any[]) ?? [];
            total = planSubtasks.length;
            done = planSubtasks.filter((s: any) => s?.status === 'completed').length;
        }

        const percent = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
        return { percent, phaseIndex, phaseTotal };
    }

    private renderStreams(state: AutonomousRunStateLike): string {
        const streams: any[] = (state?.workStreams as any[]) ?? [];
        if (!streams.length) {
            return '## Work Streams\n\n_No active work streams_';
        }

        const rows = streams.map((s) => {
            const name = s?.name ?? s?.id ?? 'unknown';
            const branch = s?.branch ?? s?.gitBranch ?? 'n/a';
            const status = s?.status ?? 'unknown';
            const progress = this.renderBar(
                (s?.progressPercent as number) ?? this.deriveStreamPercent(s),
            );
            const subtask = s?.currentSubtask?.title ?? s?.currentSubtaskId ?? '—';
            const last = s?.lastActivity ? new Date(s.lastActivity).toLocaleTimeString() : '—';
            return `| ${name} | ${branch} | ${status} | ${progress} | ${subtask} | ${last} |`;
        });

        const header =
            '| Stream | Branch | Status | Progress | Subtask | Last Activity |\n|---|---|---|---|---|---|';
        return `## Work Streams\n\n${header}\n${rows.join('\n')}`;
    }

    private deriveStreamPercent(s: any): number {
        const total = (s?.totalSubtasks as number) ?? (s?.subtasks?.length as number) ?? 0;
        const done =
            (s?.completedSubtasks as number) ??
            (s?.subtasks?.filter((x: any) => x?.status === 'completed')?.length as number) ??
            0;
        return total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
    }

    private renderEvents(): string {
        const recent = this.events.slice(-20);
        if (!recent.length) {
            return '## Recent Events\n\n_No recent events_';
        }
        const lines = recent
            .map((e) => `- ${new Date(e.timestamp).toLocaleString()} — ${e.type}: ${e.message}`)
            .join('\n');
        return `## Recent Events\n\n${lines}`;
    }

    private renderErrors(state: AutonomousRunStateLike): string {
        const failures: any[] = (state?.recentFailures as any[]) ?? (state?.errors as any[]) ?? [];
        const escalations: any[] = (state?.recentEscalations as any[]) ?? [];
        if (!failures.length && !escalations.length) {
            return '## Errors & Escalations\n\n_None_';
        }

        const lines: string[] = [];
        for (const f of failures.slice(-20)) {
            const where = f?.streamId ? ` [${f.streamId}]` : '';
            lines.push(`- Failure${where}: ${f?.message ?? 'unknown error'}`);
        }
        for (const e of escalations.slice(-20)) {
            const where = e?.streamId ? ` [${e.streamId}]` : '';
            lines.push(`- Escalation${where}: ${e?.reason ?? 'escalated model'}`);
        }
        return `## Errors & Escalations\n\n${lines.join('\n')}`;
    }

    private renderNextUp(state: AutonomousRunStateLike): string {
        const queue: any[] = (state?.queuedSubtasks as any[]) ?? [];
        if (!queue.length) {
            return '## Next Up\n\n_Idle or waiting for events_';
        }
        const lines = queue
            .slice(0, 10)
            .map((q) => `- ${q?.title ?? q?.id ?? 'subtask'} (${q?.streamId ?? 'global'})`);
        return `## Next Up\n\n${lines.join('\n')}`;
    }

    private renderBar(percent: number): string {
        const p = Math.min(100, Math.max(0, percent || 0));
        const blocks = 20;
        const filled = Math.round((p / 100) * blocks);
        const fill = '#'.repeat(filled);
        const empty = '-'.repeat(blocks - filled);
        return `[${fill}${empty}]`;
    }

    private formatDuration(ms: number): string {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const ss = s % 60;
        return `${h}h ${m}m ${ss}s`;
    }

    private async writeProgress(content: string): Promise<void> {
        try {
            const base = vscode.Uri.joinPath(this.workspaceFolder.uri, '.vscode', 'johann');
            await vscode.workspace.fs.createDirectory(base);
            const final = vscode.Uri.joinPath(base, 'PROGRESS.md');
            const tmp = vscode.Uri.joinPath(base, `PROGRESS.md.tmp-${Date.now()}`);
            const data = Buffer.from(content, 'utf8');
            await vscode.workspace.fs.writeFile(tmp, data);
            // Atomic replace via rename (best-effort within same directory)
            try {
                // Remove existing file if rename across platforms fails
                await vscode.workspace.fs.rename(tmp, final, { overwrite: true });
            } catch {
                try {
                    await vscode.workspace.fs.delete(final, { recursive: false, useTrash: false });
                } catch {}
                await vscode.workspace.fs.rename(tmp, final, { overwrite: true });
            }
            this.logger.info('ProgressDashboard: updated PROGRESS.md');
        } catch (err: any) {
            this.logger.error(
                `ProgressDashboard: failed to write dashboard: ${String(err?.message ?? err)}`,
            );
        }
    }
}
