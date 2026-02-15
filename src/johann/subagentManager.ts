import * as vscode from 'vscode';
import { Subtask, SubtaskResult, ModelInfo } from './types';
import { withRetry, REVIEW_RETRY_POLICY, classifyError } from './retry';
import { DebugConversationLog } from './debugConversationLog';

// ============================================================================
// SUBAGENT MANAGER — Spawns and manages individual subagent executions
//
// Each subagent is a tool-using LLM agent that:
// - Has access to ALL VS Code language model tools (file creation, editing,
//   terminal commands, search, etc.) via the vscode.lm.tools API
// - Runs in an agentic loop: prompt → tool calls → results → prompt → ...
// - Continues until the model produces a final text response with no tool calls
// - Has its own model (chosen by the model picker)
// - Has context from dependent subtasks' results
// - Has success criteria to evaluate against
// ============================================================================

/** Maximum number of tool-calling loop iterations to prevent runaway agents. */
const MAX_TOOL_ROUNDS = 50;

const SUBAGENT_SYSTEM_PREFIX = `You are a GitHub Copilot coding agent executing a specific subtask assigned to you by an orchestrator.

CRITICAL RULES:
1. **USE YOUR TOOLS.** You have full access to file creation, file editing, terminal commands, and all other Copilot tools. You MUST use them to make real changes in the workspace. Do NOT just output text describing what should be done — actually DO it.
2. **CREATE REAL FILES.** When the task says "create a component," create the actual file in the workspace using your file-creation tools. When it says "install dependencies," run the actual npm/pip/etc command in the terminal. When it says "edit a file," use your edit tools.
3. **You are NOT Johann.** You are NOT an orchestrator. You are NOT doing onboarding. You are a worker agent executing a specific coding task. Do not introduce yourself. Do not ask questions. Do not give a greeting. Just execute the task.
4. **No stubs or placeholders.** Every function must be fully implemented. No "// TODO" comments. No "// Implement logic here" placeholders. No empty function bodies. Complete, working code only.
5. **Report what you DID.** Your final response should summarize what you actually did (files created, commands run, changes made), not what should be done.

IF YOU OUTPUT INSTRUCTIONS OR PROSE INSTEAD OF MAKING ACTUAL CHANGES WITH YOUR TOOLS, YOU HAVE FAILED THE TASK.

`;

const REVIEW_SYSTEM_PROMPT = `You are a strict code review agent. Your job is to evaluate whether a subtask's output meets its success criteria.

Given:
1. The original subtask description
2. The success criteria
3. The output produced

REVIEW CHECKLIST — You MUST evaluate ALL of these before making a judgment:

1. **Did real work happen?** The subagent was supposed to USE TOOLS to create files, run commands, and make actual workspace changes. If the output is just instructions, prose, step-by-step guides, or code in markdown blocks telling someone what to do (rather than reporting what was actually done), mark as FAILURE. Look for phrases like "Create a file", "Run the following", "Add this code" — these indicate the agent described work instead of doing it.

2. **No stubs or placeholders.** Search for these red flags in any code output:
   - Comments like "// TODO", "// Implement", "// Add logic here", "/* Placeholder */"
   - Empty function bodies or functions returning only hardcoded dummy values
   - Components with "Implement rendering logic here" style comments
   - Hooks or utilities that are skeletal shells without real logic
   If ANY are found in critical functionality, mark as FAILURE.

3. **Success criteria met.** Check each criterion individually. ALL must be substantially met.

4. **Code correctness.** Look for:
   - Missing imports or obviously wrong import paths
   - Variables or functions used before definition
   - Type mismatches (in TypeScript)
   - Logic bugs (e.g., event handlers triggering without proper guard conditions)
   - Missing error handling for likely failure points
   - Interfaces/types that don't match between files

5. **Completeness.** Are all requested files, components, and features present? Is anything mentioned in the task description but missing from the output?

Return a JSON object:
{
  "success": true/false,
  "reason": "Specific explanation citing concrete evidence from the output. Reference specific file names, function names, or code patterns you checked.",
  "suggestions": ["Specific actionable improvement 1", "..."],
  "checklist": {
    "realWorkDone": true/false,
    "noStubs": true/false,
    "criteriaMet": true/false,
    "codeCorrect": true/false,
    "complete": true/false
  }
}

A review that passes everything without citing specific evidence is WRONG. Analyze the output thoroughly.

Return ONLY valid JSON.`;

export class SubagentManager {
    /**
     * Discover available VS Code LM tools and convert to LanguageModelChatTool format.
     * Filters out tools that aren't useful for coding tasks.
     */
    private getAvailableTools(): vscode.LanguageModelChatTool[] {
        return vscode.lm.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        }));
    }

    /**
     * Execute a single subtask using the given model.
     * Runs a full agentic tool-calling loop:
     *   1. Send prompt + tool definitions to the model
     *   2. If the model returns tool calls, execute them via vscode.lm.invokeTool()
     *   3. Feed tool results back as messages
     *   4. Repeat until the model produces a final text-only response
     *   5. Return the accumulated text output
     */
    async executeSubtask(
        subtask: Subtask,
        modelInfo: ModelInfo,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog,
        toolToken?: vscode.ChatParticipantToolToken
    ): Promise<SubtaskResult> {
        const startTime = Date.now();

        try {
            // Build the prompt with context from dependencies
            const prompt = this.buildSubagentPrompt(subtask, dependencyResults, workspaceContext);

            // Discover available tools
            const tools = this.getAvailableTools();

            const options: vscode.LanguageModelChatRequestOptions = {
                tools: tools.length > 0 ? tools : undefined,
                toolMode: tools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
            };

            // Build the conversation messages — will grow as we loop
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(prompt)
            ];

            // Open a collapsible log section
            if (stream) {
                stream.markdown(`\n<details><summary>📋 ${subtask.title} — <code>${modelInfo.name}</code> output</summary>\n\n`);
            }

            let fullOutput = '';
            let round = 0;
            let totalToolCalls = 0;

            // === AGENTIC TOOL-CALLING LOOP ===
            while (round < MAX_TOOL_ROUNDS) {
                if (token.isCancellationRequested) break;
                round++;

                const callStart = Date.now();
                const response = await modelInfo.model.sendRequest(messages, options, token);

                // Collect text parts and tool call parts from the response stream
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                let roundText = '';

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        roundText += part.value;
                        fullOutput += part.value;
                        if (stream) {
                            stream.markdown(part.value);
                        }
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                    }
                }

                // Debug log this round
                if (debugLog) {
                    const toolCallSummary = toolCalls.length > 0
                        ? ` | Tool calls: ${toolCalls.map(tc => tc.name).join(', ')}`
                        : '';
                    await debugLog.logLLMCall({
                        timestamp: new Date(callStart).toISOString(),
                        phase: 'subtask-execution',
                        label: `${subtask.title} (round ${round}${toolCallSummary})`,
                        model: modelInfo.id || modelInfo.name || 'unknown',
                        promptMessages: round === 1
                            ? [prompt]
                            : [`(continuation round ${round}, ${messages.length} messages in context)`],
                        responseText: roundText + (toolCalls.length > 0 ? `\n[${toolCalls.length} tool call(s)]` : ''),
                        durationMs: Date.now() - callStart,
                    });
                }

                // If no tool calls, the model is done — break out of the loop
                if (toolCalls.length === 0) {
                    break;
                }

                totalToolCalls += toolCalls.length;

                // Add the assistant's response (with tool calls) to the conversation
                const assistantParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
                if (roundText) {
                    assistantParts.push(new vscode.LanguageModelTextPart(roundText));
                }
                for (const tc of toolCalls) {
                    assistantParts.push(tc);
                }
                messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                // Execute each tool call and feed results back
                for (const tc of toolCalls) {
                    if (token.isCancellationRequested) break;

                    try {
                        if (stream) {
                            stream.markdown(`\n> 🔧 Calling tool: \`${tc.name}\`\n`);
                        }

                        const toolResult = await vscode.lm.invokeTool(tc.name, {
                            input: tc.input as object,
                            toolInvocationToken: toolToken,
                        }, token);

                        // Extract text content from the tool result for logging
                        const resultText = this.extractToolResultText(toolResult);

                        if (stream && resultText) {
                            // Show a short summary of the tool result
                            const preview = resultText.length > 200
                                ? resultText.substring(0, 200) + '…'
                                : resultText;
                            stream.markdown(`> ✅ Result: ${preview}\n\n`);
                        }

                        fullOutput += `\n[Tool: ${tc.name}] ${resultText}\n`;

                        // Feed the tool result back to the conversation
                        messages.push(
                            vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(tc.callId, toolResult.content as (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[])
                            ])
                        );
                    } catch (toolErr) {
                        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);

                        if (stream) {
                            stream.markdown(`\n> ❌ Tool \`${tc.name}\` failed: ${errMsg.substring(0, 150)}\n\n`);
                        }

                        fullOutput += `\n[Tool: ${tc.name}] ERROR: ${errMsg}\n`;

                        // Feed error back to the model so it can recover
                        messages.push(
                            vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelToolResultPart(tc.callId, [
                                    new vscode.LanguageModelTextPart(`Error executing tool "${tc.name}": ${errMsg}`)
                                ])
                            ])
                        );
                    }
                }
            }

            // Close the collapsible section
            if (stream) {
                if (totalToolCalls > 0) {
                    stream.markdown(`\n\n> **${totalToolCalls} tool call(s)** executed across **${round} round(s)**\n`);
                }
                stream.markdown('\n\n</details>\n\n');
            }

            const durationMs = Date.now() - startTime;

            return {
                success: true, // Preliminary — will be reviewed
                modelUsed: modelInfo.id,
                output: fullOutput,
                reviewNotes: '',
                durationMs,
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const classified = classifyError(err);

            let errorMsg: string;
            if (classified.category === 'rate-limit') {
                errorMsg =
                    `Copilot request limit reached during subtask execution. ` +
                    `Increase \`github.copilot.chat.agent.maxRequests\` in VS Code settings. ` +
                    `Original error: ${classified.message}`;
            } else if (classified.category === 'network') {
                errorMsg =
                    `Network error during subtask execution (retries exhausted): ${classified.message}`;
            } else {
                errorMsg = `Execution error: ${classified.message}`;
            }

            // Debug log the failed call
            if (debugLog) {
                await debugLog.logLLMCall({
                    timestamp: new Date(startTime).toISOString(),
                    phase: 'subtask-execution',
                    label: subtask.title,
                    model: modelInfo.id || modelInfo.name || 'unknown',
                    promptMessages: ['(prompt was built but call failed)'],
                    responseText: '',
                    durationMs,
                    error: errorMsg,
                });
            }

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
     * Extract readable text from a LanguageModelToolResult.
     */
    private extractToolResultText(result: vscode.LanguageModelToolResult): string {
        const parts: string[] = [];
        for (const item of result.content) {
            if (item instanceof vscode.LanguageModelTextPart) {
                parts.push(item.value);
            }
        }
        return parts.join('\n');
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
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog
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
            const fullReviewPrompt = REVIEW_SYSTEM_PROMPT + '\n\n---\n\n' + reviewPrompt;
            const messages = [
                vscode.LanguageModelChatMessage.User(fullReviewPrompt)
            ];

            if (stream) {
                stream.markdown(`<details><summary>🔍 Reviewing: ${subtask.title}</summary>\n\n`);
            }

            const reviewOutput = await withRetry(
                async () => {
                    const callStart = Date.now();
                    const response = await reviewModel.sendRequest(messages, {}, token);
                    let text = '';
                    for await (const chunk of response.text) {
                        text += chunk;
                        if (stream) {
                            stream.markdown(chunk);
                        }
                    }

                    // Debug log the review call
                    if (debugLog) {
                        await debugLog.logLLMCall({
                            timestamp: new Date(callStart).toISOString(),
                            phase: 'review',
                            label: `Review: ${subtask.title}`,
                            model: reviewModel.id || reviewModel.name || 'unknown',
                            promptMessages: [fullReviewPrompt],
                            responseText: text,
                            durationMs: Date.now() - callStart,
                        });
                    }

                    return text;
                },
                REVIEW_RETRY_POLICY,
                token
                // No onRetry callback — reviews are silent about retries
            );

            if (stream) {
                stream.markdown('\n\n</details>\n\n');
            }

            // Parse the review result
            return this.parseReviewResult(reviewOutput);
        } catch {
            // If review fails, default to REJECTING the output — don't rubber-stamp
            return {
                success: false,
                reason: 'Review model unavailable — output rejected by default for safety. Re-run to retry.',
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

        // If this subtask has an isolated worktree, instruct the subagent to use it
        if (subtask.worktreePath) {
            parts.push('=== ISOLATED WORKING DIRECTORY ===');
            parts.push(`You are operating in a dedicated git worktree at: ${subtask.worktreePath}`);
            parts.push('This is an isolated copy of the codebase on its own branch, created to prevent');
            parts.push('conflicts with other parallel subtasks.');
            parts.push('');
            parts.push('CRITICAL RULES FOR WORKTREE ISOLATION:');
            parts.push(`1. ALL file operations (create, edit, delete) MUST target paths under: ${subtask.worktreePath}`);
            parts.push(`2. When running terminal commands, ALWAYS cd to the worktree first: cd "${subtask.worktreePath}"`);
            parts.push('3. Do NOT modify files in the main workspace directory — only use your worktree.');
            parts.push('4. Your changes will be automatically committed and merged back to the main branch.');
            parts.push('5. If installing dependencies, run install commands inside the worktree directory.');
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
     * Handles both the legacy format and new checklist format.
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

            // If the review includes a checklist, ALL checklist items must pass
            // for the overall review to pass. This prevents rubber-stamp reviews.
            let success = Boolean(parsed.success);
            const checklist = parsed.checklist as Record<string, boolean> | undefined;
            if (checklist && typeof checklist === 'object') {
                const checklistValues = Object.values(checklist);
                const allPassed = checklistValues.every(v => v === true);
                if (!allPassed && success) {
                    // Override: if any checklist item failed, the review fails
                    success = false;
                    const failedItems = Object.entries(checklist)
                        .filter(([, v]) => v !== true)
                        .map(([k]) => k);
                    parsed.reason = `Review checklist failures: ${failedItems.join(', ')}. ${parsed.reason || ''}`;
                }
            }

            return {
                success,
                reason: String(parsed.reason || ''),
                suggestions: Array.isArray(parsed.suggestions)
                    ? parsed.suggestions.map(String)
                    : [],
            };
        } catch {
            // If we can't parse, default to FAILURE (not success)
            // A review that can't be parsed should not rubber-stamp the output
            return { success: false, reason: 'Could not parse review output — defaulting to failure for safety', suggestions: [] };
        }
    }
}
