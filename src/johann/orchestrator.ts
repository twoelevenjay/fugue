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
import { getCopilotAgentSettings } from './config';
import {
    classifyError,
    extractErrorMessage,
    withRetry,
    REVIEW_RETRY_POLICY,
    ClassifiedError,
} from './retry';
import { DebugConversationLog } from './debugConversationLog';
import { WorktreeManager, WorktreeMergeResult } from './worktreeManager';

// ============================================================================
// ORCHESTRATOR — The top-level controller
//
// Flow:
// 1. User sends request to @johann
// 2. Orchestrator uses user's model to create an execution plan
// 3. For each subtask: pick model → execute → review → escalate if needed
// 4. Merge results and respond
// 5. Write to persistent memory
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
- Be thorough but organized.`;

export class Orchestrator {
    private modelPicker: ModelPicker;
    private taskDecomposer: TaskDecomposer;
    private subagentManager: SubagentManager;
    private memory: MemorySystem;
    private config: OrchestratorConfig;

    constructor(config: OrchestratorConfig = DEFAULT_CONFIG) {
        this.config = config;
        this.modelPicker = new ModelPicker();
        this.taskDecomposer = new TaskDecomposer();
        this.subagentManager = new SubagentManager();
        this.memory = new MemorySystem(config);
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
     */
    async orchestrate(
        request: string,
        fullContext: string,
        subagentContext: string,
        userModel: vscode.LanguageModelChat,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
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

        // Track total LLM requests for awareness
        let totalLlmRequests = 0;

        // Check Copilot settings and warn if low limits
        const copilotSettings = getCopilotAgentSettings();
        if (copilotSettings.readable && copilotSettings.maxRequests > 0 && copilotSettings.maxRequests < 50) {
            response.markdown(
                `> ⚠️ **Copilot request limit is set to ${copilotSettings.maxRequests}.** ` +
                `Complex orchestrations may be interrupted. ` +
                `Consider increasing \`github.copilot.chat.agent.maxRequests\` ` +
                `or type \`/yolo on\` for guidance.\n\n`
            );
        }

        // Ensure memory directory exists
        await this.memory.ensureMemoryDir();

        // Initialize debug conversation log
        const debugLog = new DebugConversationLog(session.sessionId);
        await debugLog.initialize();

        // Get memory context
        const memoryContext = await this.memory.getRecentMemoryContext();

        try {
            // == PHASE 1: PLANNING ==
            response.markdown('### Planning\n\n');
            response.markdown('Analyzing your request and creating an execution plan...\n\n');

            await debugLog.logEvent('planning', `Starting planning for: ${request.substring(0, 200)}`);

            const plan = await this.taskDecomposer.decompose(
                request,
                fullContext,
                memoryContext,
                userModel,
                token,
                response,
                debugLog
            );

            session.plan = plan;
            session.status = 'executing';

            // Show the plan
            response.markdown(this.formatPlanSummary(plan));

            // Discover available models
            const modelSummary = await this.modelPicker.getModelSummary();
            response.markdown(`\n\n<details><summary>Available Models</summary>\n\n\`\`\`\n${modelSummary}\n\`\`\`\n\n</details>\n\n`);

            // == PHASE 2: EXECUTION ==
            response.markdown('### Executing\n\n');

            await debugLog.logEvent('subtask-execution', `Starting execution of ${plan.subtasks.length} subtasks`);

            // Initialize worktree manager for parallel isolation
            let worktreeManager: WorktreeManager | undefined;
            if (this.config.useWorktrees && plan.strategy !== 'serial') {
                const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                if (workspaceRoot) {
                    worktreeManager = new WorktreeManager(workspaceRoot, session.sessionId);
                    const wtInitialized = await worktreeManager.initialize();
                    if (wtInitialized) {
                        await debugLog.logEvent('worktree', `Worktree manager initialized (base: ${worktreeManager.getBaseBranch()})`);
                    } else {
                        worktreeManager = undefined;
                        response.markdown('> ℹ️ Git worktree isolation unavailable (not a git repo or git not found). Parallel subtasks will share the workspace.\n\n');
                    }
                }
            }

            try {
                // Pass subagentContext (minimal workspace context without Johann's identity)
                // to prevent subagents from confusing themselves with Johann
                const results = await this.executePlan(plan, subagentContext, response, token, debugLog, worktreeManager);

                // == PHASE 3: MERGE & RESPOND ==
                session.status = 'reviewing';
                response.markdown('\n### Synthesizing Results\n\n');

                await debugLog.logEvent('merge', 'Starting result synthesis');

                const finalOutput = await this.mergeResults(
                    request,
                    plan,
                    results,
                    userModel,
                    token,
                    response,
                    debugLog
                );
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

            const subtaskResultSummaries = plan.subtasks.map(st => ({
                title: st.title,
                model: st.result?.modelUsed || 'unknown',
                success: st.result?.success ?? false,
                notes: st.result?.reviewNotes || '',
            }));

            const overallSuccess = plan.subtasks.every(st => st.result?.success);

            await this.memory.recordTaskCompletion(
                plan.summary,
                subtaskResultSummaries,
                overallSuccess
            );

            // Record any learnings from escalations
            for (const escalation of session.escalations) {
                if (escalation.attempts.length > 1) {
                    await this.memory.recordLearning(
                        `Escalation pattern for subtask ${escalation.subtaskId}`,
                        `Tried ${escalation.attempts.length} models: ${escalation.attempts.map(a => `${a.modelId} (tier ${a.tier}): ${a.success ? 'OK' : a.reason}`).join(' → ')}`,
                        ['escalation', 'model-selection']
                    );
                }
            }

            // Finalize debug log on success
            await debugLog.finalize('completed');

        } catch (err) {
            session.status = 'failed';
            const classified = classifyError(err);

            // Save the plan to memory if we got that far, so it can be resumed
            if (session.plan) {
                await this.savePlanForRecovery(session, classified);
            }

            // Provide category-specific error guidance
            this.renderErrorForUser(response, classified, session);

            await this.memory.recordError(
                classified.message,
                `Session: ${session.sessionId}, Category: ${classified.category}, Request: ${request.substring(0, 200)}`
            );

            // Finalize debug log on failure
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
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        debugLog: DebugConversationLog,
        worktreeManager?: WorktreeManager
    ): Promise<Map<string, SubtaskResult>> {
        const results = new Map<string, SubtaskResult>();
        const completed = new Set<string>();

        // Execute subtasks respecting dependencies
        while (completed.size < plan.subtasks.length) {
            if (token.isCancellationRequested) break;

            // Find ready subtasks (all dependencies completed)
            const ready = plan.subtasks.filter(
                st => !completed.has(st.id) &&
                    st.dependsOn.every(dep => completed.has(dep))
            );

            if (ready.length === 0) {
                // Deadlock or all tasks done
                break;
            }

            // Execute ready subtasks — parallel when enabled and multiple are ready
            if (this.config.allowParallelExecution && ready.length > 1 &&
                (plan.strategy === 'parallel' || plan.strategy === 'mixed')) {

                // Create worktrees for filesystem isolation if available
                const useWorktrees = worktreeManager?.isReady() ?? false;
                if (useWorktrees) {
                    response.markdown(`  ⚡ Running ${ready.length} subtasks in parallel (git worktree isolation)...\n`);

                    // Create a worktree per subtask
                    for (const subtask of ready) {
                        try {
                            const wt = await worktreeManager!.createWorktree(subtask.id);
                            subtask.worktreePath = wt.worktreePath;
                        } catch (err) {
                            const msg = err instanceof Error ? err.message : String(err);
                            response.markdown(`  ⚠️ Worktree creation failed for "${subtask.title}": ${msg.substring(0, 100)}. Running without isolation.\n`);
                        }
                    }
                } else {
                    response.markdown(`  ⚡ Running ${ready.length} subtasks in parallel...\n`);
                }

                // Execute all ready subtasks concurrently
                const promises = ready.map(async (subtask) => {
                    if (token.isCancellationRequested) return;

                    const result = await this.executeSubtaskWithEscalation(
                        subtask,
                        results,
                        workspaceContext,
                        response,
                        token,
                        debugLog
                    );

                    results.set(subtask.id, result);
                    subtask.result = result;
                    completed.add(subtask.id);
                });

                await Promise.all(promises);

                // Merge worktree branches back to the main branch sequentially
                if (useWorktrees) {
                    const worktreeSubtasks = ready.filter(st => st.worktreePath);
                    if (worktreeSubtasks.length > 0) {
                        response.markdown('\n  🔀 Merging parallel results back to main branch...\n');

                        const mergeResults = await worktreeManager!.mergeAllSequentially(
                            worktreeSubtasks.map(st => st.id)
                        );

                        // Report merge results
                        for (const mr of mergeResults) {
                            if (!mr.success) {
                                response.markdown(`  ⚠️ **Merge conflict** for "${mr.subtaskId}": ${mr.error}\n`);
                                if (mr.conflictFiles && mr.conflictFiles.length > 0) {
                                    response.markdown(`    Conflicting files: ${mr.conflictFiles.map(f => `\`${f}\``).join(', ')}\n`);
                                }
                                // Mark the subtask as failed due to merge conflict
                                const subtask = ready.find(st => st.id === mr.subtaskId);
                                if (subtask?.result) {
                                    subtask.result.success = false;
                                    subtask.result.reviewNotes += ` [MERGE CONFLICT: ${mr.error}]`;
                                }
                            } else if (mr.hasChanges) {
                                response.markdown(`  ✅ Merged: ${mr.subtaskId}\n`);
                            }
                        }

                        // Clean up worktrees for this batch
                        for (const subtask of worktreeSubtasks) {
                            await worktreeManager!.cleanupWorktree(subtask.id);
                            subtask.worktreePath = undefined;
                        }

                        response.markdown('\n');
                    }
                }
            } else {
                // Serial execution
                for (const subtask of ready) {
                    if (token.isCancellationRequested) break;

                    const result = await this.executeSubtaskWithEscalation(
                        subtask,
                        results,
                        workspaceContext,
                        response,
                        token,
                        debugLog
                    );

                    results.set(subtask.id, result);
                    subtask.result = result;
                    completed.add(subtask.id);
                }
            }
        }

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
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken,
        debugLog: DebugConversationLog
    ): Promise<SubtaskResult> {
        const escalation: EscalationRecord = {
            subtaskId: subtask.id,
            attempts: [],
        };

        const triedModelIds: string[] = [];

        while (subtask.attempts < subtask.maxAttempts) {
            if (token.isCancellationRequested) {
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

            // Pick model
            let modelInfo: ModelInfo | undefined;
            if (subtask.attempts === 1) {
                modelInfo = await this.modelPicker.selectForComplexity(
                    subtask.complexity,
                    triedModelIds
                );
            } else {
                const lastReason = escalation.attempts[escalation.attempts.length - 1]?.reason || '';
                modelInfo = await this.modelPicker.escalate(
                    subtask.complexity,
                    triedModelIds,
                    lastReason
                );
            }

            if (!modelInfo) {
                response.markdown(`  - **${subtask.title}:** No more models available to try.\n`);
                subtask.status = 'failed';
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

            response.markdown(`  - **${subtask.title}** → \`${modelInfo.name}\` (Tier ${modelInfo.tier})${subtask.attempts > 1 ? ` [attempt ${subtask.attempts}]` : ''}...`);

            // Execute
            const result = await this.subagentManager.executeSubtask(
                subtask,
                modelInfo,
                dependencyResults,
                workspaceContext,
                token,
                response,
                debugLog
            );

            if (!result.success) {
                response.markdown(` execution failed.\n`);
                escalation.attempts.push({
                    modelId: modelInfo.id,
                    tier: modelInfo.tier,
                    success: false,
                    reason: result.reviewNotes,
                });
                continue;
            }

            // Review
            subtask.status = 'reviewing';
            const review = await this.subagentManager.reviewSubtaskOutput(
                subtask,
                result,
                modelInfo.model, // Use the same model for review
                token,
                response,
                debugLog
            );

            result.success = review.success;
            result.reviewNotes = review.reason;

            escalation.attempts.push({
                modelId: modelInfo.id,
                tier: modelInfo.tier,
                success: review.success,
                reason: review.reason,
            });

            if (review.success) {
                subtask.status = 'completed';
                response.markdown(` done. (${(result.durationMs / 1000).toFixed(1)}s)\n`);
                return result;
            }

            // Failed review — will escalate
            subtask.status = 'escalated';
            response.markdown(` needs escalation (${review.reason}).\n`);
        }

        // All attempts exhausted
        subtask.status = 'failed';
        return {
            success: false,
            modelUsed: triedModelIds[triedModelIds.length - 1] || 'none',
            output: '',
            reviewNotes: `Failed after ${subtask.attempts} attempts`,
            durationMs: 0,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Merge results from all subtasks into a unified response.
     * Streams the merged output directly to the response stream.
     */
    private async mergeResults(
        originalRequest: string,
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>,
        model: vscode.LanguageModelChat,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog
    ): Promise<string> {
        // If only one subtask, just return its output
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
                    MERGE_SYSTEM_PROMPT + '\n\n---\n\n' + mergePrompt
                )
            ];

            const mergeStartTime = Date.now();
            const output = await withRetry(
                async () => {
                    const callStart = Date.now();
                    const response = await model.sendRequest(messages, {}, token);
                    let text = '';
                    for await (const chunk of response.text) {
                        text += chunk;
                        if (stream) {
                            stream.markdown(chunk);
                        }
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
                token
            );
            return output;
        } catch {
            // Fallback: concatenate results
            const fallback = this.fallbackMerge(plan, results);
            if (stream) {
                stream.markdown(fallback);
            }
            return fallback;
        }
    }

    /**
     * Build the merge prompt.
     */
    private buildMergePrompt(
        originalRequest: string,
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>
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
                parts.push(`Failed: ${result?.reviewNotes || 'No output'}`);
            }
        }

        return parts.join('\n');
    }

    /**
     * Fallback merge when the LLM merge fails.
     */
    private fallbackMerge(
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>
    ): string {
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
        lines.push(`**Strategy:** ${plan.strategy} | **Complexity:** ${plan.overallComplexity} | **Subtasks:** ${plan.subtasks.length}`);
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
        error: ClassifiedError
    ): Promise<void> {
        if (!session.plan) return;

        const plan = session.plan;
        const completedTasks = plan.subtasks.filter(st => st.status === 'completed');
        const pendingTasks = plan.subtasks.filter(st => st.status !== 'completed');

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
            ...completedTasks.map(st =>
                `- ✅ **${st.title}** (${st.assignedModel || 'unknown'})`
            ),
            ``,
            `## Remaining Subtasks`,
            ...pendingTasks.map(st =>
                `- ⏳ **${st.title}** (${st.complexity}) — ${st.description.substring(0, 200)}`
            ),
        ].join('\n');

        try {
            await this.memory.recordLearning(
                `Recovery plan: ${plan.summary.substring(0, 80)}`,
                recoveryContent,
                ['recovery', 'interrupted', error.category]
            );
        } catch {
            // Don't let memory failure compound the original error
        }
    }

    /**
     * Render a user-facing error message with category-specific guidance.
     */
    private renderErrorForUser(
        response: vscode.ChatResponseStream,
        classified: ClassifiedError,
        session: JohannSession
    ): void {
        const planProgress = session.plan
            ? (() => {
                const completed = session.plan.subtasks.filter(st => st.status === 'completed').length;
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
                    planProgress
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
                    `\n**Error:** ${classified.message.substring(0, 200)}\n`
                );
                break;

            case 'cancelled':
                response.markdown(
                    `\n\n**Request Cancelled**\n\n` +
                    `The orchestration was cancelled.` +
                    planProgress
                );
                break;

            case 'auth':
                response.markdown(
                    `\n\n**Authentication Error**\n\n` +
                    `${classified.userGuidance}\n\n` +
                    `**Error:** ${classified.message.substring(0, 200)}\n`
                );
                break;

            default:
                response.markdown(
                    `\n\n**Orchestration Error**\n\n` +
                    `${classified.message.substring(0, 300)}\n` +
                    planProgress
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
}
