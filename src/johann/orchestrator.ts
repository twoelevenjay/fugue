import * as vscode from 'vscode';
import {
    JohannSession,
    OrchestrationPlan,
    Subtask,
    SubtaskResult,
    EscalationRecord,
    OrchestratorConfig,
    DEFAULT_CONFIG,
    ModelInfo,
} from './types';
import { ModelPicker } from './modelPicker';
import { TaskDecomposer } from './taskDecomposer';
import { SubagentManager } from './subagentManager';
import { MemorySystem } from './memory';
import { getCopilotAgentSettings, getConfig } from './config';
import { getLogger } from './logger';
import { classifyError, withRetry, REVIEW_RETRY_POLICY, ClassifiedError, extractErrorMessage } from './retry';
import { DebugConversationLog } from './debugConversationLog';
import { WorktreeManager } from './worktreeManager';
import { ExecutionLedger } from './executionLedger';
import { ChatProgressReporter } from './chatProgressReporter';
import { BackgroundProgressReporter } from './backgroundProgressReporter';
import { BackgroundTaskManager } from './backgroundTaskManager';
import { ProgressReporter } from './progressEvents';
import { RateLimitGuard } from './rateLimitGuard';
import { SessionPersistence, ResumableSession } from './sessionPersistence';
// MultiPassExecutor and ToolVerifier are not currently wired for agentic execution.
// import { MultiPassExecutor } from './multiPassExecutor';
// import { ToolVerifier } from './toolVerifier';
import { getExecutionWaves, getDownstreamTasks, validateGraph } from './graphManager';
import { HookRunner, createDefaultHookRunner } from './hooks';
import { FlowCorrectionManager } from './flowCorrection';
import { DelegationGuard } from './delegationPolicy';
import { SelfHealingDetector } from './selfHealing';
import { LocalSkillStore } from './skillStore';
import { SkillValidator } from './skillValidator';
import { SkillDoc } from './skillTypes';
import { RunStateManager, RunPhase } from './runState';
import { scanBootstrapContext, buildCapabilitySummary, BootstrapResult } from './bootstrapContext';
import { detectSelfReferentialTask, SelfAwarenessResult } from './selfAwareness';

// ============================================================================
// ORCHESTRATOR — The top-level controller
//
// Flow:
// 1. User sends request to @johann
// 2. Orchestrator uses user's model to create an execution plan
// 3. For each subtask:
//    - Detect if multi-pass should be used (based on task type + complexity)
//    - If multi-pass: use MultiPassExecutor for structured verification
//    - If single-pass: pick model → execute → review → escalate if needed
// 4. Merge results and respond
// 5. Write to persistent memory
//
// Multi-pass integration:
// - Draft→Critique→Revise for docs/specs/plans
// - Self-consistency voting for debugging/analysis
// - Tool-verified loops for codegen
// - Two-pass rubric for code review
// ============================================================================

const MERGE_SYSTEM_PROMPT = `You are Johann, collecting and synthesizing results from multiple subagents that worked on parts of a larger task.

Each subagent was a GitHub Copilot session with full tool access. They used their tools to create files, run commands, and make actual changes in the workspace. Their outputs describe what they DID.

Given the original request and the results from each subtask, produce a unified, coherent response.

RULES:
- Synthesize, don't just concatenate. The user shouldn't see the internal decomposition.
- If all subtasks succeeded, present a clear summary of what was built/changed.
- If some subtasks failed, be transparent about what was accomplished and what wasn't.
- Verify consistency between subtask outputs: do imports match? Do interfaces align? Are there integration gaps?
- If you spot integration issues, flag them clearly with specific details.
- Do NOT re-output all the code verbatim. The files already exist. Summarize what was created and highlight any issues.
- Be thorough but organized.

## OUTPUT FORMAT — MANDATORY

Your response MUST use ONLY these sections (pick the ones that apply):

### What Was Done
[List of concrete actions taken: files created, commands run, services started, etc.]

### What Was Created
[List of artifacts: files, directories, configurations, database entries, etc.]

### Issues Found
[Any integration problems, conflicts, or gaps between subtasks. Omit if none.]

### What Failed
[ONLY if subtasks failed: describe what was attempted and what went wrong. State that Johann will retry.]

DO NOT add any sections not listed above. DO NOT add "Next Steps", "Manual Steps", "Recommendations", "What You Should Do", or any section that tells the user to take action.

## ABSOLUTE PROHIBITION — USER-DIRECTED CONTENT

You are an EXECUTION REPORT. You do NOT give instructions. You do NOT suggest next steps. You do NOT ask questions.

If you find yourself writing ANY of these, STOP and DELETE IT:
- "Please run..." / "Run the following..."
- "You should..." / "You need to..." / "You'll want to..."
- "Make sure to..." / "Don't forget to..."
- "Ask [someone] to..." / "Tell [someone] to..."
- "Here's what you need to do" / "What You Need to Do"
- "Manual Investigation" / "Manual Steps"
- "Next Steps Required" / "Next Steps" / "Recommended Next Steps"
- "Would you like me to help...?" / "Would you like me to..."
- "Please share any error messages..."
- "Consider..." (when suggesting the user do something)
- "You can then..." / "After that, you can..."
- "To fix this, run..." / "To resolve this..."
- Any code block formatted as a command for the user to run
- Any numbered list of actions for the user to perform
- Any question asking the user for input

If a subtask FAILED:
- Report WHAT was attempted and WHY it failed (technical details)
- Report what DID succeed (partial progress is still progress)
- End with: "Johann will retry this with a different approach on the next run."
- DO NOT give the user a to-do list. DO NOT suggest manual commands.

If ALL subtasks SUCCEEDED:
- Report what was built/changed
- That's it. No "next steps", no "recommendations", no suggestions.

If a subtask was marked failed by review but its output shows real tool usage (terminal commands run, files created):
- Check the output for evidence of real work
- Report it as partially successful if the work was actually done
- The review system can be overly strict — trust the evidence

The user expects a REPORT of what happened. Not a manual. Not a tutorial. Not a troubleshooting guide. A REPORT.`;

export class Orchestrator {
    private modelPicker: ModelPicker;
    private taskDecomposer: TaskDecomposer;
    private subagentManager: SubagentManager;
    private memory: MemorySystem;
    private config: OrchestratorConfig;
    private hookRunner: HookRunner;
    private rateLimitGuard: RateLimitGuard;
    private flowCorrection: FlowCorrectionManager;
    private delegationGuard: DelegationGuard;
    private selfHealing: SelfHealingDetector;
    private skillStore: LocalSkillStore;
    private skillValidator: SkillValidator;

    constructor(config: OrchestratorConfig = DEFAULT_CONFIG) {
        this.config = config;
        this.modelPicker = new ModelPicker();
        this.taskDecomposer = new TaskDecomposer();
        this.subagentManager = new SubagentManager();
        this.memory = new MemorySystem(config);
        this.hookRunner = createDefaultHookRunner();
        this.rateLimitGuard = new RateLimitGuard();
        this.flowCorrection = new FlowCorrectionManager();
        this.delegationGuard = new DelegationGuard();
        this.selfHealing = new SelfHealingDetector();
        this.skillStore = new LocalSkillStore();
        this.skillValidator = new SkillValidator();
    }

    /**
     * Resume and complete an interrupted session from disk.
     * Skips already-completed subtasks. Planning cost is never re-paid.
     *
     * Returns false if there is nothing to resume.
     */
    async resumeSession(
        resumable: ResumableSession,
        userModel: vscode.LanguageModelChat,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
    ): Promise<boolean> {
        if (!resumable.plan || resumable.pendingSubtaskIds.length === 0) {
            return false;
        }

        const reporter = new ChatProgressReporter(response);

        // Re-open the same session persistence directory
        const persist = new SessionPersistence(resumable.sessionId);
        await persist.initialize();

        // Rebuild JohannSession from disk state
        const session: JohannSession = {
            sessionId: resumable.sessionId,
            originalRequest: resumable.originalRequest,
            plan: resumable.plan,
            status: 'executing',
            escalations: resumable.escalations,
            startedAt: resumable.startedAt,
            workspaceContext: resumable.workspaceContext,
        };

        await persist.writeSession(session);

        const plan = resumable.plan;

        const completed = resumable.completedSubtaskIds.length;
        const total = plan.subtasks.length;
        reporter.phase(
            'Resuming',
            `${completed}/${total} subtasks done, ${resumable.pendingSubtaskIds.length} remaining`,
        );

        // If a resume message was provided, log it and prepend to workspace context
        // so subagents get the course-correction instruction
        const resumeMessage = resumable.resumeMessage;
        if (resumeMessage) {
            await persist.appendExecutionLog('RESUME WITH MESSAGE', resumeMessage);
        }

        // Initialize debug log for the resumed run
        const debugLog = new DebugConversationLog(resumable.sessionId + '-resume');
        await debugLog.initialize();
        reporter.setDebugLogUri(debugLog.getLogUri());

        await debugLog.logEvent(
            'resume',
            `Resuming session with ${completed}/${total} subtasks completed${resumeMessage ? ` — message: ${resumeMessage}` : ''}`,
        );

        // Pre-populate results from completed subtasks
        const results = new Map<string, SubtaskResult>(resumable.subtaskResults);

        try {
            // == EXECUTION (RESUMED) ==
            reporter.phase('Executing', `${resumable.pendingSubtaskIds.length} remaining subtasks`);

            // Use workspace context from disk, plus any course-correction message
            let workspaceContext =
                resumable.workspaceContext || (await this.getMinimalWorkspaceContext());
            if (resumeMessage) {
                workspaceContext = `=== COURSE CORRECTION (from user on resume) ===\n${resumeMessage}\n\n---\n\n${workspaceContext}`;
            }

            // Initialize ledger for resumed session
            const resumeLedger = new ExecutionLedger(
                resumable.sessionId,
                resumable.originalRequest,
                plan.summary,
            );
            const resumeLedgerReady = await resumeLedger.initialize();
            if (resumeLedgerReady) {
                resumeLedger.registerSubtasks(
                    plan.subtasks.map((st) => ({ id: st.id, title: st.title })),
                );
                // Mark already-completed subtasks in the ledger
                for (const completedId of resumable.completedSubtaskIds) {
                    const result = results.get(completedId);
                    if (result) {
                        await resumeLedger.markCompleted(completedId, result.output);
                    }
                }
            }

            // Execute remaining subtasks using the same executePlan logic
            // (executePlan already skips completed tasks via the `completed` set)
            const newResults = await this.executePlan(
                plan,
                workspaceContext,
                reporter,
                token,
                debugLog,
                undefined, // no worktree manager for resume (keep it simple)
                persist,
                results, // pass prior results so dependencies are satisfied
                undefined, // no toolToken for resume
                resumeLedgerReady ? resumeLedger : undefined,
                this.hookRunner,
            );

            // Merge all results together
            for (const [k, v] of newResults) {
                results.set(k, v);
            }

            // == MERGE & RESPOND ==
            session.status = 'reviewing';
            await persist.writeSession(session);
            reporter.phase('Synthesizing', 'Merging subtask results');

            await this.mergeResults(
                session.originalRequest,
                plan,
                results,
                userModel,
                token,
                reporter.stream,
                debugLog,
            );

            reporter.showButtons();

            // == MEMORY ==
            session.status = 'completed';
            session.completedAt = new Date().toISOString();
            await persist.markCompleted(session);

            const subtaskResultSummaries = plan.subtasks.map((st) => ({
                title: st.title,
                model: st.result?.modelUsed || 'unknown',
                success: st.result?.success ?? false,
                notes: st.result?.reviewNotes || '',
            }));
            const overallSuccess = plan.subtasks.every((st) => st.result?.success);

            await this.memory.recordTaskCompletion(
                plan.summary,
                subtaskResultSummaries,
                overallSuccess,
            );

            await debugLog.finalize('completed');
        } catch (err) {
            session.status = 'failed';
            const classified = classifyError(err);

            await persist.markFailed(session, classified.message);
            if (session.plan) {
                await persist.writeEscalations(session.escalations);
            }

            this.renderErrorForUser(reporter.stream, classified, session);
            await debugLog.finalize('failed', classified.message);
        }

        return true;
    }

    /**
     * Get minimal workspace context (fallback for resume when context.txt is empty).
     */
    private async getMinimalWorkspaceContext(): Promise<string> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) {
            return 'No workspace open.';
        }
        return `Workspace: ${folders[0].uri.fsPath}`;
    }

    /**
     * Start a background orchestration task.
     * Returns immediately with a task ID, while the orchestration runs asynchronously.
     *
     * @param request - The user's original request
     * @param fullContext - Complete context for planning/merge (system prompt + workspace + memory + conversation)
     * @param subagentContext - Minimal workspace context for subagents (project structure only, no Johann identity)
     * @param userModel - The LLM model selected by the user
     * @param token - Cancellation token
     * @param toolToken - Tool invocation token from the chat request, can be undefined if unavailable
     * @returns Task ID for tracking progress
     */
    async startBackgroundOrchestration(
        request: string,
        fullContext: string,
        subagentContext: string,
        userModel: vscode.LanguageModelChat,
        toolToken?: vscode.ChatParticipantToolToken,
    ): Promise<string> {
        const taskManager = BackgroundTaskManager.getInstance();

        // Generate session ID
        const sessionId = this.generateSessionId();
        const summary = request.substring(0, 100) + (request.length > 100 ? '...' : '');

        // Create background task
        const task = await taskManager.createTask(
            sessionId,
            request,
            summary,
            0, // Initial totalSubtasks - will be updated after planning
        );

        // Execute orchestration in background
        // Note: We don't await this - it runs asynchronously
        this.executeOrchestrationInBackground(
            task.id,
            request,
            fullContext,
            subagentContext,
            userModel,
            task.cancellationToken.token,
            toolToken,
        ).catch((err) => {
            // Catch any uncaught rejections from the background orchestration
            // (e.g. if BackgroundProgressReporter construction fails)
            getLogger().error(`Background orchestration failed unexpectedly: ${err}`);
            taskManager.updateStatus(task.id, 'failed', extractErrorMessage(err)).catch(() => {});
        });

        return task.id;
    }

    /**
     * Execute an orchestration task in the background.
     * Updates BackgroundTaskManager throughout execution.
     * This method runs asynchronously and should not be awaited by the caller.
     */
    private async executeOrchestrationInBackground(
        taskId: string,
        request: string,
        fullContext: string,
        subagentContext: string,
        userModel: vscode.LanguageModelChat,
        token: vscode.CancellationToken,
        toolToken?: vscode.ChatParticipantToolToken,
    ): Promise<void> {
        const taskManager = BackgroundTaskManager.getInstance();
        const task = taskManager.getTask(taskId);
        if (!task) {
            return;
        }

        const session: JohannSession = {
            sessionId: task.sessionId,
            originalRequest: request,
            plan: null,
            status: 'planning',
            escalations: [],
            startedAt: new Date().toISOString(),
            workspaceContext: subagentContext,
        };

        // Create background progress reporter
        const reporter = new BackgroundProgressReporter(taskId);

        // Initialize session persistence
        const persist = new SessionPersistence(session.sessionId);
        const persistReady = await persist.initialize();
        if (!persistReady) {
            reporter.emit({
                type: 'note',
                message: 'Session persistence unavailable',
                style: 'warning',
            });
        }
        await persist.writeSession(session);
        await persist.writeContext(subagentContext);

        // Initialize debug log
        const debugLog = new DebugConversationLog(session.sessionId);
        await debugLog.initialize();

        // Ensure memory directory exists
        await this.memory.ensureMemoryDir();

        // Get memory context
        const memoryContext = await this.memory.getRecentMemoryContext();

        // == BOOTSTRAP: Environment detection for background mode ==
        let enrichedFullContext = fullContext;
        let enrichedSubagentContext = subagentContext;
        try {
            const bootstrapResult = await scanBootstrapContext();
            if (bootstrapResult.hasContext) {
                enrichedFullContext = bootstrapResult.contextBlock + '\n\n' + fullContext;
                const capSummary = buildCapabilitySummary(bootstrapResult.capabilities);
                if (capSummary) {
                    enrichedSubagentContext = capSummary + '\n\n' + subagentContext;
                }
                await debugLog.logEvent(
                    'other',
                    `Bootstrap: ${bootstrapResult.capabilities.map((c) => c.name).join(', ')} detected`,
                );
            }
        } catch {
            // Non-critical
        }

        try {
            // == PHASE 1: PLANNING ==
            reporter.phase('Planning', 'Analyzing request and creating plan');

            await debugLog.logEvent(
                'planning',
                `Starting planning for: ${request.substring(0, 200)}`,
            );
            await persist.appendExecutionLog(
                'PLANNING',
                `Starting planning for: ${request.substring(0, 200)}`,
            );

            const plan = await this.taskDecomposer.decompose(
                request,
                enrichedFullContext,
                memoryContext,
                userModel,
                token,
                undefined, // No stream in background mode
                debugLog,
                persist,
            );

            session.plan = plan;
            session.status = 'executing';

            // Persist plan
            await persist.writePlan(plan);
            await persist.writeSession(session);
            await persist.appendExecutionLog(
                'PLAN SAVED',
                `${plan.subtasks.length} subtasks, strategy: ${plan.strategy}`,
            );

            // Update progress reporter with plan
            reporter.showPlan(plan);
            reporter.setTotalSubtasks(plan.subtasks.length);

            // == PHASE 2: EXECUTION ==
            reporter.phase('Executing', `${plan.subtasks.length} subtasks`);

            await debugLog.logEvent(
                'subtask-execution',
                `Starting execution of ${plan.subtasks.length} subtasks`,
            );

            // Initialize the Execution Ledger for shared real-time context
            const ledger = new ExecutionLedger(session.sessionId, request, plan.summary);
            const ledgerReady = await ledger.initialize();
            if (ledgerReady) {
                ledger.registerSubtasks(
                    plan.subtasks.map((st) => ({ id: st.id, title: st.title })),
                );
                await debugLog.logEvent(
                    'other',
                    `Execution ledger initialized with ${plan.subtasks.length} subtasks`,
                );
            }

            // Initialize worktree manager for parallel isolation
            let worktreeManager: WorktreeManager | undefined;
            if (this.config.useWorktrees && plan.strategy !== 'serial') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot) {
                    worktreeManager = new WorktreeManager(workspaceRoot, session.sessionId);
                    const wtInitialized = await worktreeManager.initialize();
                    if (wtInitialized) {
                        await debugLog.logEvent(
                            'worktree',
                            `Worktree manager initialized (base: ${worktreeManager.getBaseBranch()})`,
                        );
                    } else {
                        worktreeManager = undefined;
                        reporter.emit({
                            type: 'note',
                            message: 'Git worktree isolation unavailable',
                            style: 'warning',
                        });
                    }
                }
            }

            try {
                const results = await this.executePlan(
                    plan,
                    enrichedSubagentContext,
                    reporter,
                    token,
                    debugLog,
                    worktreeManager,
                    persist,
                    undefined,
                    toolToken,
                    ledgerReady ? ledger : undefined,
                    this.hookRunner,
                );

                // == PHASE 3: MERGE & RESPOND ==
                session.status = 'reviewing';
                await persist.writeSession(session);
                reporter.phase('Synthesizing', 'Merging subtask results');

                await debugLog.logEvent('merge', 'Starting result synthesis');

                const _finalOutput = await this.mergeResults(
                    request,
                    plan,
                    results,
                    userModel,
                    token,
                    undefined, // No stream in background mode
                    debugLog,
                );

                // Store final output in task summary
                const summary = reporter.getSummary();
                await taskManager.updateStatus(taskId, 'completed', undefined);

                // Update task with completion summary
                const completedTask = taskManager.getTask(taskId);
                if (completedTask) {
                    completedTask.summary = `${summary.completedSubtasks}/${summary.totalSubtasks} subtasks completed`;
                }
            } finally {
                // Always clean up worktrees
                if (worktreeManager) {
                    try {
                        await worktreeManager.cleanupAll();
                        await debugLog.logEvent('worktree', 'All worktrees cleaned up');
                    } catch {
                        // Don't let cleanup failure break the flow
                    }
                }
            }

            // == PHASE 4: MEMORY ==
            session.status = 'completed';
            session.completedAt = new Date().toISOString();

            await persist.markCompleted(session);

            const subtaskResultSummaries = plan.subtasks.map((st) => ({
                title: st.title,
                model: st.result?.modelUsed || 'unknown',
                success: st.result?.success ?? false,
                notes: st.result?.reviewNotes || '',
            }));

            const overallSuccess = plan.subtasks.every((st) => st.result?.success);

            await this.memory.recordTaskCompletion(
                plan.summary,
                subtaskResultSummaries,
                overallSuccess,
            );

            // Record escalation learnings
            for (const escalation of session.escalations) {
                if (escalation.attempts.length > 1) {
                    await this.memory.recordLearning(
                        `Escalation pattern for subtask ${escalation.subtaskId}`,
                        `Tried ${escalation.attempts.length} models: ${escalation.attempts.map((a) => `${a.modelId} (tier ${a.tier}): ${a.success ? 'OK' : a.reason}`).join(' → ')}`,
                        ['escalation', 'model-selection'],
                    );
                }
            }

            await debugLog.finalize('completed');
        } catch (err) {
            session.status = 'failed';
            const classified = classifyError(err);

            await persist.markFailed(session, classified.message);
            if (session.plan) {
                await persist.writeEscalations(session.escalations);
            }

            if (session.plan) {
                await this.savePlanForRecovery(session, classified);
            }

            await this.memory.recordError(
                classified.message,
                `Session: ${session.sessionId}, Category: ${classified.category}, Request: ${request.substring(0, 200)}`,
            );

            await debugLog.finalize('failed', classified.message);

            // Update background task with failure
            await taskManager.updateStatus(taskId, 'failed', classified.message);
        }
    }

    /**
     * Main entry point — orchestrate a user request.
     * Streams progress updates to the response stream.
     *
     * @param request - The user's original request
     * @param fullContext - Complete context for planning/merge (system prompt + workspace + memory + conversation)
     * @param subagentContext - Minimal workspace context for subagents (project structure only, no Johann identity)
     * @param userModel - The LLM model selected by the user
     * @param response - Chat response stream for live output
     * @param token - Cancellation token
     * @param toolToken - Tool invocation token from the chat request, needed for subagents to call tools
     */
    async orchestrate(
        request: string,
        fullContext: string,
        subagentContext: string,
        userModel: vscode.LanguageModelChat,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        toolToken?: vscode.ChatParticipantToolToken,
    ): Promise<void> {
        const session: JohannSession = {
            sessionId: this.generateSessionId(),
            originalRequest: request,
            plan: null,
            status: 'planning',
            escalations: [],
            startedAt: new Date().toISOString(),
            workspaceContext: subagentContext,
        };

        // Create progress reporter for structured chat output
        const reporter = new ChatProgressReporter(response);

        // === RunState: start run ===
        const runManager = RunStateManager.getInstance();
        await runManager.startRun(session.sessionId, request);

        // Wire cancellation → RunState
        const cancelListener = token.onCancellationRequested(async () => {
            await runManager.cancelRun();
        });

        // Initialize session persistence — everything goes to disk
        const persist = new SessionPersistence(session.sessionId);
        const persistReady = await persist.initialize();
        if (!persistReady) {
            response.markdown(
                '\n\n> **⚠️ Warning:** Session persistence failed to initialize. ' +
                    'The plan will only exist in memory and cannot be resumed if interrupted.\n\n',
            );
        }
        await persist.writeSession(session);
        await persist.writeContext(subagentContext);

        // Check Copilot settings and warn if low limits
        const copilotSettings = getCopilotAgentSettings();
        if (
            copilotSettings.readable &&
            copilotSettings.maxRequests > 0 &&
            copilotSettings.maxRequests < 50
        ) {
            reporter.emit({
                type: 'note',
                message: `**Copilot request limit is set to ${copilotSettings.maxRequests}.** Complex orchestrations may be interrupted. Consider increasing \`github.copilot.chat.agent.maxRequests\` or type \`/yolo on\` for guidance.`,
                style: 'warning',
            });
        }

        // Ensure memory directory exists
        await this.memory.ensureMemoryDir();

        // Initialize debug conversation log
        const debugLog = new DebugConversationLog(session.sessionId);
        await debugLog.initialize();

        // Set debug log URI on reporter for the "Open Debug Log" button
        reporter.setDebugLogUri(debugLog.getLogUri());

        // Get memory context
        const memoryContext = await this.memory.getRecentMemoryContext();

        // == BOOTSTRAP: Scan workspace for project environment context ==
        // This detects DDEV, Docker, package managers, WordPress, etc.
        // and builds capability descriptions that tell planners and subagents
        // what tools are available (ddev wp, ddev exec, npm, etc.)
        let bootstrapResult: BootstrapResult | undefined;
        try {
            bootstrapResult = await scanBootstrapContext();
            if (bootstrapResult.hasContext) {
                await debugLog.logEvent(
                    'other',
                    `Bootstrap: ${bootstrapResult.capabilities.map((c) => c.name).join(', ')} detected`,
                );
            }
        } catch (bootstrapErr) {
            // Non-critical — proceed without bootstrap context
            await debugLog.logEvent(
                'other',
                `Bootstrap scan failed: ${bootstrapErr instanceof Error ? bootstrapErr.message : String(bootstrapErr)}`,
            );
        }

        // == SELF-AWARENESS: Detect self-referential tasks ==
        // When Johann is asked to work on his own source code, subagents
        // need architecture context and elevated execution limits.
        let selfAwareness: SelfAwarenessResult | undefined;
        try {
            selfAwareness = await detectSelfReferentialTask(request, subagentContext);
            if (selfAwareness.isSelfReferential) {
                await debugLog.logEvent(
                    'other',
                    `Self-referential task detected (confidence: ${(selfAwareness.confidence * 100).toFixed(0)}%): ${selfAwareness.signals.join(', ')}`,
                );
                reporter.emit({
                    type: 'note',
                    message: `🪞 **Self-referential mode:** Johann detected that this task involves modifying his own source code. Elevated execution limits applied.`,
                });
            }
        } catch (selfAwareErr) {
            // Non-critical — proceed without self-awareness
            await debugLog.logEvent(
                'other',
                `Self-awareness detection failed: ${selfAwareErr instanceof Error ? selfAwareErr.message : String(selfAwareErr)}`,
            );
        }

        // Enrich contexts with bootstrap information
        let enrichedFullContext = fullContext;
        let enrichedSubagentContext = subagentContext;
        if (bootstrapResult?.hasContext) {
            // Planning gets full bootstrap (capabilities + file contents)
            enrichedFullContext = bootstrapResult.contextBlock + '\n\n' + fullContext;
            // Subagents get compact capability summary (no file contents)
            const capSummary = buildCapabilitySummary(bootstrapResult.capabilities);
            if (capSummary) {
                enrichedSubagentContext = capSummary + '\n\n' + subagentContext;
            }
        }

        // Inject self-awareness context for self-referential tasks
        if (selfAwareness?.isSelfReferential && selfAwareness.architectureContext) {
            enrichedSubagentContext = selfAwareness.architectureContext + '\n\n' + enrichedSubagentContext;
            enrichedFullContext = selfAwareness.architectureContext + '\n\n' + enrichedFullContext;
        }

        try {
            // == PHASE 1: PLANNING ==
            await this.hookRunner.run('on_session_start', { request, session });
            reporter.phase('Planning', 'Analyzing request and creating plan');

            await debugLog.logEvent(
                'planning',
                `Starting planning for: ${request.substring(0, 200)}`,
            );
            await persist.appendExecutionLog(
                'PLANNING',
                `Starting planning for: ${request.substring(0, 200)}`,
            );

            await this.hookRunner.run('before_planning', { request, session });

            const plan = await this.taskDecomposer.decompose(
                request,
                enrichedFullContext,
                memoryContext,
                userModel,
                token,
                reporter.stream,
                debugLog,
                persist,
            );

            session.plan = plan;
            session.status = 'executing';

            await this.hookRunner.run('after_planning', { request, session, plan });

            // PERSIST — Plan to disk IMMEDIATELY. This is the most critical write.
            // Planning LLM cost is paid once and never repeated on resume.
            await persist.writePlan(plan);
            await persist.writeSession(session);
            await persist.appendExecutionLog(
                'PLAN SAVED',
                `${plan.subtasks.length} subtasks, strategy: ${plan.strategy}`,
            );

            // == SELF-AWARENESS: Elevate subtask complexity for self-referential tasks ==
            // When Johann is working on his own code, tasks that look "moderate" are
            // really "complex" because they require reading many large source files.
            if (selfAwareness?.isSelfReferential) {
                const complexityFloor = selfAwareness.recommendedComplexity;
                const complexityOrder = ['trivial', 'simple', 'moderate', 'complex', 'expert'];
                const floorIdx = complexityOrder.indexOf(complexityFloor);
                let elevated = 0;
                for (const subtask of plan.subtasks) {
                    const currentIdx = complexityOrder.indexOf(subtask.complexity);
                    if (currentIdx < floorIdx) {
                        subtask.complexity = complexityFloor;
                        elevated++;
                    }
                }
                if (elevated > 0) {
                    await debugLog.logEvent(
                        'other',
                        `Self-awareness: elevated ${elevated} subtask(s) to '${complexityFloor}' complexity`,
                    );
                }
            }

            // Show the plan
            reporter.showPlan(plan);

            // === RunState: register tasks from plan ===
            await runManager.setPlanSummary(plan.summary);
            await runManager.registerTasks(
                plan.subtasks.map((st) => ({
                    id: st.id,
                    title: st.title,
                    phase: this.inferRunPhase(st.title),
                })),
            );

            // Discover available models
            const modelSummary = await this.modelPicker.getModelSummary();
            reporter.showModels(modelSummary);

            // == PHASE 2: EXECUTION ==
            reporter.phase('Executing', `${plan.subtasks.length} subtasks`);

            await debugLog.logEvent(
                'subtask-execution',
                `Starting execution of ${plan.subtasks.length} subtasks`,
            );

            // Initialize the Execution Ledger for shared real-time context
            const ledger2 = new ExecutionLedger(session.sessionId, request, plan.summary);
            const ledger2Ready = await ledger2.initialize();
            if (ledger2Ready) {
                ledger2.registerSubtasks(
                    plan.subtasks.map((st) => ({ id: st.id, title: st.title })),
                );
                await debugLog.logEvent(
                    'other',
                    `Execution ledger initialized with ${plan.subtasks.length} subtasks`,
                );
            }

            // Initialize worktree manager for parallel isolation
            let worktreeManager: WorktreeManager | undefined;
            if (this.config.useWorktrees && plan.strategy !== 'serial') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot) {
                    worktreeManager = new WorktreeManager(workspaceRoot, session.sessionId);
                    const wtInitialized = await worktreeManager.initialize();
                    if (wtInitialized) {
                        await debugLog.logEvent(
                            'worktree',
                            `Worktree manager initialized (base: ${worktreeManager.getBaseBranch()})`,
                        );
                    } else {
                        worktreeManager = undefined;
                        reporter.emit({
                            type: 'note',
                            message:
                                'Git worktree isolation unavailable (not a git repo or git not found). Parallel subtasks will share the workspace.',
                        });
                    }
                }
            }

            try {
                // Pass enrichedSubagentContext (workspace context + environment capabilities,
                // WITHOUT Johann's identity) so subagents know what tools are available
                const results = await this.executePlan(
                    plan,
                    enrichedSubagentContext,
                    reporter,
                    token,
                    debugLog,
                    worktreeManager,
                    persist,
                    undefined,
                    toolToken,
                    ledger2Ready ? ledger2 : undefined,
                    this.hookRunner,
                );

                // == PHASE 3: MERGE & RESPOND ==
                session.status = 'reviewing';
                await persist.writeSession(session);
                reporter.phase('Synthesizing', 'Merging subtask results');

                await debugLog.logEvent('merge', 'Starting result synthesis');

                await this.hookRunner.run('before_merge', { request, session, plan });

                const _finalOutput = await this.mergeResults(
                    request,
                    plan,
                    results,
                    userModel,
                    token,
                    reporter.stream,
                    debugLog,
                );

                await this.hookRunner.run('after_merge', { request, session, plan });

                // Render action buttons
                reporter.showButtons();
            } finally {
                // Always clean up worktrees, even on error
                if (worktreeManager) {
                    try {
                        await worktreeManager.cleanupAll();
                        await debugLog.logEvent('worktree', 'All worktrees cleaned up');
                    } catch {
                        // Don't let cleanup failure break the flow
                    }
                }
            }

            // == PHASE 4: MEMORY ==
            session.status = 'completed';
            session.completedAt = new Date().toISOString();

            // PERSIST — Mark session complete on disk
            await persist.markCompleted(session);

            const subtaskResultSummaries = plan.subtasks.map((st) => ({
                title: st.title,
                model: st.result?.modelUsed || 'unknown',
                success: st.result?.success ?? false,
                notes: st.result?.reviewNotes || '',
            }));

            const overallSuccess = plan.subtasks.every((st) => st.result?.success);

            await this.memory.recordTaskCompletion(
                plan.summary,
                subtaskResultSummaries,
                overallSuccess,
            );

            // Record any learnings from escalations
            for (const escalation of session.escalations) {
                if (escalation.attempts.length > 1) {
                    await this.memory.recordLearning(
                        `Escalation pattern for subtask ${escalation.subtaskId}`,
                        `Tried ${escalation.attempts.length} models: ${escalation.attempts.map((a) => `${a.modelId} (tier ${a.tier}): ${a.success ? 'OK' : a.reason}`).join(' → ')}`,
                        ['escalation', 'model-selection'],
                    );
                }
            }

            // Finalize debug log on success
            await this.hookRunner.run('on_session_end', { request, session, plan });

            // === RunState: mark completed ===
            await runManager.completeRun();
            cancelListener.dispose();

            // Log delegation stats
            const delegationStats = this.delegationGuard.getStats();
            await debugLog.logEvent(
                'other',
                `Delegation stats: spawned=${delegationStats.totalSpawned}, ` +
                    `blocked=${delegationStats.delegationsBlocked}, ` +
                    `maxDepth=${delegationStats.maxDepthReached}, ` +
                    `frozen=${delegationStats.frozen}, ` +
                    `runawaySignals=${delegationStats.runawaySignals}`,
            );

            await debugLog.finalize('completed');
        } catch (err) {
            session.status = 'failed';
            const classified = classifyError(err);

            await this.hookRunner.run('on_error', {
                request,
                session,
                error: new Error(classified.message),
            });

            // === RunState: mark failed ===
            await runManager.failRun(classified.message);
            cancelListener.dispose();

            // PERSIST — Mark session failed on disk with error details
            await persist.markFailed(session, classified.message);
            if (session.plan) {
                await persist.writeEscalations(session.escalations);
            }

            // Save the plan to memory if we got that far, so it can be resumed
            if (session.plan) {
                await this.savePlanForRecovery(session, classified);
            }

            // Provide category-specific error guidance
            this.renderErrorForUser(reporter.stream, classified, session);

            await this.memory.recordError(
                classified.message,
                `Session: ${session.sessionId}, Category: ${classified.category}, Request: ${request.substring(0, 200)}`,
            );

            // Finalize debug log on failure
            await this.hookRunner.run('on_session_end', { request, session });
            await debugLog.finalize('failed', classified.message);
        }
    }

    /**
     * Execute the orchestration plan, respecting dependencies and strategy.
     * When multiple subtasks are ready (all dependencies satisfied) and
     * parallel execution is enabled, runs them concurrently via Promise.all.
     */
    private async executePlan(
        plan: OrchestrationPlan,
        workspaceContext: string,
        reporter: ProgressReporter,
        token: vscode.CancellationToken,
        debugLog: DebugConversationLog,
        worktreeManager?: WorktreeManager,
        persist?: SessionPersistence,
        priorResults?: Map<string, SubtaskResult>,
        toolToken?: vscode.ChatParticipantToolToken,
        ledger?: ExecutionLedger,
        hookRunner?: HookRunner,
    ): Promise<Map<string, SubtaskResult>> {
        const results = new Map<string, SubtaskResult>(priorResults || []);
        const completed = new Set<string>(priorResults ? priorResults.keys() : []);
        const blocked = new Set<string>(); // Tasks cancelled due to upstream failure

        // ── Delegation policy enforcement ──────────────────────────────────
        const delegationPolicy = this.delegationGuard.getPolicy();
        if (this.delegationGuard.isNoDelegation) {
            // no-delegation mode: force serial, one subtask at a time
            plan.strategy = 'serial';
            reporter.emit({
                type: 'note',
                message: '🔒 Delegation mode: no-delegation — all subtasks run serially by Johann',
            });
            await debugLog.logEvent(
                'other',
                'Delegation policy: no-delegation — forcing serial execution',
            );
        } else {
            await debugLog.logEvent(
                'other',
                `Delegation policy: mode=${delegationPolicy.mode}, maxParallel=${delegationPolicy.maxParallel}, ` +
                    `maxDepth=${delegationPolicy.maxDepth}, runawayThreshold=${delegationPolicy.runawayThreshold}`,
            );
        }

        // Maximum number of correction cycles to prevent infinite re-runs
        const MAX_CORRECTION_CYCLES = 3;
        let correctionCycle = 0;

        // ── Validate the dependency graph ──────────────────────────────────
        const validation = validateGraph(plan);
        if (!validation.valid) {
            const issues: string[] = [];
            if (validation.cycles.length > 0) {
                issues.push(`Cycles: ${validation.cycles.map((c) => c.join(' → ')).join('; ')}`);
            }
            if (validation.missingDeps.length > 0) {
                issues.push(
                    `Missing deps: ${validation.missingDeps.map((m) => `${m.taskId} → ${m.missingDep}`).join(', ')}`,
                );
            }
            if (validation.orphans.length > 0) {
                issues.push(`Orphans: ${validation.orphans.join(', ')}`);
            }
            throw new Error(`Invalid task graph: ${issues.join('. ')}`);
        }

        // ── Compute execution waves ────────────────────────────────────────
        // Wrapped in a correction-aware outer loop: if a downstream task
        // discovers an upstream mistake, we invalidate + re-run affected tasks.
        let wavesNeedRecompute = true;

        while (wavesNeedRecompute && correctionCycle <= MAX_CORRECTION_CYCLES) {
            wavesNeedRecompute = false; // Will be set to true if corrections trigger

            const waves = getExecutionWaves(plan);
            if (correctionCycle === 0) {
                await debugLog.logEvent(
                    'other',
                    `DAG: ${waves.length} waves, max parallelism: ${Math.max(...waves.map((w) => w.taskIds.length))}`,
                );
            } else {
                await debugLog.logEvent(
                    'other',
                    `DAG (correction cycle ${correctionCycle}): re-computing ${waves.length} waves`,
                );
            }

            for (const wave of waves) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }

                // Filter out already-completed (resume case) and blocked tasks
                const pendingIds = wave.taskIds.filter(
                    (id) => !completed.has(id) && !blocked.has(id),
                );

                if (pendingIds.length === 0) {
                    continue; // Entire wave already done or blocked
                }

                // === RunState: drain user queue at wave boundary (safe checkpoint) ===
                const runMgr = RunStateManager.getInstance();
                const pending = runMgr.getPendingUserMessages();
                if (pending.length > 0) {
                    reporter.emit({
                        type: 'note',
                        message:
                            `📨 ${pending.length} queued user message(s) detected at wave boundary. ` +
                            `These will be integrated in a future orchestration cycle.`,
                    });
                    // Mark them as integrated (they'll be picked up on /resume or next run)
                    for (const msg of pending) {
                        await runMgr.markUserMessageIntegrated(msg.id);
                    }
                }

                const pendingSubtasks = pendingIds
                    .map((id) => plan.subtasks.find((st) => st.id === id)!)
                    .filter(Boolean);

                // ── Parallel execution when multiple tasks in a wave ───────────
                if (
                    this.config.allowParallelExecution &&
                    pendingSubtasks.length > 1 &&
                    (plan.strategy === 'parallel' || plan.strategy === 'mixed') &&
                    !this.delegationGuard.isNoDelegation
                ) {
                    // ── Delegation policy: cap parallel batch size ──────────
                    const maxBatch = this.delegationGuard.maxParallel;
                    let batchSubtasks = pendingSubtasks;
                    if (maxBatch > 0 && pendingSubtasks.length > maxBatch) {
                        reporter.emit({
                            type: 'note',
                            message: `🔒 Delegation cap: limiting parallel batch from ${pendingSubtasks.length} to ${maxBatch} (policy: ${delegationPolicy.mode})`,
                        });
                        batchSubtasks = pendingSubtasks.slice(0, maxBatch);
                        // Remaining tasks will be picked up in subsequent wave iterations
                    }

                    const useWorktrees = worktreeManager?.isReady() ?? false;
                    if (useWorktrees) {
                        reporter.emit({
                            type: 'note',
                            message: `⚡ Wave ${wave.level}: running ${batchSubtasks.length} subtasks in parallel (git worktree isolation)`,
                        });

                        for (const subtask of batchSubtasks) {
                            try {
                                const wt = await worktreeManager!.createWorktree(subtask.id);
                                subtask.worktreePath = wt.worktreePath;
                            } catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                reporter.emit({
                                    type: 'note',
                                    message: `Worktree creation failed for "${subtask.title}": ${msg.substring(0, 100)}. Running without isolation.`,
                                    style: 'warning',
                                });
                            }
                        }
                    } else {
                        reporter.emit({
                            type: 'note',
                            message: `⚡ Wave ${wave.level}: running ${batchSubtasks.length} subtasks in parallel`,
                        });
                    }

                    const promises = batchSubtasks.map(async (subtask) => {
                        if (token.isCancellationRequested) {
                            return;
                        }

                        if (ledger && subtask.worktreePath) {
                            await ledger.registerWorktree(subtask.id, subtask.worktreePath);
                        }

                        if (persist) {
                            await persist.appendExecutionLog(
                                'SUBTASK START',
                                `${subtask.id}: ${subtask.title} (${subtask.complexity})`,
                            );
                            await persist.writeStatusMarkdown(plan, subtask.id);
                        }

                        const result = await this.executeSubtaskWithEscalation(
                            subtask,
                            results,
                            workspaceContext,
                            reporter,
                            token,
                            debugLog,
                            persist,
                            toolToken,
                            ledger,
                            hookRunner,
                        );

                        results.set(subtask.id, result);
                        subtask.result = result;
                        completed.add(subtask.id);

                        if (ledger) {
                            if (result.success) {
                                await ledger.markCompleted(subtask.id, result.output);
                            } else {
                                await ledger.markFailed(
                                    subtask.id,
                                    result.reviewNotes || 'Unknown failure',
                                );
                            }
                        }

                        if (persist) {
                            await persist.writeSubtaskResult(subtask.id, result, subtask);
                            await persist.appendExecutionLog(
                                result.success ? 'SUBTASK DONE' : 'SUBTASK FAILED',
                                `${subtask.id}: ${subtask.title} — ${result.modelUsed} (${(result.durationMs / 1000).toFixed(1)}s)`,
                            );
                            await persist.writeStatusMarkdown(plan);
                        }

                        // ── Error propagation: block downstream tasks ──────────
                        if (!result.success) {
                            const downstream = getDownstreamTasks(plan, subtask.id);
                            for (const dId of downstream) {
                                if (!completed.has(dId)) {
                                    blocked.add(dId);
                                    const dSt = plan.subtasks.find((s) => s.id === dId);
                                    if (dSt) {
                                        dSt.status = 'failed';
                                        dSt.result = {
                                            success: false,
                                            modelUsed: 'none',
                                            output: '',
                                            reviewNotes: `Blocked: upstream task "${subtask.title}" (${subtask.id}) failed`,
                                            durationMs: 0,
                                            timestamp: new Date().toISOString(),
                                        };
                                        results.set(dId, dSt.result);
                                    }
                                }
                            }
                            reporter.emit({
                                type: 'note',
                                message:
                                    downstream.length > 0
                                        ? `Task "${subtask.title}" failed — ${downstream.length} downstream task(s) blocked`
                                        : `Task "${subtask.title}" failed (no downstream dependents)`,
                                style: 'warning',
                            });
                        }

                        // ── Flow correction: check review for upstream correction signals ──
                        if (result.success && result.reviewNotes) {
                            const corrections = FlowCorrectionManager.parseCorrectionSignals(
                                result.reviewNotes,
                                subtask.id,
                            );
                            for (const correction of corrections) {
                                const corrResult = this.flowCorrection.requestCorrection(
                                    correction,
                                    plan,
                                    results,
                                    completed,
                                );
                                if (corrResult.accepted) {
                                    // Remove invalidated tasks from blocked set too
                                    for (const invId of corrResult.invalidatedTasks) {
                                        blocked.delete(invId);
                                    }
                                    wavesNeedRecompute = true;
                                    reporter.emit({
                                        type: 'note',
                                        message:
                                            `🔄 Flow correction: "${subtask.title}" found issue in upstream "${correction.targetTaskId}". ` +
                                            `Re-running ${corrResult.invalidatedTasks.length} task(s).`,
                                        style: 'warning',
                                    });
                                } else {
                                    reporter.emit({
                                        type: 'note',
                                        message: `⚠️ Correction rejected: ${corrResult.reason}`,
                                        style: 'warning',
                                    });
                                }
                            }
                        }
                    });

                    await Promise.all(promises);

                    // Merge worktree branches back sequentially
                    if (useWorktrees) {
                        const worktreeSubtasks = batchSubtasks.filter((st) => st.worktreePath);
                        if (worktreeSubtasks.length > 0) {
                            reporter.emit({
                                type: 'task-started',
                                id: `merge-wave-${wave.level}`,
                                label: `Merging wave ${wave.level} results`,
                            });

                            const mergeResults = await worktreeManager!.mergeAllSequentially(
                                worktreeSubtasks.map((st) => st.id),
                            );

                            for (const mr of mergeResults) {
                                if (!mr.success) {
                                    reporter.emit({
                                        type: 'note',
                                        message: `**Merge conflict** for "${mr.subtaskId}": ${mr.error}`,
                                        style: 'warning',
                                    });
                                    if (mr.conflictFiles && mr.conflictFiles.length > 0) {
                                        reporter.emit({
                                            type: 'fileset-discovered',
                                            label: 'Conflicting files',
                                            files: mr.conflictFiles,
                                        });
                                    }
                                    const subtask = pendingSubtasks.find(
                                        (st) => st.id === mr.subtaskId,
                                    );
                                    if (subtask?.result) {
                                        subtask.result.success = false;
                                        subtask.result.reviewNotes += ` [MERGE CONFLICT: ${mr.error}]`;
                                    }
                                } else if (mr.hasChanges) {
                                    reporter.emit({
                                        type: 'note',
                                        message: `Merged: ${mr.subtaskId}`,
                                        style: 'success',
                                    });
                                }
                            }

                            for (const subtask of worktreeSubtasks) {
                                await worktreeManager!.cleanupWorktree(subtask.id);
                                subtask.worktreePath = undefined;
                            }

                            reporter.emit({
                                type: 'task-completed',
                                id: `merge-wave-${wave.level}`,
                            });
                        }
                    }
                } else {
                    // ── Serial execution ───────────────────────────────────────
                    for (const subtask of pendingSubtasks) {
                        if (token.isCancellationRequested) {
                            break;
                        }

                        if (persist) {
                            await persist.appendExecutionLog(
                                'SUBTASK START',
                                `${subtask.id}: ${subtask.title} (${subtask.complexity})`,
                            );
                            await persist.writeStatusMarkdown(plan, subtask.id);
                        }

                        const result = await this.executeSubtaskWithEscalation(
                            subtask,
                            results,
                            workspaceContext,
                            reporter,
                            token,
                            debugLog,
                            persist,
                            toolToken,
                            ledger,
                            hookRunner,
                        );

                        results.set(subtask.id, result);
                        subtask.result = result;
                        completed.add(subtask.id);

                        if (ledger) {
                            if (result.success) {
                                await ledger.markCompleted(subtask.id, result.output);
                            } else {
                                await ledger.markFailed(
                                    subtask.id,
                                    result.reviewNotes || 'Unknown failure',
                                );
                            }
                        }

                        if (persist) {
                            await persist.writeSubtaskResult(subtask.id, result, subtask);
                            await persist.appendExecutionLog(
                                result.success ? 'SUBTASK DONE' : 'SUBTASK FAILED',
                                `${subtask.id}: ${subtask.title} — ${result.modelUsed} (${(result.durationMs / 1000).toFixed(1)}s)`,
                            );
                            await persist.writeStatusMarkdown(plan);
                        }

                        // ── Error propagation: block downstream tasks ──────────
                        if (!result.success) {
                            const downstream = getDownstreamTasks(plan, subtask.id);
                            for (const dId of downstream) {
                                if (!completed.has(dId)) {
                                    blocked.add(dId);
                                    const dSt = plan.subtasks.find((s) => s.id === dId);
                                    if (dSt) {
                                        dSt.status = 'failed';
                                        dSt.result = {
                                            success: false,
                                            modelUsed: 'none',
                                            output: '',
                                            reviewNotes: `Blocked: upstream task "${subtask.title}" (${subtask.id}) failed`,
                                            durationMs: 0,
                                            timestamp: new Date().toISOString(),
                                        };
                                        results.set(dId, dSt.result);
                                    }
                                }
                            }
                            if (downstream.length > 0) {
                                reporter.emit({
                                    type: 'note',
                                    message: `Task "${subtask.title}" failed — ${downstream.length} downstream task(s) blocked`,
                                    style: 'warning',
                                });
                            }
                        }

                        // ── Flow correction: check review for upstream correction signals ──
                        if (result.success && result.reviewNotes) {
                            const corrections = FlowCorrectionManager.parseCorrectionSignals(
                                result.reviewNotes,
                                subtask.id,
                            );
                            for (const correction of corrections) {
                                const corrResult = this.flowCorrection.requestCorrection(
                                    correction,
                                    plan,
                                    results,
                                    completed,
                                );
                                if (corrResult.accepted) {
                                    for (const invId of corrResult.invalidatedTasks) {
                                        blocked.delete(invId);
                                    }
                                    wavesNeedRecompute = true;
                                    reporter.emit({
                                        type: 'note',
                                        message:
                                            `🔄 Flow correction: "${subtask.title}" found issue in upstream "${correction.targetTaskId}". ` +
                                            `Re-running ${corrResult.invalidatedTasks.length} task(s).`,
                                        style: 'warning',
                                    });
                                } else {
                                    reporter.emit({
                                        type: 'note',
                                        message: `⚠️ Correction rejected: ${corrResult.reason}`,
                                        style: 'warning',
                                    });
                                }
                            }
                        }
                    }
                }
            }

            if (wavesNeedRecompute) {
                correctionCycle++;

                // === RunState: emit delegation panel after correction-triggering wave ===
                this.emitDelegationPanel(reporter);

                continue; // Re-compute waves with corrected tasks back in pending
            }
        } // end correction-aware outer loop

        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        // === RunState: final delegation panel ===
        this.emitDelegationPanel(reporter);

        return results;
    }

    /**
     * Execute a single subtask with model selection and escalation.
     * One try per model. If it fails review, escalate to a different model.
     */
    private async executeSubtaskWithEscalation(
        subtask: Subtask,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        reporter: ProgressReporter,
        token: vscode.CancellationToken,
        debugLog: DebugConversationLog,
        persist?: SessionPersistence,
        toolToken?: vscode.ChatParticipantToolToken,
        ledger?: ExecutionLedger,
        hookRunner?: HookRunner,
    ): Promise<SubtaskResult> {
        const escalation: EscalationRecord = {
            subtaskId: subtask.id,
            attempts: [],
        };
        // Track escalation on the session — MUST be done here so escalation
        // data is available for recovery plans and memory recording.
        // (The session is accessed via closure from the caller.)

        const triedModelIds: string[] = [];

        // Get RunState manager reference (used throughout the escalation loop)
        const runMgr2 = RunStateManager.getInstance();

        // Fire before_subtask hook (once, before any attempts)
        if (hookRunner) {
            await hookRunner.run('before_subtask', { subtask });
        }

        // ── Delegation guard: request permission to delegate ───────────
        const delegationDecision = this.delegationGuard.requestDelegation(0); // depth 0 = Johann direct
        if (!delegationDecision.allowed) {
            reporter.emit({
                type: 'note',
                message: `🔒 Delegation blocked for "${subtask.title}": ${delegationDecision.reason}`,
                style: 'warning',
            });
            await debugLog.logEvent(
                'other',
                `Delegation blocked for subtask ${subtask.id}: ${delegationDecision.reason}`,
            );
            subtask.status = 'failed';
            return {
                success: false,
                modelUsed: 'none',
                output: '',
                reviewNotes: `Delegation blocked: ${delegationDecision.reason}`,
                durationMs: 0,
                timestamp: new Date().toISOString(),
            };
        }

        while (subtask.attempts < subtask.maxAttempts) {
            if (token.isCancellationRequested) {
                this.delegationGuard.releaseDelegation();
                return {
                    success: false,
                    modelUsed: 'cancelled',
                    output: '',
                    reviewNotes: 'Cancelled by user',
                    durationMs: 0,
                    timestamp: new Date().toISOString(),
                };
            }

            subtask.attempts++;
            subtask.status = 'in-progress';

            // === RunState: mark task running ===
            await runMgr2.updateTask(subtask.id, {
                status: 'running',
                progressMessage: `Attempt ${subtask.attempts}/${subtask.maxAttempts}`,
            });

            // PERSIST — subtask status change
            if (persist) {
                await persist.writeSubtaskUpdate(subtask);
            }

            // Pick model — apply heuristics to refine taskType & complexity
            const detectedType =
                subtask.taskType ?? this.modelPicker.detectTaskType(subtask.description);
            const { taskType: refinedType, complexity: refinedComplexity } =
                this.modelPicker.refineSelection(
                    subtask.description,
                    detectedType,
                    subtask.complexity,
                );
            // Persist refined values back onto the subtask for downstream use
            subtask.taskType = refinedType;
            subtask.complexity = refinedComplexity;

            let modelInfo: ModelInfo | undefined;
            if (subtask.attempts === 1) {
                modelInfo = await this.modelPicker.selectForTask(
                    refinedType,
                    refinedComplexity,
                    triedModelIds,
                );
            } else {
                const lastReason =
                    escalation.attempts[escalation.attempts.length - 1]?.reason || '';
                modelInfo = await this.modelPicker.escalate(
                    subtask.complexity,
                    triedModelIds,
                    lastReason,
                );
            }

            if (!modelInfo) {
                reporter.emit({
                    type: 'task-failed',
                    id: subtask.id,
                    error: 'No more models available',
                    label: subtask.title,
                });
                subtask.status = 'failed';
                this.delegationGuard.releaseDelegation();
                return {
                    success: false,
                    modelUsed: 'none',
                    output: '',
                    reviewNotes: 'No models available',
                    durationMs: 0,
                    timestamp: new Date().toISOString(),
                };
            }

            subtask.assignedModel = modelInfo.id;
            triedModelIds.push(modelInfo.id);

            reporter.emit({
                type: 'task-started',
                id: subtask.id,
                label: subtask.title,
                metadata: {
                    model: modelInfo.name,
                    tier: String(modelInfo.tier),
                    ...(subtask.attempts > 1 ? { attempt: String(subtask.attempts) } : {}),
                },
            });

            // Execute subtask
            // Inject correction context if this task has been corrected
            let effectiveWorkspaceContext = workspaceContext;
            if (this.flowCorrection.hasPendingCorrections(subtask.id)) {
                const correctionCtx = this.flowCorrection.buildCorrectionContext(subtask.id);
                effectiveWorkspaceContext = correctionCtx + workspaceContext;
                reporter.emit({
                    type: 'note',
                    message: `🔄 Re-running "${subtask.title}" with correction guidance`,
                });
            }

            // Multi-pass execution: DISABLED for agentic subtasks.
            // The MultiPassExecutor is text-only (no tool tokens) — it sends raw LLM
            // requests without terminal, filesystem, or any tool access. Johann's
            // subtasks are agentic Copilot sessions that MUST use tools (run commands,
            // create files, etc.). Routing them through multi-pass causes:
            //   1. Text-only hallucination (model claims work was done without doing it)
            //   2. Safety refusals (model refuses to "generate" browser/screenshot code)
            // Always use single-pass subagentManager execution for agentic tasks.
            // TODO: Re-enable when MultiPassExecutor gains tool access via toolToken.

            // Standard single-pass execution

            // Mark subtask as running in the ledger (captures model + working directory)
            if (ledger) {
                await ledger.markRunning(
                    subtask.id,
                    modelInfo.id,
                    subtask.worktreePath || undefined,
                );
            }

            const result = await this.subagentManager.executeSubtask(
                subtask,
                modelInfo,
                dependencyResults,
                effectiveWorkspaceContext,
                token,
                reporter.stream,
                debugLog,
                toolToken,
                ledger,
                undefined, // skills
                undefined, // messageBus
                undefined, // hookRunner
                this.rateLimitGuard,
                this.delegationGuard,
            );

            if (!result.success) {
                // Check if this is an API compatibility error (e.g., GPT model rejecting context_management).
                // These should NOT count as a real attempt — the model never even started executing.
                // Just skip to the next model immediately.
                const isApiCompat =
                    result.reviewNotes?.toLowerCase().includes('unsupported parameter') ||
                    result.reviewNotes?.toLowerCase().includes('context_management') ||
                    result.reviewNotes?.toLowerCase().includes('invalid_request_error');

                if (isApiCompat) {
                    reporter.emit({
                        type: 'task-progress',
                        id: subtask.id,
                        message: `Model ${modelInfo.name} incompatible, switching…`,
                    });
                    // Don't increment attempts — this model never ran, just skip it
                    subtask.attempts--;
                    escalation.attempts.push({
                        modelId: modelInfo.id,
                        tier: modelInfo.tier,
                        success: false,
                        reason: `API incompatibility: ${result.reviewNotes}`,
                    });
                    continue;
                }

                reporter.emit({
                    type: 'task-progress',
                    id: subtask.id,
                    message: 'Execution failed, escalating…',
                });
                escalation.attempts.push({
                    modelId: modelInfo.id,
                    tier: modelInfo.tier,
                    success: false,
                    reason: result.reviewNotes,
                    output: result.output, // Preserve any partial output
                    durationMs: result.durationMs,
                });
                continue;
            }

            // Review
            subtask.status = 'reviewing';
            // PERSIST — subtask entering review
            if (persist) {
                await persist.writeSubtaskUpdate(subtask);
            }
            const review = await this.subagentManager.reviewSubtaskOutput(
                subtask,
                result,
                modelInfo.model, // Use the same model for review
                token,
                reporter.stream,
                debugLog,
                this.selfHealing, // Pass self-healing detector
            );

            result.success = review.success;
            result.reviewNotes = review.reason;

            escalation.attempts.push({
                modelId: modelInfo.id,
                tier: modelInfo.tier,
                success: review.success,
                reason: review.reason,
                output: result.output, // ALWAYS preserve the output — even on review failure
                durationMs: result.durationMs,
            });

            if (review.success) {
                subtask.status = 'completed';
                // === RunState: mark task done ===
                await runMgr2.updateTask(subtask.id, { status: 'done', model: modelInfo.name });
                // PERSIST — subtask completed
                if (persist) {
                    await persist.writeSubtaskUpdate(subtask);
                }
                reporter.emit({
                    type: 'task-completed',
                    id: subtask.id,
                    durationMs: result.durationMs,
                });
                if (hookRunner) {
                    await hookRunner.run('after_subtask', { subtask, subtaskResult: result });
                }
                this.delegationGuard.releaseDelegation();
                return result;
            }

            // === SELF-HEALING: Create skills from detected failures ===
            const detectedFailures = this.selfHealing.getDetectedFailures();
            if (detectedFailures.length > 0 && getConfig().skillAutonomousCreation) {
                for (const failure of detectedFailures) {
                    try {
                        const skill = await this.selfHealing.createSkillFromFailure(
                            failure,
                            this.skillStore,
                            this.skillValidator,
                        );
                        if (skill) {
                            reporter.emit({
                                type: 'note',
                                message: `🛠️ **Self-healing:** Created skill "${skill.metadata.slug}" to prevent ${failure.type} in future runs`,
                                style: 'success',
                            });

                            // Offer to promote to global (async, non-blocking)
                            this.offerSkillPromotion(skill).catch(() => {
                                // Ignore promotion failures
                            });
                        }
                    } catch (err) {
                        // Skill creation failed — log but don't block escalation
                        getLogger().warn(`Self-healing skill creation failed: ${err}`);
                    }
                }
            }

            // Failed review — will escalate
            subtask.status = 'escalated';
            // PERSIST — subtask escalated
            if (persist) {
                await persist.writeSubtaskUpdate(subtask);
            }
            reporter.emit({
                type: 'task-progress',
                id: subtask.id,
                message: `Escalating: ${review.reason}`,
            });
        }

        // All attempts exhausted
        subtask.status = 'failed';
        // === RunState: mark task failed ===
        await runMgr2.updateTask(subtask.id, { status: 'failed' });
        reporter.emit({
            type: 'task-failed',
            id: subtask.id,
            error: `Failed after ${subtask.attempts} attempts`,
            label: subtask.title,
        });
        this.delegationGuard.releaseDelegation();

        // Preserve the best output from any attempt that produced real work,
        // even if review was too strict. An execution that ran 15+ tool rounds
        // and created files is VALUABLE even if review quibbled.
        let bestOutput = '';
        let bestModelUsed = triedModelIds[triedModelIds.length - 1] || 'none';
        let bestDurationMs = 0;
        for (const attempt of escalation.attempts) {
            // Find the most substantial output from successful executions
            // that were rejected by review (not execution failures)
            if (attempt.output && attempt.output.length > bestOutput.length) {
                bestOutput = attempt.output;
                bestModelUsed = attempt.modelId;
                bestDurationMs = attempt.durationMs ?? 0;
            }
        }

        const failResult: SubtaskResult = {
            success: false,
            modelUsed: bestModelUsed,
            output: bestOutput,
            reviewNotes: `Failed after ${subtask.attempts} attempts`,
            durationMs: bestDurationMs,
            timestamp: new Date().toISOString(),
        };
        if (hookRunner) {
            await hookRunner.run('after_subtask', { subtask, subtaskResult: failResult });
        }
        return failResult;
    }

    /**
     * Merge results from all subtasks into a unified response.
     * Buffers the complete output, sanitizes it to remove forbidden phrases,
     * then streams the clean version to the user.
     */
    private async mergeResults(
        originalRequest: string,
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>,
        model: vscode.LanguageModelChat,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog,
    ): Promise<string> {
        // If only one subtask, just return its output (already streamed during execution)
        if (plan.subtasks.length === 1) {
            const result = results.get(plan.subtasks[0].id);
            if (result && result.success) {
                return result.output;
            }
            return `**Task failed:** ${result?.reviewNotes || 'Unknown error'}\n`;
        }

        // Multiple subtasks — merge results
        const mergePrompt = this.buildMergePrompt(originalRequest, plan, results);

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(
                    MERGE_SYSTEM_PROMPT + '\n\n---\n\n' + mergePrompt,
                ),
            ];

            const output = await withRetry(
                async () => {
                    const callStart = Date.now();
                    const response = await model.sendRequest(messages, {}, token);
                    let text = '';
                    for await (const chunk of response.text) {
                        text += chunk;
                    }

                    // Debug log the merge call
                    if (debugLog) {
                        await debugLog.logLLMCall({
                            timestamp: new Date(callStart).toISOString(),
                            phase: 'merge',
                            label: 'Result synthesis',
                            model: model.id || model.name || 'unknown',
                            promptMessages: [MERGE_SYSTEM_PROMPT + '\n\n---\n\n' + mergePrompt],
                            responseText: text,
                            durationMs: Date.now() - callStart,
                        });
                    }

                    return text;
                },
                REVIEW_RETRY_POLICY,
                token,
            );

            // Post-merge sanitization: strip forbidden phrases that the model
            // may have emitted despite the prompt's ABSOLUTE PROHIBITION section.
            const sanitized = this.sanitizeMergeOutput(output);

            // NOW stream the clean output to the user
            if (stream) {
                stream.markdown(sanitized);
            }

            // Log if sanitization made changes
            if (sanitized !== output && debugLog) {
                await debugLog.logEvent(
                    'merge',
                    `Post-merge sanitization removed ${output.length - sanitized.length} chars of forbidden content`,
                );
            }

            return sanitized;
        } catch (mergeErr) {
            // Fallback: concatenate results
            getLogger().warn(`Merge LLM call failed, using fallback: ${extractErrorMessage(mergeErr)}`);
            const fallback = this.fallbackMerge(plan, results);
            if (stream) {
                stream.markdown(fallback);
            }
            return fallback;
        }
    }

    /**
     * Strip forbidden user-directed phrases and sections from merge output.
     * This is the last line of defense — even if the LLM ignores the prompt,
     * we structurally remove the offending content before the user sees it.
     */
    private sanitizeMergeOutput(output: string): string {
        let sanitized = output;

        // Remove entire "Next Steps" sections (header + content until next header or end)
        sanitized = sanitized.replace(
            /^#{1,4}\s*(Next\s+Steps|Manual\s+Steps|Manual\s+Investigation|What\s+You\s+(Need|Should)\s+to\s+Do|Recommended\s+Next\s+Steps|Recommendations|Action\s+Items|Required\s+Actions)[^\n]*\n[\s\S]*?(?=^#{1,4}\s|\n$)/gim,
            '',
        );

        // Remove individual forbidden phrases and their surrounding sentence/line
        const forbiddenPatterns = [
            /^[^\n]*\bPlease run\b[^\n]*$/gim,
            /^[^\n]*\bYou should\b[^\n]*$/gim,
            /^[^\n]*\bYou need to\b[^\n]*$/gim,
            /^[^\n]*\bYou'll need to\b[^\n]*$/gim,
            /^[^\n]*\bYou'll want to\b[^\n]*$/gim,
            /^[^\n]*\bYou can then\b[^\n]*$/gim,
            /^[^\n]*\bMake sure to\b[^\n]*$/gim,
            /^[^\n]*\bDon't forget to\b[^\n]*$/gim,
            /^[^\n]*\bWould you like me to\b[^\n]*$/gim,
            /^[^\n]*\bPlease share\b[^\n]*$/gim,
            /^[^\n]*\bAsk the user\b[^\n]*$/gim,
            /^[^\n]*\bTell the user\b[^\n]*$/gim,
            /^[^\n]*\bThe user needs\b[^\n]*$/gim,
            /^[^\n]*\bThe user should\b[^\n]*$/gim,
            /^[^\n]*\bTo fix this,\s*run\b[^\n]*$/gim,
            /^[^\n]*\bTo resolve this\b[^\n]*$/gim,
            /^[^\n]*\bAfter that,\s*you can\b[^\n]*$/gim,
        ];

        for (const pattern of forbiddenPatterns) {
            sanitized = sanitized.replace(pattern, '');
        }

        // Clean up excessive blank lines left by removals
        sanitized = sanitized.replace(/\n{4,}/g, '\n\n');

        return sanitized.trim();
    }

    /**
     * Build the merge prompt.
     * CRITICAL: Include partial output even for failed tasks so the merge model
     * can assess whether real work was done despite a review false-negative.
     */
    private buildMergePrompt(
        originalRequest: string,
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>,
    ): string {
        const parts: string[] = [];
        parts.push('=== ORIGINAL REQUEST ===');
        parts.push(originalRequest);
        parts.push('');
        parts.push('=== PLAN SUMMARY ===');
        parts.push(plan.summary);
        parts.push('');
        parts.push('=== SUBTASK RESULTS ===');

        for (const subtask of plan.subtasks) {
            const result = results.get(subtask.id);
            parts.push(`\n--- ${subtask.title} (${result?.success ? 'SUCCESS' : 'FAILED'}) ---`);
            if (result?.success) {
                parts.push(result.output.substring(0, 8000));
            } else {
                parts.push(`Review notes: ${result?.reviewNotes || 'No review notes'}`);
                // Include partial output from failed tasks — the agent may have done
                // real work that was incorrectly rejected by the review model.
                // The merge model should judge whether the work was actually done.
                if (result?.output && result.output.length > 100) {
                    // Show the LAST portion of the output where summary blocks live
                    const maxFailedOutput = 6000;
                    const failedOutput =
                        result.output.length > maxFailedOutput
                            ? '...\n' +
                              result.output.substring(result.output.length - maxFailedOutput)
                            : result.output;
                    parts.push('');
                    parts.push(
                        'PARTIAL OUTPUT (review may have been a false negative — judge for yourself):',
                    );
                    parts.push(failedOutput);
                }
            }
        }

        return parts.join('\n');
    }

    /**
     * Fallback merge when the LLM merge fails.
     */
    private fallbackMerge(plan: OrchestrationPlan, results: Map<string, SubtaskResult>): string {
        const parts: string[] = [];
        parts.push(`## ${plan.summary}\n`);

        for (const subtask of plan.subtasks) {
            const result = results.get(subtask.id);
            parts.push(`### ${subtask.title}`);
            parts.push(`**Status:** ${result?.success ? 'Completed' : 'Failed'}`);
            parts.push(`**Model:** ${result?.modelUsed || 'N/A'}\n`);

            if (result?.success) {
                parts.push(result.output);
            } else {
                parts.push(`*${result?.reviewNotes || 'No output'}*`);
            }
            parts.push('');
        }

        return parts.join('\n');
    }

    /**
     * Format the plan as a readable summary for the user.
     */
    private formatPlanSummary(plan: OrchestrationPlan): string {
        const lines: string[] = [];
        lines.push(`**Plan:** ${plan.summary}`);
        lines.push(
            `**Strategy:** ${plan.strategy} | **Complexity:** ${plan.overallComplexity} | **Subtasks:** ${plan.subtasks.length}`,
        );
        lines.push('');

        if (plan.subtasks.length > 1) {
            lines.push('| # | Subtask | Complexity | Depends On |');
            lines.push('|---|---------|------------|------------|');
            for (const st of plan.subtasks) {
                const deps = st.dependsOn.length > 0 ? st.dependsOn.join(', ') : '—';
                lines.push(`| ${st.id} | ${st.title} | ${st.complexity} | ${deps} |`);
            }
            lines.push('');
        }

        if (plan.successCriteria.length > 0) {
            lines.push('**Success Criteria:**');
            for (const sc of plan.successCriteria) {
                lines.push(`- ${sc}`);
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Save the orchestration plan to memory so it can potentially be resumed.
     * This preserves planning work even when execution fails due to network issues.
     */
    private async savePlanForRecovery(
        session: JohannSession,
        error: ClassifiedError,
    ): Promise<void> {
        if (!session.plan) {
            return;
        }

        const plan = session.plan;
        const completedTasks = plan.subtasks.filter((st) => st.status === 'completed');
        const pendingTasks = plan.subtasks.filter((st) => st.status !== 'completed');

        const recoveryContent = [
            `# Recovery Plan — ${plan.summary}`,
            ``,
            `**Session:** ${session.sessionId}`,
            `**Failed at:** ${new Date().toISOString()}`,
            `**Error category:** ${error.category}`,
            `**Error:** ${error.message.substring(0, 300)}`,
            ``,
            `## Progress`,
            `- Completed: ${completedTasks.length}/${plan.subtasks.length}`,
            `- Remaining: ${pendingTasks.length}`,
            ``,
            `## Original Request`,
            session.originalRequest.substring(0, 2000),
            ``,
            `## Completed Subtasks`,
            ...completedTasks.map(
                (st) => `- ✅ **${st.title}** (${st.assignedModel || 'unknown'})`,
            ),
            ``,
            `## Remaining Subtasks`,
            ...pendingTasks.map(
                (st) =>
                    `- ⏳ **${st.title}** (${st.complexity}) — ${st.description.substring(0, 200)}`,
            ),
        ].join('\n');

        try {
            await this.memory.recordLearning(
                `Recovery plan: ${plan.summary.substring(0, 80)}`,
                recoveryContent,
                ['recovery', 'interrupted', error.category],
            );
        } catch {
            // Don't let memory failure compound the original error
        }
    }

    /**
     * Render a user-facing error message with category-specific guidance.
     * If response is undefined (background mode), error is handled by BackgroundTaskManager.
     */
    private renderErrorForUser(
        response: vscode.ChatResponseStream | undefined,
        classified: ClassifiedError,
        session: JohannSession,
    ): void {
        if (!response) {
            // Background mode — error will be shown via notification
            return;
        }
        const planProgress = session.plan
            ? (() => {
                  const completed = session.plan.subtasks.filter(
                      (st) => st.status === 'completed',
                  ).length;
                  const total = session.plan.subtasks.length;
                  return completed > 0
                      ? `\n\n> **Progress saved:** ${completed}/${total} subtasks completed before the error. ` +
                            `Your plan has been saved to Johann's memory. You can re-run your request and Johann will have context from this attempt.\n`
                      : '';
              })()
            : '';

        switch (classified.category) {
            case 'network':
                response.markdown(
                    `\n\n**Network Error**\n\n` +
                        `Johann's orchestration was interrupted by a transient network error ` +
                        `after automatic retries were exhausted.\n\n` +
                        `**What happened:** ${classified.message.substring(0, 200)}\n\n` +
                        `**To resolve:**\n` +
                        `1. Check your internet connection\n` +
                        `2. If on WiFi, try switching networks or using a wired connection\n` +
                        `3. Re-run your request — Johann will retry from where it left off\n` +
                        planProgress,
                );
                break;

            case 'rate-limit':
                response.markdown(
                    `\n\n**Copilot Request Limit Reached**\n\n` +
                        `Johann's orchestration was interrupted because Copilot hit its request limit.\n\n` +
                        `**To fix this:**\n` +
                        `1. Increase \`github.copilot.chat.agent.maxRequests\` in VS Code settings\n` +
                        `2. Type \`/yolo on\` for full setup guidance\n` +
                        `3. Wait a moment, then re-run your request\n` +
                        planProgress +
                        `\n**Error:** ${classified.message.substring(0, 200)}\n`,
                );
                break;

            case 'cancelled':
                response.markdown(
                    `\n\n**Request Cancelled**\n\n` +
                        `The orchestration was cancelled.` +
                        planProgress,
                );
                break;

            case 'auth':
                response.markdown(
                    `\n\n**Authentication Error**\n\n` +
                        `${classified.userGuidance}\n\n` +
                        `**Error:** ${classified.message.substring(0, 200)}\n`,
                );
                break;

            default:
                response.markdown(
                    `\n\n**Orchestration Error**\n\n` +
                        `${classified.message.substring(0, 300)}\n` +
                        planProgress,
                );
                break;
        }
    }

    private generateSessionId(): string {
        return `johann-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    }

    /**
     * Get the memory system (for commands like show/clear memory).
     */
    getMemory(): MemorySystem {
        return this.memory;
    }

    getModelPicker(): ModelPicker {
        return this.modelPicker;
    }

    /**
     * Offer to promote a skill to global scope via user notification.
     * Non-blocking — shows a notification with "Promote" button.
     */
    private async offerSkillPromotion(skill: SkillDoc): Promise<void> {
        const answer = await vscode.window.showInformationMessage(
            `🛠️ Self-healing created skill "${skill.metadata.slug}" to prevent ${skill.metadata.tags.join(', ')}. Promote to global to help all projects?`,
            'Promote to Global',
            'Keep Local',
        );

        if (answer === 'Promote to Global') {
            // To promote, we'd need access to globalStorageUri which lives in the extension context
            // For now, just notify the user that they can promote manually
            vscode.window.showInformationMessage(
                `To promote "${skill.metadata.slug}" to global, run the "Johann: Promote Skill to Global" command.`,
            );
            getLogger().info(`User requested promotion for skill "${skill.metadata.slug}"`);
        }
    }

    /**
     * Emit a delegation-panel event summarizing current task states.
     * Reads from RunStateManager to build a compact panel view.
     */
    private emitDelegationPanel(reporter: ProgressReporter): void {
        const runMgr = RunStateManager.getInstance();
        const state = runMgr.getState();
        if (!state || state.tasks.length === 0) {
            return;
        }

        reporter.emit({
            type: 'delegation-panel',
            queued: state.counters.queued,
            running: state.counters.running,
            done: state.counters.done,
            failed: state.counters.failed,
            entries: state.tasks.map((t) => ({
                id: t.id,
                title: t.title,
                status:
                    t.status === 'cancelled'
                        ? 'failed'
                        : (t.status as 'queued' | 'running' | 'done' | 'failed'),
                summary: t.progressMessage || t.status,
            })),
        });
    }

    /**
     * Infer a RunPhase from a subtask title using keyword heuristics.
     */
    private inferRunPhase(title: string): RunPhase {
        const lower = title.toLowerCase();
        if (
            lower.includes('scan') ||
            lower.includes('discover') ||
            lower.includes('analyze') ||
            lower.includes('explore')
        ) {
            return 'discovery';
        }
        if (lower.includes('plan') || lower.includes('design') || lower.includes('architect')) {
            return 'planning';
        }
        if (lower.includes('delegate') || lower.includes('assign') || lower.includes('dispatch')) {
            return 'delegation';
        }
        if (
            lower.includes('test') ||
            lower.includes('verify') ||
            lower.includes('validate') ||
            lower.includes('check') ||
            lower.includes('lint')
        ) {
            return 'verification';
        }
        if (
            lower.includes('package') ||
            lower.includes('deploy') ||
            lower.includes('publish') ||
            lower.includes('report') ||
            lower.includes('document')
        ) {
            return 'packaging';
        }
        return 'implementation';
    }
}
