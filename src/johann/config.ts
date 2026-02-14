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
}

/**
 * Default configuration values.
 */
const DEFAULTS: JohannConfig = {
    maxSubtasks: 10,
    maxAttempts: 3,
    allowParallel: true,
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
