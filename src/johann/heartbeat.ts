import { getConfig } from './config';
import { readBootstrapFile, getJohannWorkspaceUri, writeBootstrapFile } from './bootstrap';
import { logEvent } from './dailyNotes';
import { listDailyNotes, readDailyNotes } from './dailyNotes';
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
 * A distilled entry extracted from daily notes for MEMORY.md.
 */
interface DistilledEntry {
    category: 'learning' | 'decision' | 'error';
    title: string;
    body: string;
    date: string;
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

            // 2. Execute checks
            for (const check of checks) {
                if (check.done) {
                    continue;
                }

                // Distill daily notes into MEMORY.md
                if (check.description.toLowerCase().includes('distill')) {
                    await this.distillDailyNotes();
                } else {
                    this.logger.debug(`Heartbeat check (no handler): ${check.description}`);
                }
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
     * Distill recent daily notes into MEMORY.md.
     *
     * - Reads daily notes from the last 3 days
     * - Extracts high-value entries (learnings, decisions, errors)
     * - Appends them to the appropriate sections in MEMORY.md
     * - Skips entries already present (dedup by title)
     * - Lightweight: no LLM calls, pure pattern matching
     */
    private async distillDailyNotes(): Promise<void> {
        const base = getJohannWorkspaceUri();
        if (!base) {
            return;
        }

        // Read recent daily note files
        const dates = await listDailyNotes();
        if (dates.length === 0) {
            this.logger.debug('No daily notes to distill.');
            return;
        }

        // Gather high-value entries from the last 3 days
        const extracted: DistilledEntry[] = [];
        for (const date of dates.slice(0, 3)) {
            const content = await readDailyNotes(date);
            if (!content) {
                continue;
            }
            extracted.push(...this.extractHighValueEntries(content, date));
        }

        if (extracted.length === 0) {
            this.logger.debug('No high-value entries to distill.');
            return;
        }

        // Read current MEMORY.md
        const currentMemory = await readBootstrapFile(base, 'MEMORY.md');
        if (!currentMemory) {
            return;
        }

        // Dedup: skip entries whose title already appears in MEMORY.md
        const newEntries = extracted.filter(
            (e) => !currentMemory.includes(e.title),
        );
        if (newEntries.length === 0) {
            this.logger.debug('All high-value entries already distilled.');
            return;
        }

        // Append entries to the appropriate sections
        const updatedMemory = this.appendToMemorySections(currentMemory, newEntries);
        await writeBootstrapFile(base, 'MEMORY.md', updatedMemory);

        this.logger.info(`Distilled ${newEntries.length} entries into MEMORY.md.`);
        await logEvent(
            'Memory Distillation',
            `Distilled ${newEntries.length} entries from daily notes into MEMORY.md.`,
        );
    }

    /**
     * Extract high-value entries from a daily note's content.
     * Targets [learning], [decision], and [error] tagged entries.
     */
    private extractHighValueEntries(content: string, date: string): DistilledEntry[] {
        const entries: DistilledEntry[] = [];
        // Match ### TIME — [category] Title sections
        const entryPattern = /^### .+? — \[(learning|decision|error)\] (.+)$/gm;
        let match;

        while ((match = entryPattern.exec(content)) !== null) {
            const category = match[1] as 'learning' | 'decision' | 'error';
            const title = match[2].trim();

            // Extract body until next ### or end of string
            const startIdx = match.index + match[0].length;
            const nextHeader = content.indexOf('\n### ', startIdx);
            const body = content
                .substring(startIdx, nextHeader === -1 ? undefined : nextHeader)
                .trim();

            // Compact the body to a single bullet-friendly line
            const compact = body
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l.length > 0)
                .join(' ')
                .substring(0, 200);

            entries.push({ category, title, body: compact, date });
        }

        return entries;
    }

    /**
     * Append distilled entries to the correct sections in MEMORY.md.
     */
    private appendToMemorySections(memory: string, entries: DistilledEntry[]): string {
        // Map categories to section headers in MEMORY.md
        const sectionMap: Record<string, string> = {
            learning: '## Patterns & Learnings',
            decision: '## Decisions & Rationale',
            error: '## Patterns & Learnings', // errors are learnings
        };

        // Group entries by target section
        const grouped = new Map<string, DistilledEntry[]>();
        for (const entry of entries) {
            const section = sectionMap[entry.category];
            if (!grouped.has(section)) {
                grouped.set(section, []);
            }
            grouped.get(section)!.push(entry);
        }

        let result = memory;
        for (const [sectionHeader, sectionEntries] of grouped) {
            const idx = result.indexOf(sectionHeader);
            if (idx === -1) {
                continue;
            }

            // Find the end of the section header line
            const headerEnd = result.indexOf('\n', idx);
            if (headerEnd === -1) {
                continue;
            }

            // Build the new bullet points
            const bullets = sectionEntries
                .map((e) => `- **[${e.date}]** ${e.title}: ${e.body}`)
                .join('\n');

            // Remove the placeholder if present
            const placeholder = '- (nothing recorded yet)';
            const placeholderIdx = result.indexOf(placeholder, headerEnd);
            // Only remove if it's within this section (before next ## or end)
            const nextSection = result.indexOf('\n## ', headerEnd + 1);
            if (
                placeholderIdx !== -1 &&
                (nextSection === -1 || placeholderIdx < nextSection)
            ) {
                result =
                    result.substring(0, placeholderIdx) +
                    bullets +
                    result.substring(placeholderIdx + placeholder.length);
            } else {
                // Append after the header line
                result =
                    result.substring(0, headerEnd + 1) +
                    bullets +
                    '\n' +
                    result.substring(headerEnd + 1);
            }
        }

        return result;
    }

    /**
     * Dispose of resources.
     */
    dispose(): void {
        this.stop();
    }
}
