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
    /** Whether to enable intelligent model picker (if false, uses fixedModel) */
    modelPickerEnabled: boolean;
    /** Fixed model to use when picker is disabled (empty = first available) */
    fixedModel: string;
    /** List of blocked model patterns (regex). Empty = all allowed. */
    blockedModels: string[];
    /** Enable background execution mode (non-blocking orchestration). */
    backgroundModeEnabled: boolean;
    /** Allow escalation to Opus models (3× or higher cost). Default: false. */
    allowOpusEscalation: boolean;
    /** Timeout for a single tool invocation during subtask execution (ms). */
    toolInvocationTimeoutMs: number;
    /** Auto-convert long-running terminal commands to background mode. */
    autoBackgroundLongRunningCommands: boolean;
    /** Target Copilot maxRequests value when enabling YOLO mode. */
    yoloMaxRequests: number;
    /** Whether autonomous skill creation is enabled. */
    skillAutonomousCreation: boolean;
    /** Whether end-of-run skill promotion UI is enabled. */
    skillPromotionEnabled: boolean;
    /** Maximum local skills per project. */
    skillMaxLocal: number;
    /** Maximum new skills created per run. */
    skillMaxNewPerRun: number;
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
    modelPickerEnabled: true,
    fixedModel: '',
    blockedModels: [],
    backgroundModeEnabled: false,
    allowOpusEscalation: false,
    toolInvocationTimeoutMs: 120000,
    autoBackgroundLongRunningCommands: true,
    yoloMaxRequests: 200,
    skillAutonomousCreation: true,
    skillPromotionEnabled: true,
    skillMaxLocal: 50,
    skillMaxNewPerRun: 5,
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
        heartbeatIntervalMinutes: cfg.get<number>(
            'heartbeatIntervalMinutes',
            DEFAULTS.heartbeatIntervalMinutes,
        ),
        transcriptsEnabled: cfg.get<boolean>('transcriptsEnabled', DEFAULTS.transcriptsEnabled),
        maxTranscriptBytes: cfg.get<number>('maxTranscriptBytes', DEFAULTS.maxTranscriptBytes),
        logLevel: cfg.get<string>('logLevel', DEFAULTS.logLevel) as JohannConfig['logLevel'],
        onboardingEnabled: cfg.get<boolean>('onboardingEnabled', DEFAULTS.onboardingEnabled),
        autoDistill: cfg.get<boolean>('autoDistill', DEFAULTS.autoDistill),
        promptMode: cfg.get<string>(
            'promptMode',
            DEFAULTS.promptMode,
        ) as JohannConfig['promptMode'],
        largeInputChunkSize: cfg.get<number>('largeInputChunkSize', DEFAULTS.largeInputChunkSize),
        maxInputSize: cfg.get<number>('maxInputSize', DEFAULTS.maxInputSize),
        debugConversationLog: cfg.get<boolean>(
            'debugConversationLog',
            DEFAULTS.debugConversationLog,
        ),
        modelPickerEnabled: cfg.get<boolean>('modelPickerEnabled', DEFAULTS.modelPickerEnabled),
        fixedModel: cfg.get<string>('fixedModel', DEFAULTS.fixedModel),
        blockedModels: cfg.get<string[]>('blockedModels', DEFAULTS.blockedModels),
        backgroundModeEnabled: cfg.get<boolean>(
            'backgroundModeEnabled',
            DEFAULTS.backgroundModeEnabled,
        ),
        allowOpusEscalation: cfg.get<boolean>('allowOpusEscalation', DEFAULTS.allowOpusEscalation),
        toolInvocationTimeoutMs: cfg.get<number>(
            'toolInvocationTimeoutMs',
            DEFAULTS.toolInvocationTimeoutMs,
        ),
        autoBackgroundLongRunningCommands: cfg.get<boolean>(
            'autoBackgroundLongRunningCommands',
            DEFAULTS.autoBackgroundLongRunningCommands,
        ),
        yoloMaxRequests: cfg.get<number>('yoloMaxRequests', DEFAULTS.yoloMaxRequests),
        skillAutonomousCreation: cfg.get<boolean>(
            'skillAutonomousCreation',
            DEFAULTS.skillAutonomousCreation,
        ),
        skillPromotionEnabled: cfg.get<boolean>(
            'skillPromotionEnabled',
            DEFAULTS.skillPromotionEnabled,
        ),
        skillMaxLocal: cfg.get<number>('skillMaxLocal', DEFAULTS.skillMaxLocal),
        skillMaxNewPerRun: cfg.get<number>('skillMaxNewPerRun', DEFAULTS.skillMaxNewPerRun),
    };
}

/**
 * Update a single configuration value.
 */
export async function setConfig<K extends keyof JohannConfig>(
    key: K,
    value: JohannConfig[K],
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace,
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
export function onConfigChange(callback: (config: JohannConfig) => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
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
// COPILOT AGENT SETTINGS — Access to GitHub Copilot's settings
//
// These settings belong to Copilot, NOT Johann. Johann reads them for
// awareness and may update them only on explicit user request (e.g., /yolo on).
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
 * Read GitHub Copilot's agent settings.
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
 * Update GitHub Copilot agent settings used by YOLO mode.
 * This only runs when explicitly requested by the user (e.g. /yolo on).
 */
export async function setCopilotAgentSettings(
    autoApprove: boolean,
    maxRequests: number,
    target: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Workspace,
): Promise<void> {
    const copilotCfg = vscode.workspace.getConfiguration('github.copilot.chat.agent');
    await copilotCfg.update('autoApprove', autoApprove, target);
    await copilotCfg.update('maxRequests', maxRequests, target);
}

/**
 * Format Copilot agent settings as a readable summary.
 */
export function formatCopilotSettings(): string {
    const settings = getCopilotAgentSettings();

    if (!settings.readable) {
        return '⚠️ Could not read Copilot agent settings. Is GitHub Copilot installed?';
    }

    const approveStatus = settings.autoApprove
        ? '🟢 Enabled'
        : '🔴 Disabled (confirmations active)';
    const requestLimit =
        settings.maxRequests > 0
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

// ============================================================================
// COPILOT MODEL SETTINGS — Backwards compatibility layer
//
// Attempts to read VS Code's native model visibility settings.
// These may be in different locations depending on VS Code version:
// - Older: github.copilot.chat.models.visible / hidden
// - Newer: chat.models.visible / hidden
// - Future: May move again
//
// This is best-effort only. Johann's own settings take precedence.
// ============================================================================

export interface CopilotModelSettings {
    /** Models that are visible in the UI */
    visibleModels: string[];
    /** Models that are hidden from the UI */
    hiddenModels: string[];
    /** Whether we successfully read any model settings */
    found: boolean;
    /** Which settings location was used */
    source: 'github.copilot' | 'chat' | 'none';
}

/**
 * Attempt to read Copilot/VS Code model visibility settings.
 * This is backwards compatibility - helps migrate users to Johann settings.
 */
export function getCopilotModelSettings(): CopilotModelSettings {
    // Try new location (chat.models.*)
    try {
        const chatCfg = vscode.workspace.getConfiguration('chat.models');
        const visible = chatCfg.get<string[]>('visible');
        const hidden = chatCfg.get<string[]>('hidden');

        if (visible || hidden) {
            return {
                visibleModels: visible || [],
                hiddenModels: hidden || [],
                found: true,
                source: 'chat',
            };
        }
    } catch {
        // Continue to fallback
    }

    // Try old location (github.copilot.chat.models.*)
    try {
        const copilotCfg = vscode.workspace.getConfiguration('github.copilot.chat.models');
        const visible = copilotCfg.get<string[]>('visible');
        const hidden = copilotCfg.get<string[]>('hidden');

        if (visible || hidden) {
            return {
                visibleModels: visible || [],
                hiddenModels: hidden || [],
                found: true,
                source: 'github.copilot',
            };
        }
    } catch {
        // No settings found
    }

    return {
        visibleModels: [],
        hiddenModels: [],
        found: false,
        source: 'none',
    };
}

/**
 * Auto-populate Johann's model restrictions from Copilot settings if Johann settings are empty.
 * This provides a migration path for users upgrading from older setups.
 *
 * Returns true if settings were migrated, false otherwise.
 */
export async function migrateModelSettingsFromCopilot(): Promise<boolean> {
    const johannCfg = getConfig();

    // Only migrate if Johann settings are empty (user hasn't configured yet)
    if (johannCfg.blockedModels.length > 0) {
        return false; // User has already configured Johann
    }

    const copilotSettings = getCopilotModelSettings();

    if (!copilotSettings.found) {
        return false; // No Copilot settings to migrate
    }

    // Migrate hidden models to blocked
    if (copilotSettings.hiddenModels.length > 0) {
        await setConfig('blockedModels', copilotSettings.hiddenModels);
        return true;
    }

    return false;
}
