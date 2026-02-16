import { RunStateData, RunTask, RunPhase, TaskStatus } from './runState';

// ============================================================================
// STATUS SNAPSHOT — Generates rich status snapshots from RunState
//
// Produces:
//   1. Header with run ID, elapsed time, counters
//   2. Top active items (running + queued)
//   3. Mermaid diagram (compact phase-level flowchart)
//   4. Text fallback table
//   5. Action hints
//
// Two Mermaid variants:
//   - Compact: phase-level flowchart (always generated)
//   - Detailed: task-level flowchart (on-demand, capped at ~30 nodes)
//
// The snapshot is a POINT-IN-TIME capture — NOT continuously streamed.
// ============================================================================

// ---------------------------------------------------------------------------
// Snapshot types
// ---------------------------------------------------------------------------

/**
 * A full status snapshot.
 */
export interface StatusSnapshot {
    /** When the snapshot was taken. */
    timestamp: string;
    /** Header block (run info + counters). */
    header: string;
    /** Currently active items block. */
    activeItems: string;
    /** Compact Mermaid flowchart (phase-level). */
    mermaidCompact: string;
    /** Detailed Mermaid flowchart (task-level, may be empty for huge plans). */
    mermaidDetailed: string;
    /** Text fallback table. */
    textTable: string;
    /** Action hints. */
    actions: string;
    /** Pending user queue messages (if any). */
    queueInfo: string;
    /** Full assembled markdown output. */
    markdown: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a full status snapshot from the current RunState.
 */
export function generateSnapshot(state: RunStateData): StatusSnapshot {
    const now = new Date();
    const timestamp = now.toISOString();

    const header = buildHeader(state, now);
    const activeItems = buildActiveItems(state);
    const mermaidCompact = buildCompactMermaid(state);
    const mermaidDetailed = buildDetailedMermaid(state);
    const textTable = buildTextTable(state);
    const actions = buildActions(state);
    const queueInfo = buildQueueInfo(state);

    // Assemble full markdown
    const parts: string[] = [];
    parts.push(header);
    if (activeItems) { parts.push(activeItems); }
    if (queueInfo) { parts.push(queueInfo); }
    parts.push('\n### Workflow Status\n');
    parts.push('```mermaid');
    parts.push(mermaidCompact);
    parts.push('```\n');
    parts.push('<details><summary>Text fallback</summary>\n');
    parts.push(textTable);
    parts.push('\n</details>\n');
    if (actions) { parts.push(actions); }

    return {
        timestamp,
        header,
        activeItems,
        mermaidCompact,
        mermaidDetailed,
        textTable,
        actions,
        queueInfo,
        markdown: parts.join('\n'),
    };
}

/**
 * Generate a detailed snapshot (includes task-level Mermaid).
 */
export function generateDetailedSnapshot(state: RunStateData): StatusSnapshot {
    const snapshot = generateSnapshot(state);

    if (snapshot.mermaidDetailed) {
        // Insert detailed diagram after compact
        const detailedSection = [
            '\n### Detailed Task Graph\n',
            '```mermaid',
            snapshot.mermaidDetailed,
            '```\n',
        ].join('\n');

        snapshot.markdown = snapshot.markdown.replace(
            '<details><summary>Text fallback</summary>',
            detailedSection + '\n<details><summary>Text fallback</summary>'
        );
    }

    return snapshot;
}

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function buildHeader(state: RunStateData, now: Date): string {
    const elapsed = formatElapsed(now.getTime() - new Date(state.startedAt).getTime());
    const lastUpdated = formatTimeAgo(now.getTime() - new Date(state.lastUpdatedAt).getTime());
    const statusEmoji = getStatusEmoji(state.status);

    const lines: string[] = [];
    lines.push(`## ${statusEmoji} Johann Run Status\n`);
    lines.push(`| Field | Value |`);
    lines.push(`|-------|-------|`);
    lines.push(`| **Run** | \`${state.runId}\` |`);
    lines.push(`| **Status** | ${state.status} |`);
    lines.push(`| **Elapsed** | ${elapsed} |`);
    lines.push(`| **Last updated** | ${lastUpdated} ago |`);
    lines.push(`| **Queued** | ${state.counters.queued} |`);
    lines.push(`| **Running** | ${state.counters.running} |`);
    lines.push(`| **Done** | ${state.counters.done} |`);
    lines.push(`| **Failed** | ${state.counters.failed} |`);
    lines.push('');

    if (state.planSummary) {
        lines.push(`**Plan:** ${state.planSummary}\n`);
    }

    return lines.join('\n');
}

function buildActiveItems(state: RunStateData): string {
    const running = state.tasks.filter(t => t.status === 'running').slice(0, 10);
    const queued = state.tasks.filter(t => t.status === 'queued').slice(0, 5);

    if (running.length === 0 && queued.length === 0) {
        return '';
    }

    const lines: string[] = [];
    lines.push('### Active Items\n');

    if (running.length > 0) {
        lines.push('**Running:**');
        for (const t of running) {
            const model = t.model ? ` · \`${t.model}\`` : '';
            const msg = t.progressMessage ? ` — ${t.progressMessage}` : '';
            lines.push(`- 🔄 **${t.title}**${model}${msg}`);
        }
        lines.push('');
    }

    if (queued.length > 0) {
        const remaining = state.counters.queued - queued.length;
        lines.push('**Next up:**');
        for (const t of queued) {
            lines.push(`- ⏳ ${t.title}`);
        }
        if (remaining > 0) {
            lines.push(`- *…and ${remaining} more*`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function buildQueueInfo(state: RunStateData): string {
    const pending = state.userQueue.filter(q => !q.integrated);
    if (pending.length === 0) { return ''; }

    const lines: string[] = [];
    lines.push('### Queued User Requests\n');
    for (const q of pending) {
        lines.push(`${q.position}. "${q.message.substring(0, 80)}${q.message.length > 80 ? '…' : ''}" *(queued ${formatTimeAgo(Date.now() - new Date(q.enqueuedAt).getTime())} ago)*`);
    }
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mermaid generators
// ---------------------------------------------------------------------------

/**
 * Build a compact phase-level Mermaid flowchart.
 * Clusters tasks by phase and shows aggregate status per phase.
 */
function buildCompactMermaid(state: RunStateData): string {
    // Assign phases to tasks
    const phaseMap = assignPhases(state.tasks);

    // Determine phase order
    const phaseOrder: RunPhase[] = [
        'discovery', 'planning', 'delegation', 'implementation', 'verification', 'packaging',
    ];

    // Build phase summaries
    const phases: Array<{ phase: RunPhase; label: string; status: string; emoji: string }> = [];

    for (const phase of phaseOrder) {
        const phaseTasks = phaseMap.get(phase);
        if (!phaseTasks || phaseTasks.length === 0) { continue; }

        const counts = countStatuses(phaseTasks);
        const phaseStat = getPhaseStatus(counts, phaseTasks.length);

        phases.push({
            phase,
            label: capitalizeFirst(phase),
            status: phaseStat.label,
            emoji: phaseStat.emoji,
        });
    }

    // Handle case where no phases are assigned — use flat mode
    if (phases.length === 0) {
        return buildFlatMermaid(state);
    }

    // Build flowchart
    const lines: string[] = [];
    lines.push('flowchart TD');

    for (let i = 0; i < phases.length; i++) {
        const p = phases[i];
        const nodeId = `P${i}`;
        const style = getNodeStyle(p.status);
        lines.push(`    ${nodeId}["${p.emoji} ${p.label}: ${p.status}"]${style}`);
        if (i > 0) {
            lines.push(`    P${i - 1} --> ${nodeId}`);
        }
    }

    return lines.join('\n');
}

/**
 * Build a flat Mermaid flowchart when phases are not assigned.
 */
function buildFlatMermaid(state: RunStateData): string {
    const lines: string[] = [];
    lines.push('flowchart TD');

    // Show planning and overall status
    const planDone = state.planSummary ? true : false;
    const planEmoji = planDone ? '✅' : (state.status === 'running' ? '🔄' : '⏳');
    lines.push(`    PLAN["${planEmoji} Planning"]`);

    if (state.tasks.length > 0) {
        const counts = countStatuses(state.tasks);
        const total = state.tasks.length;
        const done = counts.done;
        const running = counts.running;
        const failed = counts.failed;
        const queued = counts.queued;

        let execLabel: string;
        let execEmoji: string;

        if (done === total) {
            execEmoji = '✅';
            execLabel = `All ${total} done`;
        } else if (failed > 0 && running === 0 && queued === 0) {
            execEmoji = '❌';
            execLabel = `${done}/${total} done, ${failed} failed`;
        } else {
            execEmoji = '🔄';
            execLabel = `${running} running, ${done} done, ${queued} queued`;
        }

        lines.push(`    EXEC["${execEmoji} Execution: ${execLabel}"]`);
        lines.push(`    PLAN --> EXEC`);

        // Merge/verify phase
        if (done === total || (done > 0 && queued === 0 && running === 0)) {
            const mergeEmoji = state.status === 'completed' ? '✅' : '🔄';
            lines.push(`    MERGE["${mergeEmoji} Merge & Verify"]`);
            lines.push(`    EXEC --> MERGE`);
        }
    }

    return lines.join('\n');
}

/**
 * Build a detailed task-level Mermaid flowchart.
 * Capped at 30 nodes to prevent overwhelming diagrams.
 */
function buildDetailedMermaid(state: RunStateData): string {
    if (state.tasks.length === 0) { return ''; }
    if (state.tasks.length > 30) {
        // Too many tasks — return compact instead
        return '';
    }

    const lines: string[] = [];
    lines.push('flowchart TD');

    for (const task of state.tasks) {
        const emoji = getTaskEmoji(task.status);
        const nodeId = sanitizeMermaidId(task.id);
        const label = task.title.substring(0, 40) + (task.title.length > 40 ? '…' : '');
        lines.push(`    ${nodeId}["${emoji} ${escapeMermaid(label)}"]`);
    }

    // We don't have dependency info in RunTask, so show a linear flow
    // Tasks are ordered by creation, which should follow the execution plan
    for (let i = 1; i < state.tasks.length; i++) {
        const prev = sanitizeMermaidId(state.tasks[i - 1].id);
        const curr = sanitizeMermaidId(state.tasks[i].id);
        lines.push(`    ${prev} --> ${curr}`);
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Text table
// ---------------------------------------------------------------------------

function buildTextTable(state: RunStateData): string {
    if (state.tasks.length === 0) {
        return '*No tasks registered yet.*';
    }

    const lines: string[] = [];
    lines.push('| Task | Status | Summary | Files |');
    lines.push('|------|--------|---------|-------|');

    for (const t of state.tasks) {
        const statusIcon = getTaskEmoji(t.status);
        const summary = t.progressMessage || '—';
        const files = t.artifacts.length > 0 ? String(t.artifacts.length) : '—';
        lines.push(`| ${t.id} | ${statusIcon} ${t.status} | ${summary} | ${files} |`);
    }

    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function buildActions(state: RunStateData): string {
    if (state.status === 'completed' || state.status === 'failed') {
        return '';
    }

    const lines: string[] = [];
    lines.push('### Actions\n');
    lines.push('- Say **"@johann status"** for a fresh snapshot');
    lines.push('- Say **"Add task: …"** to queue a new task');
    if (state.status === 'running') {
        lines.push('- Press **Stop** to cancel the current run');
    }
    lines.push('- Use `/tasks` to view background task details');
    lines.push('');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Phase assignment heuristics
// ---------------------------------------------------------------------------

/**
 * Assign orchestration phases to tasks based on their properties.
 */
function assignPhases(tasks: RunTask[]): Map<RunPhase, RunTask[]> {
    const phaseMap = new Map<RunPhase, RunTask[]>();

    for (const task of tasks) {
        const phase = task.phase || inferPhase(task);

        if (!phaseMap.has(phase)) {
            phaseMap.set(phase, []);
        }
        phaseMap.get(phase)!.push(task);
    }

    return phaseMap;
}

/**
 * Infer a phase from task title/id using keyword heuristics.
 */
function inferPhase(task: RunTask): RunPhase {
    const title = task.title.toLowerCase();

    if (title.includes('scan') || title.includes('discover') || title.includes('analyze') || title.includes('explore')) {
        return 'discovery';
    }
    if (title.includes('plan') || title.includes('design') || title.includes('architect')) {
        return 'planning';
    }
    if (title.includes('delegate') || title.includes('assign') || title.includes('dispatch')) {
        return 'delegation';
    }
    if (title.includes('test') || title.includes('verify') || title.includes('validate') || title.includes('check') || title.includes('lint')) {
        return 'verification';
    }
    if (title.includes('package') || title.includes('deploy') || title.includes('publish') || title.includes('report') || title.includes('document')) {
        return 'packaging';
    }

    // Default: implementation
    return 'implementation';
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function getStatusEmoji(status: string): string {
    switch (status) {
        case 'idle': return '⏸️';
        case 'running': return '🔄';
        case 'cancelling': return '⏹️';
        case 'completed': return '✅';
        case 'failed': return '❌';
        default: return '❓';
    }
}

function getTaskEmoji(status: TaskStatus): string {
    switch (status) {
        case 'queued': return '⏳';
        case 'running': return '🔄';
        case 'done': return '✅';
        case 'failed': return '❌';
        case 'cancelled': return '⏹️';
        default: return '❓';
    }
}

function getPhaseStatus(counts: { queued: number; running: number; done: number; failed: number }, total: number): { label: string; emoji: string } {
    if (counts.done === total) {
        return { label: `${total} done`, emoji: '✅' };
    }
    if (counts.running > 0) {
        return { label: `${counts.running} running, ${counts.done}/${total} done`, emoji: '🔄' };
    }
    if (counts.failed > 0 && counts.queued === 0 && counts.running === 0) {
        return { label: `${counts.failed} failed`, emoji: '❌' };
    }
    if (counts.queued === total) {
        return { label: `${total} queued`, emoji: '⏳' };
    }
    return { label: `${counts.done}/${total} done`, emoji: '⏳' };
}

function getNodeStyle(status: string): string {
    // Mermaid class styling is complex — use shape hints instead
    if (status.startsWith('✅')) { return ''; }
    if (status.startsWith('🔄')) { return ''; }
    if (status.startsWith('❌')) { return ''; }
    return '';
}

function countStatuses(tasks: RunTask[]): { queued: number; running: number; done: number; failed: number } {
    return {
        queued: tasks.filter(t => t.status === 'queued').length,
        running: tasks.filter(t => t.status === 'running').length,
        done: tasks.filter(t => t.status === 'done').length,
        failed: tasks.filter(t => t.status === 'failed').length,
    };
}

function formatElapsed(ms: number): string {
    if (ms < 1000) { return '<1s'; }
    if (ms < 60_000) { return `${Math.round(ms / 1000)}s`; }
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    if (mins < 60) {
        return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    }
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function formatTimeAgo(ms: number): string {
    if (ms < 1000) { return '<1s'; }
    if (ms < 60_000) { return `${Math.round(ms / 1000)}s`; }
    const mins = Math.floor(ms / 60_000);
    if (mins < 60) { return `${mins}m`; }
    const hours = Math.floor(mins / 60);
    return `${hours}h`;
}

function capitalizeFirst(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function sanitizeMermaidId(id: string): string {
    // Mermaid IDs must be alphanumeric + dashes/underscores
    return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function escapeMermaid(text: string): string {
    // Escape characters that break Mermaid syntax
    return text
        .replace(/"/g, "'")
        .replace(/[[\]{}()]/g, '')
        .replace(/[<>]/g, '');
}
