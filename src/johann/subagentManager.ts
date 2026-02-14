import * as vscode from 'vscode';
import { Subtask, SubtaskResult, ModelInfo } from './types';

// ============================================================================
// SUBAGENT MANAGER — Spawns and manages individual subagent executions
//
// Each subagent is a single LLM invocation with:
// - Its own model (chosen by the model picker)
// - Its own prompt (the subtask description)
// - Context from dependent subtasks' results
// - Success criteria to evaluate against
// ============================================================================

const SUBAGENT_SYSTEM_PREFIX = `You are a focused coding agent executing a specific subtask as part of a larger orchestrated plan. Your job is to complete the task described below thoroughly and correctly.

RULES:
- Do exactly what the task description asks. No more, no less.
- Be thorough and produce complete, working code when code is requested.
- If you need to make assumptions, state them clearly.
- Format your response as clear, structured output.
- If the task has success criteria, make sure your output satisfies ALL of them.

`;

const REVIEW_SYSTEM_PROMPT = `You are a code review agent. Your job is to evaluate whether a subtask's output meets its success criteria.

Given:
1. The original subtask description
2. The success criteria
3. The output produced

Evaluate the output and return a JSON object:
{
  "success": true/false,
  "reason": "Brief explanation of why it passed or failed",
  "suggestions": ["Specific improvement suggestion 1", "..."]
}

Be strict but fair. If the output substantially meets the criteria with only minor issues, mark it as success.
If the output is fundamentally wrong, incomplete, or misses key criteria, mark it as failure.

Return ONLY valid JSON.`;

export class SubagentManager {
    /**
     * Execute a single subtask using the given model.
     * Streams the LLM output live to the response stream.
     */
    async executeSubtask(
        subtask: Subtask,
        modelInfo: ModelInfo,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream
    ): Promise<SubtaskResult> {
        const startTime = Date.now();

        try {
            // Build the prompt with context from dependencies
            const prompt = this.buildSubagentPrompt(subtask, dependencyResults, workspaceContext);

            const messages = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            // Open a collapsible log section
            if (stream) {
                stream.markdown(`\n<details><summary>📋 ${subtask.title} — <code>${modelInfo.name}</code> output</summary>\n\n`);
            }

            const response = await modelInfo.model.sendRequest(messages, {}, token);
            let output = '';
            for await (const chunk of response.text) {
                output += chunk;
                if (stream) {
                    stream.markdown(chunk);
                }
            }

            // Close the collapsible section
            if (stream) {
                stream.markdown('\n\n</details>\n\n');
            }

            const durationMs = Date.now() - startTime;

            return {
                success: true, // Preliminary — will be reviewed
                modelUsed: modelInfo.id,
                output,
                reviewNotes: '',
                durationMs,
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const errorMsg = `Execution error: ${err instanceof Error ? err.message : 'Unknown error'}`;

            if (stream) {
                stream.markdown(`\n⚠️ ${errorMsg}\n\n</details>\n\n`);
            }

            return {
                success: false,
                modelUsed: modelInfo.id,
                output: '',
                reviewNotes: errorMsg,
                durationMs,
                timestamp: new Date().toISOString(),
            };
        }
    }

    /**
     * Review a subtask's output against its success criteria.
     * Uses a model to evaluate the output.
     */
    async reviewSubtaskOutput(
        subtask: Subtask,
        result: SubtaskResult,
        reviewModel: vscode.LanguageModelChat,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream
    ): Promise<{ success: boolean; reason: string; suggestions: string[] }> {
        // If the execution itself failed, no need to review
        if (!result.success) {
            return {
                success: false,
                reason: result.reviewNotes || 'Execution failed',
                suggestions: [],
            };
        }

        // If no success criteria, assume success
        if (subtask.successCriteria.length === 0) {
            return {
                success: true,
                reason: 'No specific success criteria defined — output accepted.',
                suggestions: [],
            };
        }

        const reviewPrompt = `
=== SUBTASK ===
Title: ${subtask.title}
Description: ${subtask.description}

=== SUCCESS CRITERIA ===
${subtask.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

=== OUTPUT TO REVIEW ===
${result.output.substring(0, 10000)}
`;

        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(
                    REVIEW_SYSTEM_PROMPT + '\n\n---\n\n' + reviewPrompt
                )
            ];

            if (stream) {
                stream.markdown(`<details><summary>🔍 Reviewing: ${subtask.title}</summary>\n\n`);
            }

            const response = await reviewModel.sendRequest(messages, {}, token);
            let reviewOutput = '';
            for await (const chunk of response.text) {
                reviewOutput += chunk;
                if (stream) {
                    stream.markdown(chunk);
                }
            }

            if (stream) {
                stream.markdown('\n\n</details>\n\n');
            }

            // Parse the review result
            return this.parseReviewResult(reviewOutput);
        } catch {
            // If review fails, default to accepting the output
            return {
                success: true,
                reason: 'Review model unavailable — output accepted by default.',
                suggestions: [],
            };
        }
    }

    /**
     * Build the full prompt for a subagent, including dependency context.
     */
    private buildSubagentPrompt(
        subtask: Subtask,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string
    ): string {
        const parts: string[] = [];

        parts.push(SUBAGENT_SYSTEM_PREFIX);

        if (workspaceContext) {
            parts.push('=== WORKSPACE CONTEXT ===');
            parts.push(workspaceContext);
            parts.push('');
        }

        // Include results from dependencies
        if (subtask.dependsOn.length > 0) {
            parts.push('=== RESULTS FROM PREVIOUS SUBTASKS ===');
            for (const depId of subtask.dependsOn) {
                const depResult = dependencyResults.get(depId);
                if (depResult && depResult.success) {
                    parts.push(`\n--- Result from "${depId}" ---`);
                    parts.push(depResult.output.substring(0, 5000));
                }
            }
            parts.push('');
        }

        parts.push('=== YOUR TASK ===');
        parts.push(`**Title:** ${subtask.title}`);
        parts.push(`**Description:** ${subtask.description}`);

        if (subtask.successCriteria.length > 0) {
            parts.push('');
            parts.push('**Success Criteria:**');
            for (const criterion of subtask.successCriteria) {
                parts.push(`- ${criterion}`);
            }
        }

        return parts.join('\n');
    }

    /**
     * Parse the review model's output into a structured result.
     */
    private parseReviewResult(rawOutput: string): { success: boolean; reason: string; suggestions: string[] } {
        try {
            let jsonStr = rawOutput.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                jsonStr = jsonMatch[1].trim();
            }

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(jsonStr);
            } catch {
                const objMatch = rawOutput.match(/\{[\s\S]*\}/);
                if (objMatch) {
                    parsed = JSON.parse(objMatch[0]);
                } else {
                    throw new Error('No JSON found');
                }
            }

            return {
                success: Boolean(parsed.success),
                reason: String(parsed.reason || ''),
                suggestions: Array.isArray(parsed.suggestions)
                    ? parsed.suggestions.map(String)
                    : [],
            };
        } catch {
            // If we can't parse, check for obvious signals
            const lower = rawOutput.toLowerCase();
            if (lower.includes('"success": true') || lower.includes('"success":true')) {
                return { success: true, reason: 'Parsed as success from raw output', suggestions: [] };
            }
            return { success: false, reason: 'Could not parse review output', suggestions: [] };
        }
    }
}
