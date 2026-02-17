import { getConfig } from './config';
import { readBootstrapFile, getJohannWorkspaceUri } from './bootstrap';
import { logEvent } from './dailyNotes';
import { JohannLogger } from './logger';

// ============================================================================
// HEARTBEAT — Periodic self-check system
//
// Inspired by OpenClaw's heartbeat architecture:
// - A timer fires at a configurable interval (default: 15 min)
// - On each heartbeat, Johann reads HEARTBEAT.md for its check list
// - Performs maintenance tasks:
//   - Review daily notes → distill into MEMORY.md
//   - Check for stale TODO items
//   - Update SOUL.md if self-reflection is due
// - Can be enabled/disabled via config
// - Lightweight: no LLM calls in the heartbeat itself (just file ops)
//   unless a task explicitly requires reasoning
// ============================================================================

/**
 * A heartbeat check item parsed from HEARTBEAT.md.
 */
export interface HeartbeatCheck {
    /** The check description */
    description: string;
    /** Whether it's marked as done (checkbox) */
    done: boolean;
    /** Whether it's a recurring check or one-time */
    recurring: boolean;
}

/**
 * The heartbeat manager.
 */
export class HeartbeatManager {
    private timer: ReturnType<typeof setInterval> | undefined;
    private logger: JohannLogger;
    private isRunning = false;
    private lastHeartbeat: Date | undefined;
    private heartbeatCount = 0;

    constructor(logger: JohannLogger) {
        this.logger = logger;
    }

    /**
     * Start the heartbeat timer.
     */
    start(): void {
        const config = getConfig();
        if (!config.heartbeatEnabled) {
            this.logger.info('Heartbeat disabled in config.');
            return;
        }

        if (this.isRunning) {
            this.logger.debug('Heartbeat already running.');
            return;
        }

        const intervalMs = config.heartbeatIntervalMinutes * 60 * 1000;
        this.logger.info(`Starting heartbeat with ${config.heartbeatIntervalMinutes}min interval.`);

        this.timer = setInterval(() => {
            this.pulse().catch((err) => {
                this.logger.error(`Heartbeat pulse error: ${err}`);
            });
        }, intervalMs);

        this.isRunning = true;

        // Run an initial pulse after a short delay
        setTimeout(() => {
            this.pulse().catch((err) => {
                this.logger.error(`Initial heartbeat pulse error: ${err}`);
            });
        }, 5000);
    }

    /**
     * Stop the heartbeat timer.
     */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        this.isRunning = false;
        this.logger.info('Heartbeat stopped.');
    }

    /**
     * Whether the heartbeat is currently running.
     */
    running(): boolean {
        return this.isRunning;
    }

    /**
     * Get heartbeat status info.
     */
    getStatus(): {
        running: boolean;
        lastHeartbeat: Date | undefined;
        heartbeatCount: number;
    } {
        return {
            running: this.isRunning,
            lastHeartbeat: this.lastHeartbeat,
            heartbeatCount: this.heartbeatCount,
        };
    }

    /**
     * Execute a single heartbeat pulse.
     * This is the core routine that runs on each tick.
     */
    async pulse(): Promise<void> {
        this.lastHeartbeat = new Date();
        this.heartbeatCount++;
        this.logger.debug(`Heartbeat pulse #${this.heartbeatCount}`);

        try {
            // 1. Read HEARTBEAT.md for the check list
            const checks = await this.loadChecks();
            this.logger.debug(`Loaded ${checks.length} heartbeat checks.`);

            // 2. Execute lightweight checks (file-based, no LLM)
            for (const check of checks) {
                if (check.done) {
                    continue;
                }

                // Log that we saw the check
                this.logger.debug(`Heartbeat check: ${check.description}`);
            }

            // 3. Log the heartbeat event
            await logEvent(
                `Heartbeat #${this.heartbeatCount}`,
                `Pulse completed. ${checks.filter((c) => !c.done).length} pending checks.`,
            );
        } catch (err) {
            this.logger.error(`Heartbeat pulse failed: ${err}`);
        }
    }

    /**
     * Load and parse HEARTBEAT.md checks.
     */
    private async loadChecks(): Promise<HeartbeatCheck[]> {
        const base = getJohannWorkspaceUri();
        if (!base) {
            return [];
        }

        const content = await readBootstrapFile(base, 'HEARTBEAT.md');
        if (!content) {
            return [];
        }

        return this.parseChecks(content);
    }

    /**
     * Parse HEARTBEAT.md content into check items.
     * Looks for checkbox-style lines: - [ ] or - [x]
     */
    private parseChecks(content: string): HeartbeatCheck[] {
        const lines = content.split('\n');
        const checks: HeartbeatCheck[] = [];
        let currentSection = 'general';

        for (const line of lines) {
            const trimmed = line.trim();

            // Track sections to determine recurring vs one-time
            if (trimmed.startsWith('## ')) {
                currentSection = trimmed.replace('## ', '').toLowerCase();
            }

            // Parse checkbox lines
            const checkMatch = trimmed.match(/^-\s*\[([ xX])\]\s*(.+)/);
            if (checkMatch) {
                const done = checkMatch[1] !== ' ';
                const description = checkMatch[2].trim();
                const recurring = currentSection.includes('recurring');

                checks.push({ description, done, recurring });
            }
        }

        return checks;
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.stop();
    }
}
