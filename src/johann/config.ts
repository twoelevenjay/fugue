import * as vscode from 'vscode';

// ============================================================================
// CONFIGURATION — VS Code settings-based configuration for Johann
//
// All configuration flows through VS Code's settings system:
// - User settings (global)
// - Workspace settings (.vscode/settings.json)
// - Defaults defined here
//
// Config key prefix: johann.*
// ============================================================================

/**
 * The full Johann configuration interface.
 */
export interface JohannConfig {
    /** Maximum subtasks per orchestration plan */
    maxSubtasks: number;
    /** Maximum attempts per subtask before giving up */
    maxAttempts: number;
    /** Whether to allow parallel subtask execution */
    allowParallel: boolean;
    /** Whether to use git worktrees for parallel subtask isolation */
    useWorktrees: boolean;
    /** Memory directory relative to workspace root */
    memoryDir: string;
    /** Maximum chars for bootstrap context in system prompt */
    maxBootstrapChars: number;
    /** Maximum daily note entries before auto-compaction */
    maxDailyNoteEntries: number;
    /** Whether heartbeat is enabled */
    heartbeatEnabled: boolean;
    /** Heartbeat interval in minutes */
    heartbeatIntervalMinutes: number;
    /** Whether to record session transcripts */
    transcriptsEnabled: boolean;
    /** Maximum transcript size in bytes before rotation */
    maxTranscriptBytes: number;
    /** Log level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    /** Whether first run onboarding is enabled */
    onboardingEnabled: boolean;
    /** Whether to auto-distill daily notes into MEMORY.md */
    autoDistill: boolean;
    /** System prompt mode */
    promptMode: 'full' | 'minimal' | 'none';
    /** Character threshold for chunking large inputs */
    largeInputChunkSize: number;
    /** Maximum total input size in characters */
    maxInputSize: number;
    /** Whether to write full LLM conversation logs to .vscode/johann/debug/ */
    debugConversationLog: boolean;
}

/**
 * Default configuration values.
 */
const DEFAULTS: JohannConfig = {
    maxSubtasks: 10,
    maxAttempts: 3,
    allowParallel: true,
    useWorktrees: true,
    memoryDir: '.vscode/johann',
    maxBootstrapChars: 15000,
    maxDailyNoteEntries: 100,
    heartbeatEnabled: false,
    heartbeatIntervalMinutes: 15,
    transcriptsEnabled: true,
    maxTranscriptBytes: 1_000_000, // 1MB
    logLevel: 'info',
    onboardingEnabled: true,
    autoDistill: true,
    promptMode: 'full',
    largeInputChunkSize: 8000,
    maxInputSize: 100000,
    debugConversationLog: true,
};

/**
 * The VS Code settings section name.
 */
const SECTION = 'johann';

/**
 * Read the full Johann configuration from VS Code settings.
 * Falls back to defaults for any missing values.
 */
export function getConfig(): JohannConfig {
    const cfg = vscode.workspace.getConfiguration(SECTION);

    return {
        maxSubtasks: cfg.get<number>('maxSubtasks', DEFAULTS.maxSubtasks),
        maxAttempts: cfg.get<number>('maxAttempts', DEFAULTS.maxAttempts),
        allowParallel: cfg.get<boolean>('allowParallel', DEFAULTS.allowParallel),
        useWorktrees: cfg.get<boolean>('useWorktrees', DEFAULTS.useWorktrees),
        memoryDir: cfg.get<string>('memoryDir', DEFAULTS.memoryDir),
        maxBootstrapChars: cfg.get<number>('maxBootstrapChars', DEFAULTS.maxBootstrapChars),
        maxDailyNoteEntries: cfg.get<number>('maxDailyNoteEntries', DEFAULTS.maxDailyNoteEntries),
        heartbeatEnabled: cfg.get<boolean>('heartbeatEnabled', DEFAULTS.heartbeatEnabled),
        heartbeatIntervalMinutes: cfg.get<number>('heartbeatIntervalMinutes', DEFAULTS.heartbeatIntervalMinutes),
        transcriptsEnabled: cfg.get<boolean>('transcriptsEnabled', DEFAULTS.transcriptsEnabled),
        maxTranscriptBytes: cfg.get<number>('maxTranscriptBytes', DEFAULTS.maxTranscriptBytes),
        logLevel: cfg.get<string>('logLevel', DEFAULTS.logLevel) as JohannConfig['logLevel'],
        onboardingEnabled: cfg.get<boolean>('onboardingEnabled', DEFAULTS.onboardingEnabled),
        autoDistill: cfg.get<boolean>('autoDistill', DEFAULTS.autoDistill),
        promptMode: cfg.get<string>('promptMode', DEFAULTS.promptMode) as JohannConfig['promptMode'],
        largeInputChunkSize: cfg.get<number>('largeInputChunkSize', DEFAULTS.largeInputChunkSize),
        maxInputSize: cfg.get<number>('maxInputSize', DEFAULTS.maxInputSize),
        debugConversationLog: cfg.get<boolean>('debugConversationLog', DEFAULTS.debugConversationLog),
    };
}

/**
 * Update a single configuration value.
 */
export async function setConfig<K extends keyof JohannConfig>(
    key: K,
    value: JohannConfig[K],
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace
): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(SECTION);
    await cfg.update(key, value, target);
}

/**
 * Get the defaults (useful for resetting).
 */
export function getDefaults(): JohannConfig {
    return { ...DEFAULTS };
}

/**
 * Listen for configuration changes.
 */
export function onConfigChange(
    callback: (config: JohannConfig) => void
): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(SECTION)) {
            callback(getConfig());
        }
    });
}

/**
 * Format the current configuration as a readable string.
 */
export function formatConfig(config?: JohannConfig): string {
    const cfg = config || getConfig();
    const lines: string[] = ['=== Johann Configuration ===', ''];

    for (const [key, value] of Object.entries(cfg)) {
        lines.push(`- **${key}:** ${JSON.stringify(value)}`);
    }

    return lines.join('\n');
}

// ============================================================================
// COPILOT AGENT SETTINGS — Read-only access to GitHub Copilot's settings
//
// These settings belong to Copilot, NOT Johann. Johann reads them for
// awareness and surfaces them to the user when relevant (e.g., /yolo status).
//
// Key settings:
// - github.copilot.chat.agent.autoApprove — Whether Copilot auto-approves tool calls
// - github.copilot.chat.agent.maxRequests — Max LLM requests before Copilot pauses
// ============================================================================

export interface CopilotAgentSettings {
    /** Whether Copilot auto-approves agent tool calls (commands, file edits) */
    autoApprove: boolean;
    /** Maximum LLM requests per session before Copilot pauses for confirmation */
    maxRequests: number;
    /** Whether the settings were readable (false = couldn't read, Copilot may not be installed) */
    readable: boolean;
}

/**
 * Read GitHub Copilot's agent settings (read-only).
 * Johann does NOT own these. This is for awareness and user guidance.
 */
export function getCopilotAgentSettings(): CopilotAgentSettings {
    try {
        const copilotCfg = vscode.workspace.getConfiguration('github.copilot.chat.agent');
        return {
            autoApprove: copilotCfg.get<boolean>('autoApprove', false),
            maxRequests: copilotCfg.get<number>('maxRequests', 0),
            readable: true,
        };
    } catch {
        return {
            autoApprove: false,
            maxRequests: 0,
            readable: false,
        };
    }
}

/**
 * Format Copilot agent settings as a readable summary.
 */
export function formatCopilotSettings(): string {
    const settings = getCopilotAgentSettings();

    if (!settings.readable) {
        return '⚠️ Could not read Copilot agent settings. Is GitHub Copilot installed?';
    }

    const approveStatus = settings.autoApprove ? '🟢 Enabled' : '🔴 Disabled (confirmations active)';
    const requestLimit = settings.maxRequests > 0
        ? `${settings.maxRequests} requests per session`
        : 'Not set (default)';

    return [
        '### GitHub Copilot Agent Settings',
        '',
        `| Setting | Value |`,
        `|---------|-------|`,
        `| \`github.copilot.chat.agent.autoApprove\` | ${approveStatus} |`,
        `| \`github.copilot.chat.agent.maxRequests\` | ${requestLimit} |`,
    ].join('\n');
}
