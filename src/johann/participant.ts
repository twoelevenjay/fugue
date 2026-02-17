import * as vscode from 'vscode';
import { Orchestrator } from './orchestrator';
import { DEFAULT_CONFIG } from './types';
import { getJohannWorkspaceUri, loadBootstrapFiles, completeBootstrap } from './bootstrap';
import { assembleSystemPrompt } from './systemPrompt';
import { handleDirective } from './directives';
import { getConfig, onConfigChange, migrateModelSettingsFromCopilot } from './config';
import { SessionTranscript } from './sessionTranscript';
import { logEvent, getRecentDailyNotesContext } from './dailyNotes';
import { discoverSkills, formatSkillsForPrompt } from './skills';
import { HeartbeatManager } from './heartbeat';
import { createLogger } from './logger';
import { SubagentRegistry } from './subagentRegistry';
import { BackgroundTaskManager } from './backgroundTaskManager';
import { RunStateManager } from './runState';
import { generateSnapshot } from './statusSnapshot';

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
 * Metadata returned from a Johann chat response.
 * Used by the followup provider to suggest contextual next steps.
 */
interface JohannChatResult extends vscode.ChatResult {
    metadata: {
        command: string;
        /** Whether the orchestration completed successfully. */
        success?: boolean;
        /** Brief description of what was done. */
        summary?: string;
    };
}

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
        'package.json',
        'tsconfig.json',
        'Cargo.toml',
        'pyproject.toml',
        'go.mod',
        'pom.xml',
        'build.gradle',
        '.gitignore',
        'Makefile',
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
    request: vscode.ChatRequest,
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
export function registerJohannParticipant(_context: vscode.ExtensionContext): vscode.Disposable[] {
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

    // Attempt to migrate model settings from Copilot (one-time, backwards compatibility)
    migrateModelSettingsFromCopilot()
        .then((migrated) => {
            if (migrated) {
                logger.info('Migrated model restrictions from Copilot settings to Johann settings');
            }
        })
        .catch((err) => {
            logger.warn(`Failed to migrate model settings: ${err}`);
        });

    // Start heartbeat if enabled
    heartbeat.start();

    // Listen for config changes
    disposables.push(
        onConfigChange((newConfig) => {
            logger.refreshLevel();
            if (newConfig.heartbeatEnabled && !heartbeat.running()) {
                heartbeat.start();
            } else if (!newConfig.heartbeatEnabled && heartbeat.running()) {
                heartbeat.stop();
            }
        }),
    );

    // Register participant
    const participant = vscode.chat.createChatParticipant(
        JOHANN_PARTICIPANT_ID,
        async (
            request: vscode.ChatRequest,
            chatContext: vscode.ChatContext,
            response: vscode.ChatResponseStream,
            token: vscode.CancellationToken,
        ): Promise<JohannChatResult> => {
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
                        'All decisions are recorded in `.vscode/johann/` for continuity.\n',
                );
                return { metadata: { command: 'help' } };
            }

            // === DIRECTIVE HANDLING ===
            const directiveResult = await handleDirective(userMessage, response);
            if (directiveResult.isDirective) {
                logger.info(`Directive handled: ${userMessage.split(' ')[0]}`);

                // If /resume returned a session to resume, execute it
                if (directiveResult.resumeSession) {
                    const model = await getModel(request);
                    if (!model) {
                        response.markdown('**Error:** No language models available for resume.\n');
                        return { metadata: { command: 'resume', success: false } };
                    }
                    const resumed = await orchestrator.resumeSession(
                        directiveResult.resumeSession,
                        model,
                        response,
                        token,
                    );
                    if (!resumed) {
                        response.markdown('Nothing to resume — all subtasks already completed.\n');
                    }
                }
                return { metadata: { command: 'directive' } };
            }

            // === INTERACTIVE WHILE RUNNING ===
            // If Johann is already running, intercept "status" requests and
            // "add task" requests without interrupting the active run.
            const runManager = RunStateManager.getInstance();
            if (runManager.isRunning()) {
                const lowerMsg = userMessage.toLowerCase().trim();

                // Status check: show a snapshot
                if (lowerMsg === 'status' || lowerMsg === 'status detailed') {
                    const state = runManager.getState();
                    if (state) {
                        const snapshot = lowerMsg.includes('detailed')
                            ? (await import('./statusSnapshot')).generateDetailedSnapshot(state)
                            : generateSnapshot(state);
                        await runManager.recordSnapshot();
                        response.markdown(snapshot.markdown);
                        return { metadata: { command: 'status' } };
                    }
                }

                // Add task: enqueue user message for integration at next checkpoint
                if (
                    lowerMsg.startsWith('add task:') ||
                    lowerMsg.startsWith('add:') ||
                    lowerMsg.startsWith('also ')
                ) {
                    const taskDescription = userMessage
                        .replace(/^(add task:|add:|also)\s*/i, '')
                        .trim();

                    if (taskDescription) {
                        const position = await runManager.enqueueUserMessage(taskDescription);
                        response.markdown(
                            `📨 **Task queued** (position ${position})\n\n` +
                                `> ${taskDescription}\n\n` +
                                `Johann will integrate this at the next safe checkpoint between waves.\n`,
                        );
                        return { metadata: { command: 'add-task' } };
                    }
                }

                // Any other message while running — queue it
                const position = await runManager.enqueueUserMessage(userMessage);
                response.markdown(
                    `📨 **Message queued** (position ${position})\n\n` +
                        `Johann is currently running. Your message has been queued:\n\n` +
                        `> ${userMessage.substring(0, 200)}${userMessage.length > 200 ? '…' : ''}\n\n` +
                        `It will be integrated at the next safe checkpoint.\n\n` +
                        `Say \`@johann status\` for a live progress snapshot.\n`,
                );
                return { metadata: { command: 'queued' } };
            }

            // === WORKSPACE TRUST CHECK ===
            // Johann executes LLM-generated operations and git commands.
            // In untrusted workspaces, a malicious .vscode/johann/ could
            // influence LLM behavior or exploit tool invocations.
            if (!vscode.workspace.isTrusted) {
                response.markdown(
                    '**Workspace not trusted.** Johann requires a trusted workspace to orchestrate tasks.\n\n' +
                        'This workspace has not been marked as trusted. Johann performs file writes, ' +
                        'git operations, and LLM-driven tool invocations that could be influenced by ' +
                        'malicious workspace content.\n\n' +
                        'To trust this workspace, run **Workspaces: Manage Workspace Trust** from the Command Palette.\n',
                );
                return { metadata: { command: 'orchestrate', success: false } };
            }

            // === MODEL SETUP ===
            const model = await getModel(request);
            if (!model) {
                response.markdown(
                    '**Error:** No language models available. ' +
                        'Make sure you have GitHub Copilot active and a model selected.\n',
                );
                return { metadata: { command: 'orchestrate', success: false } };
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
                .map((entry) => {
                    if (entry instanceof vscode.ChatRequestTurn) {
                        return `User: ${entry.prompt}`;
                    }
                    if (entry instanceof vscode.ChatResponseTurn) {
                        const parts = entry.response
                            .filter(
                                (p): p is vscode.ChatResponseMarkdownPart =>
                                    p instanceof vscode.ChatResponseMarkdownPart,
                            )
                            .map((p) => p.value.value)
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
                transcript?.getSessionId() || `anon-${Date.now()}`,
            );
            await registry.initialize();

            // Check if background mode is enabled
            if (config.backgroundModeEnabled) {
                // Start background orchestration and return immediately
                const taskId = await orchestrator.startBackgroundOrchestration(
                    userMessage,
                    fullContext,
                    subagentContext,
                    model,
                    request.toolInvocationToken,
                );

                response.markdown(
                    `🔄 **Background orchestration started**\n\n` +
                        `Task ID: \`${taskId}\`\n\n` +
                        `Your request is being processed in the background. ` +
                        `You can continue working while Johann orchestrates the task.\n\n` +
                        `**View progress:**\n` +
                        `- Watch the status bar for live updates\n` +
                        `- Use \`/tasks\` to view all background tasks\n` +
                        `- Run \`Johann: Show Background Tasks\` from the command palette\n\n` +
                        `You'll receive a notification when the task completes.`,
                );

                response.button({
                    command: 'johann.showBackgroundTasks',
                    title: '$(list-unordered) View All Tasks',
                });

                response.button({
                    command: 'johann.showTaskStatus',
                    title: '$(info) View This Task',
                    arguments: [taskId],
                });
            } else {
                // Synchronous execution (current behavior)
                await orchestrator.orchestrate(
                    userMessage,
                    fullContext,
                    subagentContext,
                    model,
                    response,
                    token,
                    request.toolInvocationToken,
                );
            }

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

            return {
                metadata: {
                    command: 'orchestrate',
                    success: true,
                    summary: userMessage.substring(0, 200),
                },
            };
        },
    );

    participant.iconPath = new vscode.ThemeIcon('hubot');

    // === FOLLOWUP PROVIDER ===
    // Suggests contextual next steps after a response, like native Copilot.
    participant.followupProvider = {
        provideFollowups(
            result: JohannChatResult,
            _context: vscode.ChatContext,
            _token: vscode.CancellationToken,
        ): vscode.ChatFollowup[] {
            const followups: vscode.ChatFollowup[] = [];

            if (result.metadata?.command === 'help') {
                followups.push({
                    prompt: '/status',
                    label: 'Show status',
                });
            }

            return followups;
        },
    };

    // === FEEDBACK LOGGING ===
    disposables.push(
        participant.onDidReceiveFeedback((feedback: vscode.ChatResultFeedback) => {
            logger.info(`Chat feedback: ${feedback.kind === 1 ? 'helpful' : 'unhelpful'}`);
        }),
    );

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

            const items = entries.map((name) => ({
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
                        '.vscode',
                        'johann',
                        selected.label,
                    );
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                }
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('johann.clearMemory', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Clear all Johann memory entries?',
                { modal: true },
                'Clear',
            );

            if (answer === 'Clear') {
                const memory = orchestrator.getMemory();
                await memory.clearMemory();
                vscode.window.showInformationMessage('Johann: Memory cleared.');
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('johann.showLog', () => {
            logger.show();
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('johann.showDebugLog', async (uri?: vscode.Uri) => {
            if (uri) {
                // Opened via button with URI argument
                try {
                    const doc = await vscode.workspace.openTextDocument(uri);
                    await vscode.window.showTextDocument(doc);
                    return;
                } catch {
                    // Fall through to directory scan
                }
            }

            // Fallback: find the most recent debug log
            const folders = vscode.workspace.workspaceFolders;
            if (!folders) {
                vscode.window.showInformationMessage('Johann: No workspace open.');
                return;
            }

            const debugDir = vscode.Uri.joinPath(folders[0].uri, '.vscode', 'johann', 'debug');
            try {
                const entries = await vscode.workspace.fs.readDirectory(debugDir);
                const mdFiles = entries
                    .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.md'))
                    .map(([name]) => name)
                    .sort()
                    .reverse();

                if (mdFiles.length === 0) {
                    vscode.window.showInformationMessage('Johann: No debug logs found.');
                    return;
                }

                const logUri = vscode.Uri.joinPath(debugDir, mdFiles[0]);
                const doc = await vscode.workspace.openTextDocument(logUri);
                await vscode.window.showTextDocument(doc);
            } catch {
                vscode.window.showInformationMessage('Johann: No debug logs found.');
            }
        }),
    );

    // Model diagnostics command
    disposables.push(
        vscode.commands.registerCommand('johann.showModelDiagnostics', async () => {
            const modelPicker = orchestrator.getModelPicker();
            const diagnostics = await modelPicker.getModelDiagnostics();

            const panel = vscode.window.createWebviewPanel(
                'johannModelDiagnostics',
                'Johann Model Diagnostics',
                vscode.ViewColumn.One,
                {},
            );

            panel.webview.html = `<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }
        pre {
            white-space: pre-wrap;
            background: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
        }
        h3 { color: var(--vscode-textLink-foreground); }
    </style>
</head>
<body>
    <pre>${diagnostics}</pre>
</body>
</html>`;
        }),
    );

    // Disable model picker command
    disposables.push(
        vscode.commands.registerCommand('johann.disableModelPicker', async () => {
            const models = await orchestrator.getModelPicker().getAllModels();

            if (models.length === 0) {
                vscode.window.showErrorMessage(
                    'No models available. Cannot configure fixed model.',
                );
                return;
            }

            const items = models.map((m) => ({
                label: m.name,
                description: `Tier ${m.tier} — ${m.family}`,
                detail: m.vendor,
                modelInfo: m,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select the fixed model to use when picker is disabled',
                title: 'Disable Model Picker - Choose Fixed Model',
            });

            if (selected) {
                const config = vscode.workspace.getConfiguration('johann');
                await config.update(
                    'modelPickerEnabled',
                    false,
                    vscode.ConfigurationTarget.Workspace,
                );
                await config.update(
                    'fixedModel',
                    selected.modelInfo.family,
                    vscode.ConfigurationTarget.Workspace,
                );

                vscode.window.showInformationMessage(
                    `Model picker disabled. Johann will now use: ${selected.label}`,
                );
            }
        }),
    );

    // Enable model picker command
    disposables.push(
        vscode.commands.registerCommand('johann.enableModelPicker', async () => {
            const config = vscode.workspace.getConfiguration('johann');
            await config.update('modelPickerEnabled', true, vscode.ConfigurationTarget.Workspace);

            vscode.window.showInformationMessage(
                'Model picker enabled. Johann will intelligently select models based on task complexity.',
            );
        }),
    );

    // Background task commands
    const taskManager = BackgroundTaskManager.getInstance();

    disposables.push(
        vscode.commands.registerCommand('johann.showBackgroundTasks', async () => {
            const allTasks = taskManager.getAllTasks();

            if (allTasks.length === 0) {
                vscode.window.showInformationMessage('Johann: No background tasks.');
                return;
            }

            const items = allTasks.map((task) => {
                const statusIcon =
                    task.status === 'running'
                        ? '$(sync~spin)'
                        : task.status === 'completed'
                          ? '$(check)'
                          : task.status === 'failed'
                            ? '$(error)'
                            : task.status === 'cancelled'
                              ? '$(circle-slash)'
                              : '$(debug-pause)';

                const progress = task.progress?.percentage ?? 0;
                const phase = task.progress?.phase ?? 'Starting';

                return {
                    label: `${statusIcon} ${task.sessionId}`,
                    description: `${task.status} — ${progress}%`,
                    detail: phase,
                    task,
                };
            });

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a background task to view details',
            });

            if (selected) {
                // Show task details in a new document
                const summary = taskManager.getTaskSummary(selected.task.id);
                const doc = await vscode.workspace.openTextDocument({
                    content: summary,
                    language: 'markdown',
                });
                await vscode.window.showTextDocument(doc);
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('johann.showTaskStatus', async (taskId?: string) => {
            if (!taskId) {
                // Prompt user to select a task
                const allTasks = taskManager.getAllTasks();
                if (allTasks.length === 0) {
                    vscode.window.showInformationMessage('Johann: No background tasks.');
                    return;
                }

                const items = allTasks.map((task) => ({
                    label: task.sessionId,
                    description: task.status,
                    taskId: task.id,
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select a task to view status',
                });

                if (!selected) {
                    return;
                }

                taskId = selected.taskId;
            }

            const summary = taskManager.getTaskSummary(taskId);
            const doc = await vscode.workspace.openTextDocument({
                content: summary,
                language: 'markdown',
            });
            await vscode.window.showTextDocument(doc);
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('johann.cancelTask', async (taskId?: string) => {
            if (!taskId) {
                // Prompt user to select a running task
                const allTasks = taskManager
                    .getAllTasks()
                    .filter((t) => t.status === 'running' || t.status === 'paused');

                if (allTasks.length === 0) {
                    vscode.window.showInformationMessage('Johann: No active tasks to cancel.');
                    return;
                }

                const items = allTasks.map((task) => ({
                    label: task.sessionId,
                    description: `${task.status} — ${task.progress?.percentage ?? 0}%`,
                    taskId: task.id,
                }));

                const selected = await vscode.window.showQuickPick(items, {
                    placeHolder: 'Select a task to cancel',
                });

                if (!selected) {
                    return;
                }

                taskId = selected.taskId;
            }

            const answer = await vscode.window.showWarningMessage(
                `Cancel task ${taskId}?`,
                { modal: true },
                'Cancel Task',
            );

            if (answer === 'Cancel Task') {
                const cancelled = await taskManager.cancelTask(taskId);
                if (cancelled) {
                    vscode.window.showInformationMessage(`Johann: Task ${taskId} cancelled.`);
                } else {
                    vscode.window.showErrorMessage(`Johann: Failed to cancel task ${taskId}.`);
                }
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('johann.clearCompletedTasks', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Clear all completed background tasks?',
                { modal: true },
                'Clear',
            );

            if (answer === 'Clear') {
                await taskManager.clearCompletedTasks();
                vscode.window.showInformationMessage('Johann: Completed tasks cleared.');
            }
        }),
    );

    // Clean up heartbeat on deactivate
    disposables.push({ dispose: () => heartbeat.dispose() });
    disposables.push({ dispose: () => logger.dispose() });

    return disposables;
}
