/*
  SelfMonitor
  Provides periodic health checks during autonomous execution: stalls, failures, resource usage.
*/

// Avoid tight coupling; use loose state typing
export type AutonomousRunStateLike = Record<string, any>;

export type MonitorAction = 'continue' | 'retry' | 'escalate' | 'pause' | 'abort';

export interface MonitorConfig {
    stallMs?: number; // default 5 minutes
    consecutiveFailureLimit?: number; // default 3
    llmRequestSoftLimit?: number; // warn threshold
    executionTimeSoftLimitMs?: number; // warn threshold
}

export interface HealthCheck {
    status: 'ok' | 'warning' | 'error';
    recommendedActions: MonitorAction[];
    stalledStreams?: string[];
    pausedStreams?: string[];
    notes?: string[];
    metrics?: Record<string, number>;
}

export class SelfMonitor {
    private readonly cfg: Required<MonitorConfig>;

    constructor(cfg?: MonitorConfig) {
        this.cfg = {
            stallMs: cfg?.stallMs ?? 5 * 60 * 1000,
            consecutiveFailureLimit: cfg?.consecutiveFailureLimit ?? 3,
            llmRequestSoftLimit: cfg?.llmRequestSoftLimit ?? 0,
            executionTimeSoftLimitMs: cfg?.executionTimeSoftLimitMs ?? 0,
        };
    }

    runHealthCheck(state: AutonomousRunStateLike): HealthCheck {
        const now = Date.now();
        const actions: MonitorAction[] = [];
        const stalled: string[] = [];
        const paused: string[] = [];
        const notes: string[] = [];

        const streams: any[] = (state?.workStreams as any[]) ?? [];
        for (const s of streams) {
            const id = s?.id ?? s?.name ?? 'stream';
            const last = (s?.lastActivity as number) ?? 0;
            const failures = (s?.consecutiveFailures as number) ?? 0;
            const status = s?.status as string | undefined;

            // Stall detection
            if (
                last &&
                now - last > this.cfg.stallMs &&
                status !== 'paused' &&
                status !== 'completed'
            ) {
                stalled.push(String(id));
            }

            // Failure pattern detection
            if (failures >= this.cfg.consecutiveFailureLimit) {
                paused.push(String(id));
            }
        }

        if (stalled.length) {
            actions.push('retry', 'escalate');
            notes.push(`Detected stalled streams: ${stalled.join(', ')}`);
        }
        if (paused.length) {
            actions.push('pause');
            notes.push(`Paused streams due to repeated failures: ${paused.join(', ')}`);
        }

        // Resource monitoring
        const llmRequests = (state?.metrics?.llmRequests as number) ?? 0;
        const execMs = (state?.metrics?.totalExecutionMs as number) ?? 0;
        const metrics: Record<string, number> = { llmRequests, totalExecutionMs: execMs };

        if (this.cfg.llmRequestSoftLimit && llmRequests >= this.cfg.llmRequestSoftLimit) {
            if (!actions.includes('pause')) {actions.push('pause');}
            notes.push(
                `LLM request count ${llmRequests} reached soft limit ${this.cfg.llmRequestSoftLimit}`,
            );
        }
        if (this.cfg.executionTimeSoftLimitMs && execMs >= this.cfg.executionTimeSoftLimitMs) {
            if (!actions.includes('pause')) {actions.push('pause');}
            notes.push(
                `Execution time ${execMs}ms reached soft limit ${this.cfg.executionTimeSoftLimitMs}ms`,
            );
        }

        const status: HealthCheck['status'] = paused.length
            ? 'error'
            : stalled.length || actions.length
              ? 'warning'
              : 'ok';

        if (!actions.length) {actions.push('continue');}

        return {
            status,
            recommendedActions: actions,
            stalledStreams: stalled.length ? stalled : undefined,
            pausedStreams: paused.length ? paused : undefined,
            notes: notes.length ? notes : undefined,
            metrics,
        };
    }
}
