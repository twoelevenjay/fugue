import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator';
import { DEFAULT_CONFIG } from './types';

// ============================================================================
// JOHANN CHAT PARTICIPANT
// Registers @johann as a VS Code chat participant.
// This is the entry point that wires user messages to the orchestrator.
// ============================================================================

const JOHANN_PARTICIPANT_ID = 'johann';

/**
 * Build basic workspace context to inject into the orchestrator.
 */
async function getWorkspaceContext(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return 'No workspace open.';
    }

    const parts: string[] = [];
    parts.push('Workspace folders:');
    for (const folder of folders) {
        parts.push(`  - ${folder.uri.fsPath}`);
    }

    // List top-level files in the first workspace folder
    try {
        const topLevel = await vscode.workspace.fs.readDirectory(folders[0].uri);
        parts.push('\nTop-level contents:');
        for (const [name, type] of topLevel.slice(0, 30)) {
            const icon = type === vscode.FileType.Directory ? '📁' : '📄';
            parts.push(`  ${icon} ${name}`);
        }
        if (topLevel.length > 30) {
            parts.push(`  ... and ${topLevel.length - 30} more`);
        }
    } catch {
        // ignore
    }

    // Check for common config files
    const configFiles = [
        'package.json', 'tsconfig.json', 'Cargo.toml', 'pyproject.toml',
        'go.mod', 'pom.xml', 'build.gradle', '.gitignore', 'Makefile',
    ];

    const foundConfigs: string[] = [];
    for (const cf of configFiles) {
        try {
            const uri = vscode.Uri.joinPath(folders[0].uri, cf);
            await vscode.workspace.fs.stat(uri);
            foundConfigs.push(cf);
        } catch {
            // not found
        }
    }

    if (foundConfigs.length > 0) {
        parts.push(`\nDetected config files: ${foundConfigs.join(', ')}`);
    }

    // Read package.json name/description if present
    try {
        const pkgUri = vscode.Uri.joinPath(folders[0].uri, 'package.json');
        const pkgBytes = await vscode.workspace.fs.readFile(pkgUri);
        const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
        if (pkg.name || pkg.description) {
            parts.push(`\nProject: ${pkg.name || 'unknown'} — ${pkg.description || ''}`);
        }
    } catch {
        // ignore
    }

    return parts.join('\n');
}

/**
 * Get the user's currently active model from the chat context,
 * or fall back to the best available model.
 */
async function getModel(
    request: vscode.ChatRequest
): Promise<vscode.LanguageModelChat | undefined> {
    // Use the model the user has selected in the chat
    if (request.model) {
        return request.model;
    }

    // Fallback: find any available model
    const models = await vscode.lm.selectChatModels();
    if (models.length > 0) {
        return models[0];
    }

    return undefined;
}

/**
 * Register the @johann chat participant and return disposables.
 */
export function registerJohannParticipant(
    context: vscode.ExtensionContext
): vscode.Disposable[] {
    const orchestrator = new Orchestrator(DEFAULT_CONFIG);
    const disposables: vscode.Disposable[] = [];

    // Register participant
    const participant = vscode.chat.createChatParticipant(
        JOHANN_PARTICIPANT_ID,
        async (
            request: vscode.ChatRequest,
            chatContext: vscode.ChatContext,
            response: vscode.ChatResponseStream,
            token: vscode.CancellationToken
        ) => {
            const userMessage = request.prompt.trim();

            if (!userMessage) {
                response.markdown(
                    '**Johann** — OpenClaw-inspired orchestration agent.\n\n' +
                    'Send me a task and I will:\n' +
                    '1. Decompose it into subtasks\n' +
                    '2. Select the best model for each subtask\n' +
                    '3. Execute with subagents\n' +
                    '4. Escalate between models if needed\n' +
                    '5. Merge results and report back\n\n' +
                    'All decisions are recorded in `.vscode/johann/` for continuity.\n'
                );
                return;
            }

            // Get model
            const model = await getModel(request);
            if (!model) {
                response.markdown(
                    '**Error:** No language models available. ' +
                    'Make sure you have GitHub Copilot active and a model selected.\n'
                );
                return;
            }

            // Gather workspace context
            const workspaceContext = await getWorkspaceContext();

            // Build conversation history for context
            const conversationHistory = chatContext.history
                .map(entry => {
                    if (entry instanceof vscode.ChatRequestTurn) {
                        return `User: ${entry.prompt}`;
                    }
                    if (entry instanceof vscode.ChatResponseTurn) {
                        // Extract text from response parts
                        const parts = entry.response
                            .filter((p): p is vscode.ChatResponseMarkdownPart => p instanceof vscode.ChatResponseMarkdownPart)
                            .map(p => p.value.value)
                            .join('');
                        return `Assistant: ${parts.substring(0, 500)}`;
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n');

            const fullContext = conversationHistory
                ? `${workspaceContext}\n\n=== Recent Conversation ===\n${conversationHistory}`
                : workspaceContext;

            // Orchestrate
            await orchestrator.orchestrate(
                userMessage,
                fullContext,
                model,
                response,
                token
            );
        }
    );

    participant.iconPath = new vscode.ThemeIcon('hubot');
    disposables.push(participant);

    // Register commands
    disposables.push(
        vscode.commands.registerCommand('johann.showMemory', async () => {
            const memory = orchestrator.getMemory();
            const entries = await memory.listMemory();

            if (entries.length === 0) {
                vscode.window.showInformationMessage('Johann: No memory entries yet.');
                return;
            }

            const items = entries.map(name => ({
                label: name,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a memory entry to view',
            });

            if (selected) {
                const folders = vscode.workspace.workspaceFolders;
                if (folders) {
                    const uri = vscode.Uri.joinPath(
                        folders[0].uri,
                        '.vscode', 'johann', selected.label
                    );
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                }
            }
        })
    );

    disposables.push(
        vscode.commands.registerCommand('johann.clearMemory', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Clear all Johann memory entries?',
                { modal: true },
                'Clear'
            );

            if (answer === 'Clear') {
                const memory = orchestrator.getMemory();
                await memory.clearMemory();
                vscode.window.showInformationMessage('Johann: Memory cleared.');
            }
        })
    );

    return disposables;
}
