import { SubagentEntry } from './subagentRegistry';
import { SubtaskResult } from './types';

// ============================================================================
// ANNOUNCE FLOW — Subagent completion notification builder
//
// Inspired by OpenClaw's announce flow:
// When a subagent completes its work, the announce flow builds a structured
// notification message that gets injected back into the main agent's context.
//
// The announce message includes:
// - What the subagent was asked to do
// - What it produced
// - Whether it succeeded or failed
// - Any escalation history
// - Timing information
//
// The main agent uses this to:
// - Present results to the user
// - Decide if follow-up work is needed
// - Update memory with the outcome
// ============================================================================

/**
 * Build an announce message for a completed subagent.
 * This gets injected into the main agent's context so it knows what happened.
 */
export function buildAnnounceMessage(
    entry: SubagentEntry,
    result: SubtaskResult,
    escalationHistory?: Array<{ modelId: string; tier: number; reason: string }>
): string {
    const lines: string[] = [];

    // Header
    const statusEmoji = result.success ? '✅' : '❌';
    lines.push(`## ${statusEmoji} Subagent Report: ${entry.title}`);
    lines.push('');

    // Summary
    lines.push('| Field | Value |');
    lines.push('|-------|-------|');
    lines.push(`| **Status** | ${result.success ? 'Completed successfully' : 'Failed'} |`);
    lines.push(`| **Model** | ${result.modelUsed} (Tier ${entry.modelTier}) |`);
    lines.push(`| **Duration** | ${(result.durationMs / 1000).toFixed(1)}s |`);
    lines.push(`| **Attempt** | ${entry.attemptNumber}${entry.isEscalation ? ' (escalation)' : ''} |`);
    lines.push('');

    // Task description (brief)
    lines.push('### Task');
    lines.push(entry.task.substring(0, 300));
    if (entry.task.length > 300) lines.push('...');
    lines.push('');

    // Result
    if (result.success) {
        lines.push('### Output');
        lines.push(result.output);
    } else {
        lines.push('### Failure Details');
        lines.push(result.reviewNotes || 'No details available.');
    }
    lines.push('');

    // Escalation history
    if (escalationHistory && escalationHistory.length > 1) {
        lines.push('### Escalation History');
        for (let i = 0; i < escalationHistory.length; i++) {
            const h = escalationHistory[i];
            const marker = i === escalationHistory.length - 1 ? '→ (final)' : '';
            lines.push(`${i + 1}. **${h.modelId}** (Tier ${h.tier}): ${h.reason} ${marker}`);
        }
        lines.push('');
    }

    // Review notes
    if (result.reviewNotes) {
        lines.push('### Review Notes');
        lines.push(result.reviewNotes);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Build a compact announce message (for space-constrained contexts).
 */
export function buildCompactAnnounce(
    entry: SubagentEntry,
    result: SubtaskResult
): string {
    const status = result.success ? '✅' : '❌';
    const duration = `${(result.durationMs / 1000).toFixed(1)}s`;
    const model = `${entry.modelId} (T${entry.modelTier})`;
    const escalation = entry.isEscalation ? ' [esc]' : '';

    const summary = result.success
        ? result.output.substring(0, 200).replace(/\n/g, ' ')
        : (result.reviewNotes || 'Failed').substring(0, 200);

    return `${status} **${entry.title}** → ${model} | ${duration}${escalation}\n> ${summary}`;
}

/**
 * Build a merge-ready announce that includes all completed subagent results
 * for the merge/synthesis phase.
 */
export function buildMergeAnnouncement(
    entries: SubagentEntry[],
    results: Map<string, SubtaskResult>
): string {
    const lines: string[] = [];
    lines.push('## Subagent Results Summary');
    lines.push('');

    const completed = entries.filter(e => e.status === 'completed');
    const failed = entries.filter(e => e.status === 'failed');

    lines.push(`**${completed.length}** completed, **${failed.length}** failed`);
    lines.push('');

    for (const entry of entries) {
        const result = results.get(entry.subtaskId);
        if (!result) continue;

        lines.push(buildCompactAnnounce(entry, result));
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Build a status update message for streaming to the user during execution.
 */
export function buildProgressUpdate(
    entry: SubagentEntry,
    phase: 'starting' | 'running' | 'reviewing' | 'done' | 'escalating'
): string {
    const phaseText: Record<string, string> = {
        starting: `🚀 Starting: **${entry.title}** → \`${entry.modelId}\` (Tier ${entry.modelTier})`,
        running: `⚙️ Running: **${entry.title}**...`,
        reviewing: `🔍 Reviewing: **${entry.title}**...`,
        done: `✅ Done: **${entry.title}** (${entry.durationMs ? (entry.durationMs / 1000).toFixed(1) + 's' : ''})`,
        escalating: `⬆️ Escalating: **${entry.title}** — trying a different model...`,
    };

    return phaseText[phase] || `**${entry.title}**: ${phase}`;
}
