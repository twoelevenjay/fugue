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

// ============================================================================
// ORCHESTRATOR — The top-level controller
// Inspired by OpenClaw's Gateway control plane and agent loop.
//
// Flow:
// 1. User sends request to @johann
// 2. Orchestrator uses user's model to create an execution plan
// 3. For each subtask: pick model → execute → review → escalate if needed
// 4. Merge results and respond
// 5. Write to persistent memory
// ============================================================================

const MERGE_SYSTEM_PROMPT = `You are Johann, collecting and synthesizing results from multiple subagents that worked on parts of a larger task.

Given the original request and the results from each subtask, produce a unified, coherent response.

RULES:
- Synthesize, don't just concatenate. The user shouldn't see the internal decomposition.
- If all subtasks succeeded, present the combined result clearly.
- If some subtasks failed, be transparent about what was accomplished and what wasn't.
- Include all code, changes, and explanations from successful subtasks.
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
     */
    async orchestrate(
        request: string,
        workspaceContext: string,
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
            workspaceContext,
        };

        // Ensure memory directory exists
        await this.memory.ensureMemoryDir();

        // Get memory context
        const memoryContext = await this.memory.getRecentMemoryContext();

        try {
            // == PHASE 1: PLANNING ==
            response.markdown('### Planning\n\n');
            response.markdown('Analyzing your request and creating an execution plan...\n\n');

            const plan = await this.taskDecomposer.decompose(
                request,
                workspaceContext,
                memoryContext,
                userModel,
                token
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

            const results = await this.executePlan(plan, workspaceContext, response, token);

            // == PHASE 3: MERGE & RESPOND ==
            session.status = 'reviewing';
            response.markdown('\n### Synthesizing Results\n\n');

            const finalOutput = await this.mergeResults(
                request,
                plan,
                results,
                userModel,
                token
            );

            response.markdown(finalOutput);

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

        } catch (err) {
            session.status = 'failed';
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            response.markdown(`\n\n**Orchestration Error:** ${errorMsg}\n`);

            await this.memory.recordError(errorMsg, `Session: ${session.sessionId}, Request: ${request.substring(0, 200)}`);
        }
    }

    /**
     * Execute the orchestration plan, respecting dependencies and strategy.
     */
    private async executePlan(
        plan: OrchestrationPlan,
        workspaceContext: string,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
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

            // Execute ready subtasks (could be parallel in future, serial for now)
            for (const subtask of ready) {
                if (token.isCancellationRequested) break;

                const result = await this.executeSubtaskWithEscalation(
                    subtask,
                    results,
                    workspaceContext,
                    response,
                    token
                );

                results.set(subtask.id, result);
                subtask.result = result;
                completed.add(subtask.id);
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
        token: vscode.CancellationToken
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
                token
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
                token
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
                response.markdown(` done.\n`);
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
     */
    private async mergeResults(
        originalRequest: string,
        plan: OrchestrationPlan,
        results: Map<string, SubtaskResult>,
        model: vscode.LanguageModelChat,
        token: vscode.CancellationToken
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

            const response = await model.sendRequest(messages, {}, token);
            let output = '';
            for await (const chunk of response.text) {
                output += chunk;
            }
            return output;
        } catch {
            // Fallback: concatenate results
            return this.fallbackMerge(plan, results);
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
