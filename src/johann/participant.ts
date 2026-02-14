import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator';
import { DEFAULT_CONFIG } from './types';
import {
    getJohannWorkspaceUri,
    loadBootstrapFiles,
    completeBootstrap,
} from './bootstrap';
import { assembleSystemPrompt } from './systemPrompt';
import { handleDirective } from './directives';
import { getConfig, onConfigChange } from './config';
import { SessionTranscript } from './sessionTranscript';
import { logEvent, logUserInfo, getRecentDailyNotesContext } from './dailyNotes';
import { searchMemory, formatSearchResults } from './memorySearch';
import { discoverSkills, formatSkillsForPrompt } from './skills';
import { HeartbeatManager } from './heartbeat';
import { createLogger, JohannLogger } from './logger';
import { SubagentRegistry } from './subagentRegistry';

// ============================================================================
// JOHANN CHAT PARTICIPANT
// Registers @johann as a VS Code chat participant.
// This is the entry point that wires:
// - Bootstrap files → system prompt
// - Directives (slash commands)
// - Session transcripts
// - Daily notes
// - Memory search
// - Skills
// - Heartbeat
// - Logging
// - Subagent registry
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
    const config = getConfig();
    const orchestrator = new Orchestrator({
        ...DEFAULT_CONFIG,
        maxSubtasks: config.maxSubtasks,
        maxAttemptsPerSubtask: config.maxAttempts,
        allowParallelExecution: config.allowParallel,
        memoryDir: config.memoryDir,
    });

    const logger = createLogger();
    const heartbeat = new HeartbeatManager(logger);
    const disposables: vscode.Disposable[] = [];

    // Start heartbeat if enabled
    heartbeat.start();

    // Listen for config changes
    disposables.push(onConfigChange(newConfig => {
        logger.refreshLevel();
        if (newConfig.heartbeatEnabled && !heartbeat.running()) {
            heartbeat.start();
        } else if (!newConfig.heartbeatEnabled && heartbeat.running()) {
            heartbeat.stop();
        }
    }));

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
                    '**Johann** — Orchestration agent for GitHub Copilot.\n\n' +
                    'Send me a task and I will:\n' +
                    '1. Decompose it into subtasks\n' +
                    '2. Select the best model for each subtask\n' +
                    '3. Execute with subagents\n' +
                    '4. Escalate between models if needed\n' +
                    '5. Merge results and report back\n\n' +
                    'Type `/help` for available directives.\n' +
                    'All decisions are recorded in `.vscode/johann/` for continuity.\n'
                );
                return;
            }

            // === DIRECTIVE HANDLING ===
            const directiveResult = await handleDirective(userMessage, response);
            if (directiveResult.isDirective) {
                logger.info(`Directive handled: ${userMessage.split(' ')[0]}`);
                return;
            }

            // === MODEL SETUP ===
            const model = await getModel(request);
            if (!model) {
                response.markdown(
                    '**Error:** No language models available. ' +
                    'Make sure you have GitHub Copilot active and a model selected.\n'
                );
                return;
            }

            // === BOOTSTRAP & SYSTEM PROMPT ===
            const johannDir = getJohannWorkspaceUri();
            let systemPrompt = '';
            let isFirstRun = false;

            if (johannDir) {
                const bootstrapContext = await loadBootstrapFiles(johannDir);
                isFirstRun = bootstrapContext.isFirstRun;

                // Discover skills
                const skills = await discoverSkills();
                const skillDescriptions = formatSkillsForPrompt(skills);

                // Get workspace path
                const folders = vscode.workspace.workspaceFolders;
                const workspacePath = folders?.[0]?.uri.fsPath;

                // Assemble the system prompt with all context
                systemPrompt = assembleSystemPrompt({
                    mode: config.promptMode,
                    bootstrapFiles: bootstrapContext.files,
                    isFirstRun,
                    availableSkills: skillDescriptions,
                    agentId: 'johann',
                    workspacePath,
                    maxBootstrapChars: config.maxBootstrapChars,
                    hasMemorySearch: true,
                    modelName: model.name,
                });

                logger.debug('System prompt assembled', {
                    mode: config.promptMode,
                    bootstrapFileCount: bootstrapContext.files.length,
                    isFirstRun,
                    skillCount: skills.length,
                    promptLength: systemPrompt.length,
                });
            }

            // === SESSION TRANSCRIPT ===
            let transcript: SessionTranscript | undefined;
            if (config.transcriptsEnabled) {
                transcript = new SessionTranscript();
                await transcript.initialize();
                await transcript.recordUser(userMessage);
                logger.debug(`Session transcript started: ${transcript.getSessionId()}`);
            }

            // === LOG DAILY NOTE ===
            await logEvent('User request', userMessage.substring(0, 200));

            // === WORKSPACE CONTEXT ===
            const workspaceContext = await getWorkspaceContext();

            // Build conversation history for context
            const conversationHistory = chatContext.history
                .map(entry => {
                    if (entry instanceof vscode.ChatRequestTurn) {
                        return `User: ${entry.prompt}`;
                    }
                    if (entry instanceof vscode.ChatResponseTurn) {
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

            // Get recent daily notes for context
            const dailyNotesContext = await getRecentDailyNotesContext(2, 2000);

            // Build full context (for planning + merge — includes system prompt, memory, conversation)
            const fullContextParts: string[] = [];
            if (systemPrompt) {
                fullContextParts.push(systemPrompt);
            }
            if (workspaceContext) {
                fullContextParts.push(workspaceContext);
            }
            if (dailyNotesContext) {
                fullContextParts.push(dailyNotesContext);
            }
            if (conversationHistory) {
                fullContextParts.push(`=== Recent Conversation ===\n${conversationHistory}`);
            }

            const fullContext = fullContextParts.join('\n\n---\n\n');

            // Subagent context is ONLY the workspace structure — no Johann identity,
            // no system prompt, no memory. This prevents subagents from confusing
            // themselves with Johann or picking up the bootstrap/onboarding personality.
            const subagentContext = workspaceContext;

            // === FIRST RUN HANDLING ===
            if (isFirstRun && johannDir) {
                response.markdown('🎼 **First run detected!** Setting up Johann workspace...\n\n');
                logger.info('First run detected — bootstrap files created.');
            }

            // === ORCHESTRATE ===
            const registry = new SubagentRegistry(
                transcript?.getSessionId() || `anon-${Date.now()}`
            );
            await registry.initialize();

            await orchestrator.orchestrate(
                userMessage,
                fullContext,
                subagentContext,
                model,
                response,
                token
            );

            // === POST-ORCHESTRATION ===
            // Complete bootstrap if first run
            if (isFirstRun && johannDir) {
                await completeBootstrap(johannDir);
                logger.info('Bootstrap completed — BOOTSTRAP.md removed.');
            }

            // Close session transcript
            if (transcript) {
                await transcript.recordAgent('(orchestration complete)');
                await transcript.close(userMessage.substring(0, 100));
            }

            // Log completion
            await logEvent('Request completed', `Finished: ${userMessage.substring(0, 100)}`);
            logger.info(`Request completed: ${userMessage.substring(0, 80)}`);
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

    disposables.push(
        vscode.commands.registerCommand('johann.showLog', () => {
            logger.show();
        })
    );

    // Clean up heartbeat on deactivate
    disposables.push({ dispose: () => heartbeat.dispose() });
    disposables.push({ dispose: () => logger.dispose() });

    return disposables;
}
