import * as vscode from 'vscode';
import { searchMemory, formatSearchResults } from './memorySearch';
import { getConfig, formatConfig, getCopilotAgentSettings, formatCopilotSettings } from './config';
import { listDailyNotes, readDailyNotes } from './dailyNotes';
import { listSessions, getRecentSessionsSummary } from './sessionTranscript';

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
}

/**
 * Parse and execute a directive if the message starts with "/".
 * Returns undefined if the message is NOT a directive.
 */
export async function handleDirective(
    message: string,
    response: vscode.ChatResponseStream
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
            return await handleStatus(response);
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
        default:
            response.markdown(`Unknown directive: \`${command}\`. Type \`/help\` for available commands.\n`);
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
| \`/status\` | Show Johann's current state and info |
| \`/compact\` | Compact status summary |
| \`/memory\` | Show curated memory (MEMORY.md) |
| \`/search <query>\` | Search memory for keywords |
| \`/config\` | Show current configuration |
| \`/notes [date]\` | Show daily notes (today or specific date) |
| \`/sessions\` | List recent sessions |
| \`/yolo [on\\|off]\` | Toggle YOLO mode (maximum autonomy) |

`;

    response.markdown(output);
    return { isDirective: true, handled: true, output };
}

async function handleStatus(response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    const config = getConfig();
    const dailyNoteDates = await listDailyNotes();
    const sessions = await listSessions();

    const lines: string[] = [];
    lines.push('## Johann Status\n');
    lines.push(`- **Memory directory:** \`${config.memoryDir}\``);
    lines.push(`- **Daily notes:** ${dailyNoteDates.length} files`);
    lines.push(`- **Sessions recorded:** ${sessions.length}`);
    lines.push(`- **Heartbeat:** ${config.heartbeatEnabled ? `enabled (${config.heartbeatIntervalMinutes}min)` : 'disabled'}`);
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
    const activeSessions = sessions.filter(s => s.active);

    const output = `**Johann** | Notes: ${dailyNoteDates.length} | Sessions: ${sessions.length} (${activeSessions.length} active) | Heartbeat: ${config.heartbeatEnabled ? 'on' : 'off'} | Mode: ${config.promptMode}\n`;

    response.markdown(output);
    return { isDirective: true, handled: true, output };
}

async function handleMemory(args: string, response: vscode.ChatResponseStream): Promise<DirectiveResult> {
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

async function handleSearch(query: string, response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    if (!query.trim()) {
        response.markdown('Usage: `/search <keywords>`\n');
        return { isDirective: true, handled: true };
    }

    const results = await searchMemory(query);
    const output = formatSearchResults(results);
    response.markdown(output + '\n');
    return { isDirective: true, handled: true, output };
}

async function handleConfigDirective(response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    const output = formatConfig();
    response.markdown(output + '\n');
    return { isDirective: true, handled: true, output };
}

async function handleNotes(args: string, response: vscode.ChatResponseStream): Promise<DirectiveResult> {
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

async function handleYolo(args: string, response: vscode.ChatResponseStream): Promise<DirectiveResult> {
    const copilot = getCopilotAgentSettings();
    const arg = args.trim().toLowerCase();

    if (arg === 'on' || arg === 'enable') {
        // Guide the user to enable YOLO mode in Copilot settings
        const output = `## Enabling YOLO Mode

YOLO mode is controlled by **GitHub Copilot's settings**, not Johann. To enable maximum autonomy:

### Add to your \`.vscode/settings.json\`:

\`\`\`json
{
  "github.copilot.chat.agent.autoApprove": true,
  "github.copilot.chat.agent.maxRequests": 200
}
\`\`\`

Or open **Settings** → search for \`copilot agent\` and configure there.

### What these do:
- **autoApprove** — Skips the "Allow" confirmation before each terminal command or file edit
- **maxRequests** — How many LLM requests Copilot allows before pausing with a "Continue?" prompt. Set high (100–200) for complex orchestrations.

### Current Copilot settings:
${formatCopilotSettings()}

${copilot.autoApprove && copilot.maxRequests >= 100
    ? '✅ Your Copilot settings already look good for YOLO mode.'
    : '⚠️ Your Copilot settings may cause Johann to stall on confirmation prompts during complex orchestrations.'}

### Also consider raising Johann's orchestration limits:
\`\`\`json
{
  "johann.maxSubtasks": 20,
  "johann.maxAttempts": 5
}
\`\`\`
`;
        response.markdown(output);
        return { isDirective: true, handled: true, output };
    }

    if (arg === 'off' || arg === 'disable') {
        const output = `## Disabling YOLO Mode

To restore confirmation prompts, update your \`.vscode/settings.json\`:

\`\`\`json
{
  "github.copilot.chat.agent.autoApprove": false,
  "github.copilot.chat.agent.maxRequests": 30
}
\`\`\`

Or open **Settings** → search for \`copilot agent\` and change there.

### Current Copilot settings:
${formatCopilotSettings()}
`;
        response.markdown(output);
        return { isDirective: true, handled: true, output };
    }

    // No argument — show current status
    const yoloActive = copilot.autoApprove && copilot.maxRequests >= 100;
    const yoloStatus = yoloActive ? '🟢 **ACTIVE**' : '⚪ **INACTIVE**';

    const output = `## YOLO Mode: ${yoloStatus}

YOLO mode is determined by your **GitHub Copilot settings** — Johann reads them but doesn't own them.

${formatCopilotSettings()}

${yoloActive
    ? 'Copilot is configured for maximum autonomy. Johann can run long orchestrations without confirmation prompts.'
    : `Copilot may pause Johann for confirmation during complex tasks. To enable YOLO mode, type \`/yolo on\` for setup instructions.`}

### Usage:
- \`/yolo\` — Show current YOLO status
- \`/yolo on\` — Show how to enable maximum autonomy
- \`/yolo off\` — Show how to restore confirmation prompts
`;
    response.markdown(output);
    return { isDirective: true, handled: true, output };
}
