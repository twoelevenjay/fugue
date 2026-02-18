/**
 * copilotCliStatus.ts — Copilot CLI detection, caching, and onboarding UX.
 *
 * Junior devs installing Fugue may not have Copilot CLI. This module:
 * 1. Detects whether `copilot` is available (PATH or env override)
 * 2. Caches the result so we don't shell out every time
 * 3. Shows actionable notifications with install links
 * 4. Provides a command for manual setup
 */

import * as vscode from 'vscode';
import { execSync } from 'child_process';

// ============================================================================
// Types
// ============================================================================

export interface CliStatus {
    available: boolean;
    path?: string;
    version?: string;
    checkedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Re-check CLI availability after this many ms (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

const INSTALL_URL =
    'https://docs.github.com/en/copilot/managing-copilot/configure-personal-settings/installing-github-copilot-in-the-cli';
const NPM_INSTALL_CMD = 'npm install -g @githubnext/github-copilot-cli';

// ============================================================================
// State
// ============================================================================

let cachedStatus: CliStatus | null = null;

// ============================================================================
// Detection
// ============================================================================

/**
 * Check if Copilot CLI is available. Uses a short-lived cache to avoid
 * repeated shell-outs.
 */
export function checkCopilotCli(forceRefresh = false): CliStatus {
    if (!forceRefresh && cachedStatus && Date.now() - cachedStatus.checkedAt < CACHE_TTL_MS) {
        return cachedStatus;
    }

    const status: CliStatus = { available: false, checkedAt: Date.now() };

    // 1. Check env override
    const envPath = process.env.COPILOT_CLI_PATH;
    if (envPath) {
        try {
            const version = execSync(`"${envPath}" --version 2>/dev/null`, {
                encoding: 'utf-8',
                timeout: 5000,
            }).trim();
            status.available = true;
            status.path = envPath;
            status.version = version || undefined;
        } catch {
            // Env var set but binary doesn't work — fall through to PATH check
        }
    }

    // 2. Check PATH
    if (!status.available) {
        try {
            const whichResult = execSync(
                process.platform === 'win32' ? 'where copilot' : 'which copilot',
                { encoding: 'utf-8', timeout: 5000 },
            ).trim();

            if (whichResult) {
                status.path = whichResult.split('\n')[0]; // Take first result on Windows
                status.available = true;

                try {
                    status.version = execSync('copilot --version 2>/dev/null', {
                        encoding: 'utf-8',
                        timeout: 5000,
                    }).trim();
                } catch {
                    // CLI found but --version failed — still usable
                }
            }
        } catch {
            // Not in PATH
        }
    }

    cachedStatus = status;
    return status;
}

/**
 * Clear the cached status (e.g., after user installs CLI).
 */
export function clearCliStatusCache(): void {
    cachedStatus = null;
}

// ============================================================================
// Onboarding UX
// ============================================================================

/**
 * Show a non-blocking notification when CLI is missing.
 * Called once on activation. Doesn't nag — user can dismiss and we won't
 * show again until next session.
 */
export async function showCliMissingNotification(): Promise<void> {
    const status = checkCopilotCli();
    if (status.available) {
        return;
    }

    const selection = await vscode.window.showWarningMessage(
        'Johann requires the GitHub Copilot CLI to execute tasks. Install it to enable orchestration.',
        'Setup Guide',
        "I'll do it later",
    );

    if (selection === 'Setup Guide') {
        await vscode.commands.executeCommand('johann.setupCopilotCli');
    }
}

/**
 * Show an error notification when a task fails because CLI is missing.
 * More urgent than the activation warning — the user just tried to do something.
 */
export async function showCliMissingError(): Promise<void> {
    const selection = await vscode.window.showErrorMessage(
        'Cannot start task: Copilot CLI not found. Johann needs it to run subtasks.',
        'Setup Now',
        'Set Custom Path',
    );

    if (selection === 'Setup Now') {
        await vscode.commands.executeCommand('johann.setupCopilotCli');
    } else if (selection === 'Set Custom Path') {
        const path = await vscode.window.showInputBox({
            prompt: 'Enter the full path to the copilot executable',
            placeHolder: '/usr/local/bin/copilot',
            validateInput: (value) => {
                if (!value.trim()) {
                    return 'Path cannot be empty';
                }
                return undefined;
            },
        });
        if (path) {
            // Set it for this session
            process.env.COPILOT_CLI_PATH = path.trim();
            clearCliStatusCache();
            const recheck = checkCopilotCli(true);
            if (recheck.available) {
                vscode.window.showInformationMessage(
                    `✅ Copilot CLI found at ${path}. Johann is ready.`,
                );
            } else {
                vscode.window.showErrorMessage(
                    `Could not run copilot at "${path}". Check the path and try again.`,
                );
            }
        }
    }
}

// ============================================================================
// Setup Command
// ============================================================================

/**
 * Register the `johann.setupCopilotCli` command.
 * Shows a QuickPick with install options appropriate for the user's platform.
 */
export function registerSetupCommand(context: vscode.ExtensionContext): void {
    const cmd = vscode.commands.registerCommand('johann.setupCopilotCli', async () => {
        // Re-check in case they installed it since last check
        clearCliStatusCache();
        const status = checkCopilotCli(true);

        if (status.available) {
            vscode.window.showInformationMessage(
                `✅ Copilot CLI is already installed${status.version ? ` (${status.version})` : ''}. Johann is ready!`,
            );
            return;
        }

        const items: vscode.QuickPickItem[] = [
            {
                label: '$(terminal) Install via npm',
                description: NPM_INSTALL_CMD,
                detail: 'Recommended. Requires Node.js 18+.',
            },
            {
                label: '$(link-external) Open install docs',
                description: 'GitHub documentation',
                detail: 'Step-by-step instructions from GitHub.',
            },
            {
                label: '$(folder) Set custom path',
                description: 'Point to an existing copilot binary',
                detail: 'Use this if copilot is installed but not in your PATH.',
            },
            {
                label: '$(refresh) Re-check',
                description: 'I just installed it',
                detail: 'Verify that copilot is now available.',
            },
        ];

        const pick = await vscode.window.showQuickPick(items, {
            title: 'Johann — Copilot CLI Setup',
            placeHolder: 'How would you like to install the Copilot CLI?',
        });

        if (!pick) {
            return;
        }

        if (pick.label.includes('Install via npm')) {
            // Open a terminal and run the install command
            const terminal = vscode.window.createTerminal('Copilot CLI Setup');
            terminal.show();
            terminal.sendText(NPM_INSTALL_CMD);
            vscode.window.showInformationMessage(
                'Installing Copilot CLI... When it finishes, run "Johann: Setup Copilot CLI" again to verify.',
            );
        } else if (pick.label.includes('Open install docs')) {
            vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
        } else if (pick.label.includes('Set custom path')) {
            const path = await vscode.window.showInputBox({
                prompt: 'Full path to the copilot executable',
                placeHolder: '/usr/local/bin/copilot',
            });
            if (path) {
                process.env.COPILOT_CLI_PATH = path.trim();
                clearCliStatusCache();
                const recheck = checkCopilotCli(true);
                if (recheck.available) {
                    vscode.window.showInformationMessage(
                        `✅ Copilot CLI found at ${path}. Johann is ready!`,
                    );
                } else {
                    vscode.window.showErrorMessage(
                        `Could not run copilot at "${path}". Check the path and try again.`,
                    );
                }
            }
        } else if (pick.label.includes('Re-check')) {
            clearCliStatusCache();
            const recheck = checkCopilotCli(true);
            if (recheck.available) {
                vscode.window.showInformationMessage(
                    `✅ Copilot CLI found${recheck.version ? ` (${recheck.version})` : ''}! Johann is ready.`,
                );
            } else {
                vscode.window.showWarningMessage(
                    "Copilot CLI still not found. Make sure it's installed and in your PATH.",
                );
            }
        }
    });

    context.subscriptions.push(cmd);
}
