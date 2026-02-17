import * as vscode from 'vscode';
import { searchMemory, formatSearchResults } from './memorySearch';
import {
    getConfig,
    formatConfig,
    getCopilotAgentSettings,
    formatCopilotSettings,
    setCopilotAgentSettings,
} from './config';
import { listDailyNotes, readDailyNotes } from './dailyNotes';
import { listSessions, getRecentSessionsSummary } from './sessionTranscript';
import { SessionPersistence, ResumableSession } from './sessionPersistence';
import { BackgroundTaskManager } from './backgroundTaskManager';
import { RunStateManager } from './runState';
import { generateSnapshot, generateDetailedSnapshot } from './statusSnapshot';

// ============================================================================
// DIRECTIVES — Slash command / directive parsing for Johann
//
// Inspired by OpenClaw's system directives:
// Parses messages that start with "/" as directives rather than normal requests.
//
// Supported directives:
//   /status    — Show Johann's current state, memory, and config
//   /memory    — Show or search memory
//   /compact   — Show compact status (minimal output)
//   /config    — Show current configuration
//   /search    — Search memory for keywords
//   /notes     — Show today's daily notes or a specific date
//   /sessions  — List recent sessions
//   /yolo      — Toggle YOLO mode (maximum autonomy)
//   /help      — Show available directives
// ============================================================================

/**
 * Result of parsing a directive.
 */
export interface DirectiveResult {
    /** Whether the message was a directive */
    isDirective: boolean;
    /** Whether the directive was handled (false = unknown directive) */
    handled: boolean;
    /** The output to send to the response stream */
    output?: string;
    /** If the directive is /resume, carries the session to resume */
    resumeSession?: ResumableSession;
}

/**
 * Parse and execute a directive if the message starts with "/".
 * Returns undefined if the message is NOT a directive.
 */
export async function handleDirective(
    message: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    const trimmed = message.trim();

    // Not a directive
    if (!trimmed.startsWith('/')) {
        return { isDirective: false, handled: false };
    }

    const parts = trimmed.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    switch (command) {
        case '/help':
            return await handleHelp(response);
        case '/status':
            return await handleStatus(response, args);
        case '/compact':
            return await handleCompact(response);
        case '/memory':
            return await handleMemory(args, response);
        case '/search':
            return await handleSearch(args, response);
        case '/config':
            return await handleConfigDirective(response);
        case '/notes':
            return await handleNotes(args, response);
        case '/sessions':
            return await handleSessions(response);
        case '/yolo':
            return await handleYolo(args, response);
        case '/resume':
            return await handleResume(args, response);
        case '/tasks':
            return await handleTasks(args, response);
        default:
            response.markdown(
                `Unknown directive: \`${command}\`. Type \`/help\` for available commands.\n`,
            );
            return { isDirective: true, handled: false };
    }
}

// ============================================================================
// DIRECTIVE HANDLERS
// ============================================================================

async function handleHelp(response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    const output = `## Johann Directives

| Command | Description |
|---------|-------------|
| \`/help\` | Show this help |
| \`/status\` | Show live run status with workflow diagram |
| \`/status detailed\` | Show detailed task-level diagram |
| \`/compact\` | Compact status summary |
| \`/memory\` | Show curated memory (MEMORY.md) |
| \`/search <query>\` | Search memory for keywords |
| \`/config\` | Show current configuration |
| \`/notes [date]\` | Show daily notes (today or specific date) |
| \`/sessions\` | List recent sessions |
| \`/yolo [on\\|off]\` | Toggle YOLO mode (maximum autonomy) |
| \`/resume [id] [message]\` | Resume a session, optionally with a course-correction message |
| \`/tasks [task-id]\` | View background tasks |

**While a run is active:**
- Say \`@johann status\` for a live snapshot
- Say \`Add task: <description>\` to queue work during a run

`;

    response.markdown(output);
    return { isDirective: true, handled: true, output };
}

async function handleStatus(
    response: vscode.ChatResponseStream,
    args?: string,
): Promise<DirectiveResult> {
    // If a run is active, show a live RunState snapshot
    const runManager = RunStateManager.getInstance();
    const runState = runManager.getState();

    if (runState && (runState.status === 'running' || runState.status === 'cancelling')) {
        const isDetailed = args?.trim().toLowerCase() === 'detailed';
        const snapshot = isDetailed
            ? generateDetailedSnapshot(runState)
            : generateSnapshot(runState);

        // Record that a snapshot was taken (for throttle)
        await runManager.recordSnapshot();

        response.markdown(snapshot.markdown);

        // Add action buttons
        response.button({
            command: 'workbench.view.scm',
            title: '$(git-compare) Changed Files',
        });
        response.button({
            command: 'johann.showLog',
            title: '$(output) Output Log',
        });

        return { isDirective: true, handled: true, output: snapshot.markdown };
    }

    // No active run — show general Johann status
    const config = getConfig();
    const dailyNoteDates = await listDailyNotes();
    const sessions = await listSessions();

    const lines: string[] = [];
    lines.push('## Johann Status\n');

    // Show last completed run if available
    if (runState && (runState.status === 'completed' || runState.status === 'failed')) {
        const statusEmoji = runState.status === 'completed' ? '✅' : '❌';
        lines.push(`### Last Run: ${statusEmoji} ${runState.status}\n`);
        lines.push(`- **Run ID:** \`${runState.runId}\``);
        if (runState.planSummary) {
            lines.push(`- **Plan:** ${runState.planSummary}`);
        }
        lines.push(
            `- **Tasks:** ${runState.counters.done} done, ${runState.counters.failed} failed`,
        );
        lines.push('');
    }

    lines.push(`- **Memory directory:** \`${config.memoryDir}\``);
    lines.push(`- **Daily notes:** ${dailyNoteDates.length} files`);
    lines.push(`- **Sessions recorded:** ${sessions.length}`);
    lines.push(
        `- **Heartbeat:** ${config.heartbeatEnabled ? `enabled (${config.heartbeatIntervalMinutes}min)` : 'disabled'}`,
    );
    lines.push(`- **Transcripts:** ${config.transcriptsEnabled ? 'enabled' : 'disabled'}`);
    lines.push(`- **Prompt mode:** ${config.promptMode}`);
    lines.push(`- **Max subtasks:** ${config.maxSubtasks}`);
    lines.push(`- **Max attempts:** ${config.maxAttempts}`);
    lines.push('');

    if (dailyNoteDates.length > 0) {
        lines.push('### Recent Daily Notes');
        for (const date of dailyNoteDates.slice(0, 5)) {
            lines.push(`- ${date}`);
        }
        lines.push('');
    }

    if (sessions.length > 0) {
        lines.push('### Recent Sessions');
        for (const s of sessions.slice(0, 5)) {
            const status = s.active ? '🟢' : '⚪';
            lines.push(`- ${status} ${s.startedAt} — ${s.summary || s.sessionId}`);
        }
        lines.push('');
    }

    const output = lines.join('\n');
    response.markdown(output);
    return { isDirective: true, handled: true, output };
}

async function handleCompact(response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    const config = getConfig();
    const dailyNoteDates = await listDailyNotes();
    const sessions = await listSessions();
    const activeSessions = sessions.filter((s) => s.active);

    const output = `**Johann** | Notes: ${dailyNoteDates.length} | Sessions: ${sessions.length} (${activeSessions.length} active) | Heartbeat: ${config.heartbeatEnabled ? 'on' : 'off'} | Mode: ${config.promptMode}\n`;

    response.markdown(output);
    return { isDirective: true, handled: true, output };
}

async function handleMemory(
    args: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    // If args provided, treat as a search
    if (args.trim()) {
        return handleSearch(args, response);
    }

    // Otherwise show MEMORY.md content
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
        response.markdown('No workspace open.\n');
        return { isDirective: true, handled: true };
    }

    const memoryUri = vscode.Uri.joinPath(folders[0].uri, '.vscode', 'johann', 'MEMORY.md');
    try {
        const bytes = await vscode.workspace.fs.readFile(memoryUri);
        const content = new TextDecoder().decode(bytes);
        response.markdown(content + '\n');
        return { isDirective: true, handled: true, output: content };
    } catch {
        response.markdown('No MEMORY.md found. Memory is empty.\n');
        return { isDirective: true, handled: true };
    }
}

async function handleSearch(
    query: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    if (!query.trim()) {
        response.markdown('Usage: `/search <keywords>`\n');
        return { isDirective: true, handled: true };
    }

    const results = await searchMemory(query);
    const output = formatSearchResults(results);
    response.markdown(output + '\n');
    return { isDirective: true, handled: true, output };
}

async function handleConfigDirective(
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    const output = formatConfig();
    response.markdown(output + '\n');
    return { isDirective: true, handled: true, output };
}

async function handleNotes(
    args: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    const dateArg = args.trim();

    if (dateArg) {
        // Show notes for a specific date
        const content = await readDailyNotes(dateArg);
        if (content) {
            response.markdown(content + '\n');
        } else {
            response.markdown(`No daily notes found for ${dateArg}.\n`);
        }
        return { isDirective: true, handled: true, output: content };
    }

    // Show today's notes or list recent dates
    const today = new Date().toISOString().split('T')[0];
    const content = await readDailyNotes(today);

    if (content) {
        response.markdown(content + '\n');
    } else {
        const dates = await listDailyNotes();
        if (dates.length > 0) {
            response.markdown(`No notes for today (${today}). Recent notes:\n`);
            for (const d of dates.slice(0, 10)) {
                response.markdown(`- \`/notes ${d}\`\n`);
            }
        } else {
            response.markdown('No daily notes found.\n');
        }
    }

    return { isDirective: true, handled: true, output: content };
}

async function handleSessions(response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    const output = await getRecentSessionsSummary(10);
    if (output) {
        response.markdown(output + '\n');
    } else {
        response.markdown('No session transcripts found.\n');
    }
    return { isDirective: true, handled: true, output };
}

async function handleResume(
    args: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    const resumable = await SessionPersistence.findResumable();

    if (resumable.length === 0) {
        response.markdown('No interrupted sessions found to resume.\n');
        return { isDirective: true, handled: true };
    }

    const argParts = args.trim().split(/\s+/);
    const firstArg = argParts[0] || '';

    // Check if the first arg is a session ID or a message
    let targetSession: ResumableSession | undefined;
    let resumeMessage = '';

    if (firstArg) {
        // Try to match it as a session ID
        const match = resumable.find(
            (s) => s.sessionId === firstArg || s.sessionId.endsWith(firstArg),
        );
        if (match) {
            targetSession = match;
            // Everything after the session ID is the message
            resumeMessage = argParts.slice(1).join(' ').trim();
        } else {
            // Not a session ID — treat the ENTIRE args as a message for the most recent session
            targetSession = resumable[0];
            resumeMessage = args.trim();
        }
    } else {
        // No args at all — pick the most recent (or only) session
        targetSession = resumable[0];
    }

    if (!targetSession) {
        response.markdown('No resumable session found.\n');
        return { isDirective: true, handled: true };
    }

    // Attach the resume message so the orchestrator can use it
    if (resumeMessage) {
        targetSession.resumeMessage = resumeMessage;
    }

    const completed = targetSession.completedSubtaskIds.length;
    const total = completed + targetSession.pendingSubtaskIds.length;

    if (resumable.length > 1 && !firstArg) {
        response.markdown(
            `Found ${resumable.length} interrupted sessions. Resuming the most recent:\n\n`,
        );
    } else if (resumable.length === 1 && !firstArg) {
        response.markdown(`Found 1 interrupted session. Resuming automatically.\n\n`);
    }

    response.markdown(
        `**Session:** \`${targetSession.sessionId}\`\n` +
            `**Request:** ${targetSession.originalRequest.substring(0, 120)}\n` +
            `**Progress:** ${completed}/${total} subtasks completed\n`,
    );

    if (resumeMessage) {
        response.markdown(`**Course correction:** ${resumeMessage}\n`);
    }

    response.markdown('\n');

    // Show other resumable sessions if any
    if (resumable.length > 1) {
        const others = resumable.filter((s) => s.sessionId !== targetSession!.sessionId);
        if (others.length > 0) {
            response.markdown('Other resumable sessions:\n');
            for (const s of others.slice(0, 4)) {
                const c = s.completedSubtaskIds.length;
                const t = c + s.pendingSubtaskIds.length;
                response.markdown(
                    `- \`/resume ${s.sessionId}\` — ${s.originalRequest.substring(0, 60)} (${c}/${t} done)\n`,
                );
            }
            response.markdown('\n');
        }
    }

    return { isDirective: true, handled: true, resumeSession: targetSession };
}

async function handleYolo(
    args: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    const copilot = getCopilotAgentSettings();
    const config = getConfig();
    const arg = args.trim().toLowerCase();
    const tokens = arg.split(/\s+/).filter(Boolean);
    const mode = tokens[0] || '';
    const target = tokens.includes('global')
        ? vscode.ConfigurationTarget.Global
        : vscode.ConfigurationTarget.Workspace;
    const targetLabel =
        target === vscode.ConfigurationTarget.Global ? 'User (global)' : 'Workspace';

    const statusBlock = () => {
        const yoloActive = copilot.autoApprove && copilot.maxRequests >= 100;
        const yoloStatus = yoloActive ? '🟢 **ACTIVE**' : '⚪ **INACTIVE**';
        return `## YOLO Mode: ${yoloStatus}\n\n${formatCopilotSettings()}`;
    };

    if (mode === 'on' || mode === 'enable') {
        try {
            await setCopilotAgentSettings(true, config.yoloMaxRequests, target);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const output = `## Failed to Enable YOLO Mode\n\nCould not update Copilot settings automatically: ${errMsg}\n\n### Set these manually:\n\n\`\`\`json\n{\n  "github.copilot.chat.agent.autoApprove": true,\n  "github.copilot.chat.agent.maxRequests": ${config.yoloMaxRequests}\n}\n\`\`\``;
            response.markdown(output);
            return { isDirective: true, handled: true, output };
        }

        const updated = getCopilotAgentSettings();
        const yoloActive = updated.autoApprove && updated.maxRequests >= 100;
        const output = `## YOLO Mode Enabled\n\nApplied settings to **${targetLabel}** scope:\n- \`github.copilot.chat.agent.autoApprove\` = \`true\`\n- \`github.copilot.chat.agent.maxRequests\` = \`${config.yoloMaxRequests}\`\n\n${formatCopilotSettings()}\n\n### How YOLO Works\n- **Copilot settings are the autonomy gate** (approval prompts + request-limit pauses).\n- **Johann settings are runtime safeguards** (timeouts, long-command backgrounding, orchestration limits).\n\n${
            yoloActive
                ? '✅ Johann should now run with minimal confirmation friction, including fewer manual "Continue" interruptions.'
                : '⚠️ Settings were written, but YOLO does not appear fully active yet. Check for overrides in other scopes.'
        }\n\nTip: use \`/yolo on global\` to apply this to all workspaces.`;
        response.markdown(output);
        return { isDirective: true, handled: true, output };
    }

    if (mode === 'off' || mode === 'disable') {
        try {
            await setCopilotAgentSettings(false, 30, target);
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const output = `## Failed to Disable YOLO Mode\n\nCould not update Copilot settings automatically: ${errMsg}`;
            response.markdown(output);
            return { isDirective: true, handled: true, output };
        }

        const output = `## YOLO Mode Disabled\n\nApplied settings to **${targetLabel}** scope:\n- \`github.copilot.chat.agent.autoApprove\` = \`false\`\n- \`github.copilot.chat.agent.maxRequests\` = \`30\`\n\n${formatCopilotSettings()}\n\n### How YOLO Works\n- **Copilot settings are the autonomy gate** (approval prompts + request-limit pauses).\n- **Johann settings are runtime safeguards** (timeouts, long-command backgrounding, orchestration limits).\n\nConfirmation prompts are now restored.`;
        response.markdown(output);
        return { isDirective: true, handled: true, output };
    }

    const yoloActive = copilot.autoApprove && copilot.maxRequests >= 100;
    const output = `${statusBlock()}\n\n### How YOLO Works\n- **Copilot settings are the autonomy gate** (approval prompts + request-limit pauses).\n- **Johann settings are runtime safeguards** (timeouts, long-command backgrounding, orchestration limits).\n\n${
        yoloActive
            ? 'Copilot is configured for high-autonomy orchestration.'
            : 'Copilot may still interrupt long runs with approval or continue prompts.'
    }\n\n### Usage:\n- \`/yolo\` — Show current YOLO status\n- \`/yolo on\` — Enable YOLO in workspace settings\n- \`/yolo on global\` — Enable YOLO in user settings\n- \`/yolo off\` — Disable YOLO in workspace settings\n- \`/yolo off global\` — Disable YOLO in user settings`;
    response.markdown(output);
    return { isDirective: true, handled: true, output };
}

async function handleTasks(
    args: string,
    response: vscode.ChatResponseStream,
): Promise<DirectiveResult> {
    const taskManager = BackgroundTaskManager.getInstance();

    // If task ID provided, show specific task
    if (args.trim()) {
        const taskId = args.trim();
        const summary = taskManager.getTaskSummary(taskId);
        response.markdown(summary);
        return { isDirective: true, handled: true, output: summary };
    }

    // Otherwise, show all tasks
    const allTasks = taskManager.getAllTasks();

    if (allTasks.length === 0) {
        const output = '## Background Tasks\n\nNo active or completed background tasks.\n';
        response.markdown(output);
        return { isDirective: true, handled: true, output };
    }

    const lines: string[] = [];
    lines.push('## Background Tasks\n');

    // Group by status
    const running = allTasks.filter((t) => t.status === 'running');
    const paused = allTasks.filter((t) => t.status === 'paused');
    const completed = allTasks.filter((t) => t.status === 'completed');
    const failed = allTasks.filter((t) => t.status === 'failed');
    const cancelled = allTasks.filter((t) => t.status === 'cancelled');

    if (running.length > 0) {
        lines.push(`### $(sync~spin) Running (${running.length})\n`);
        for (const task of running) {
            const progress = task.progress?.percentage ?? 0;
            lines.push(`- **${task.sessionId}** — ${progress}%`);
            lines.push(`  - ${task.summary}`);
            lines.push(`  - Phase: ${task.progress?.phase || 'unknown'}`);
            lines.push('');
        }
    }

    if (paused.length > 0) {
        lines.push(`### $(debug-pause) Paused (${paused.length})\n`);
        for (const task of paused) {
            lines.push(`- **${task.sessionId}**`);
            lines.push(`  - ${task.summary}`);
            lines.push('');
        }
    }

    if (completed.length > 0) {
        lines.push(`### $(check) Completed (${completed.length})\n`);
        for (const task of completed) {
            lines.push(`- **${task.sessionId}**`);
            lines.push(`  - ${task.summary}`);
            const startTime = new Date(task.startedAt);
            const endTime = task.completedAt ? new Date(task.completedAt) : new Date();
            const duration = Math.round((endTime.getTime() - startTime.getTime()) / 1000);
            lines.push(`  - Duration: ${duration}s`);
            lines.push('');
        }
    }

    if (failed.length > 0) {
        lines.push(`### $(error) Failed (${failed.length})\n`);
        for (const task of failed) {
            lines.push(`- **${task.sessionId}**`);
            lines.push(`  - ${task.summary}`);
            if (task.error) {
                lines.push(`  - Error: ${task.error.substring(0, 100)}`);
            }
            lines.push('');
        }
    }

    if (cancelled.length > 0) {
        lines.push(`### $(circle-slash) Cancelled (${cancelled.length})\n`);
        for (const task of cancelled) {
            lines.push(`- **${task.sessionId}**`);
            lines.push(`  - ${task.summary}`);
            lines.push('');
        }
    }

    lines.push('---\n');
    lines.push('**Commands:**\n');
    lines.push(`- \`/tasks <task-id>\` — View details for a specific task\n`);
    lines.push(
        `- Run \`Johann: Show Background Tasks\` from command palette for interactive view\n`,
    );
    lines.push(`- Run \`Johann: Cancel Background Task\` to stop a running task\n`);

    const output = lines.join('\n');
    response.markdown(output);
    return { isDirective: true, handled: true, output };
}
