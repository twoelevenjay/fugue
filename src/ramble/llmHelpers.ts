import * as vscode from 'vscode';
import { RambleDebugConversationLog, DebugPhase } from './debugConversationLog';
import { getLogger } from './logger';

// ============================================================================
// RAMBLE LLM HELPERS — Logging-aware LLM interaction helpers
// ============================================================================

/**
 * Tools that are useful for Ramble's web research phase.
 * Includes web search, documentation lookup, etc.
 */
const RAMBLE_USEFUL_TOOLS = new Set<string>([
    'vscode_web_search',
    'vscode_websearch',
    'web_search',
    'websearch',
    'search',
]);

/**
 * Get available tools from VS Code API that are useful for web research.
 */
function getWebResearchTools(): vscode.LanguageModelChatTool[] {
    const tools: vscode.LanguageModelChatTool[] = [];

    for (const tool of vscode.lm.tools) {
        // Check if tool name suggests web search capability
        const toolNameLower = tool.name.toLowerCase();
        const isWebSearchTool =
            RAMBLE_USEFUL_TOOLS.has(tool.name) ||
            toolNameLower.includes('search') ||
            toolNameLower.includes('web');

        if (isWebSearchTool) {
            tools.push({
                name: tool.name,
                description: tool.description,
                inputSchema: sanitizeToolSchema(tool.inputSchema),
            });
        }
    }

    return tools;
}

/**
 * Sanitize tool input schema to avoid provider validation failures.
 */
function sanitizeToolSchema(inputSchema: unknown): object {
    if (!isRecord(inputSchema)) {
        return {
            type: 'object',
            properties: {},
            additionalProperties: true,
        };
    }

    const cloned = JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>;
    normalizeSchemaNode(cloned);
    return cloned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize schema nodes recursively to ensure valid structure.
 */
function normalizeSchemaNode(node: unknown): void {
    if (!isRecord(node)) {
        return;
    }

    if (node.type === 'object') {
        const properties = node.properties;
        if (!isRecord(properties)) {
            node.properties = {};
        }
        if (node.additionalProperties === undefined) {
            node.additionalProperties = true;
        }
    }

    if (isRecord(node.properties)) {
        for (const child of Object.values(node.properties)) {
            normalizeSchemaNode(child);
        }
    }

    if (node.items !== undefined) {
        normalizeSchemaNode(node.items);
    }

    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const variants = node[key];
        if (Array.isArray(variants)) {
            for (const variant of variants) {
                normalizeSchemaNode(variant);
            }
        }
    }
}

/**
 * Send a request to the LLM with optional debug logging, retry logic, and tool calling.
 *
 * Implements a full agentic tool-calling loop:
 * 1. Send request to model with available tools
 * 2. Process response stream (can contain text AND tool calls)
 * 3. If model requests tools, execute them via vscode.lm.invokeTool()
 * 4. Feed tool results back to model
 * 5. Repeat until model returns final text response
 */
export async function sendToLLMWithLogging(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken,
    options: {
        enableTools?: boolean;
        debugLog?: RambleDebugConversationLog;
        phase?: DebugPhase;
        label?: string;
        questionRound?: number;
        maxRetries?: number;
    } = {},
): Promise<string> {
    const logger = getLogger();
    const maxRetries = options.maxRetries ?? 2; // Default: 2 retries (3 total attempts)

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const isRetry = attempt > 0;
        const startTime = Date.now();
        const timestamp = new Date().toISOString();

        if (isRetry) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
            logger.warn(
                `LLM call attempt ${attempt + 1}/${maxRetries + 1} after ${delay}ms delay`,
                {
                    phase: options.phase || 'other',
                    label: options.label || 'unlabeled',
                    previousError: lastError?.message,
                },
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }

        // Get real tools from VS Code API if tools are enabled
        const tools = options.enableTools ? getWebResearchTools() : [];

        if (options.enableTools && tools.length === 0) {
            logger.warn('Tools requested but no web search tools available from VS Code API', {
                phase: options.phase || 'other',
                availableToolCount: Array.from(vscode.lm.tools).length,
            });
        }

        const requestOptions: vscode.LanguageModelChatRequestOptions =
            tools.length > 0
                ? {
                      tools,
                      toolMode: vscode.LanguageModelChatToolMode.Auto,
                  }
                : {};

        logger.debug(`Sending LLM request (attempt ${attempt + 1}/${maxRetries + 1})`, {
            phase: options.phase || 'other',
            label: options.label || 'unlabeled',
            model: model.id,
            systemPromptLength: systemPrompt.length,
            userPromptLength: userPrompt.length,
            toolsEnabled: options.enableTools || false,
            toolCount: tools.length,
            toolNames: tools.map((t) => t.name),
        });

        try {
            // Agentic tool-calling loop
            const conversationMessages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
            ];

            let finalText = '';
            let toolCallRound = 0;
            const maxToolRounds = 10; // Give model enough rounds to complete research

            while (toolCallRound < maxToolRounds) {
                const response = await model.sendRequest(
                    conversationMessages,
                    requestOptions,
                    token,
                );

                let roundText = '';
                const toolCalls: Array<{ name: string; callId: string; input: any }> = [];

                // Process the stream - can contain text parts AND tool call parts
                for await (const chunk of response.stream) {
                    if (chunk instanceof vscode.LanguageModelTextPart) {
                        roundText += chunk.value;
                    } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push({
                            name: chunk.name,
                            callId: chunk.callId,
                            input: chunk.input,
                        });
                        logger.debug('Model requested tool call', {
                            toolName: chunk.name,
                            callId: chunk.callId,
                        });
                    }
                }

                // Add any text from this round to final output
                if (roundText) {
                    finalText += roundText;
                }

                // If no tool calls, we're done
                if (toolCalls.length === 0) {
                    break;
                }

                // Execute tool calls and feed results back
                logger.info(
                    `Tool round ${toolCallRound + 1}: Executing ${toolCalls.length} tool call(s)`,
                    {
                        phase: options.phase || 'other',
                        tools: toolCalls.map((tc) => tc.name),
                        roundText: roundText
                            ? `${roundText.substring(0, 100)}...`
                            : '(no text yet)',
                    },
                );

                // Add assistant's tool calls to conversation
                const assistantParts: Array<
                    vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
                > = [];
                if (roundText) {
                    assistantParts.push(new vscode.LanguageModelTextPart(roundText));
                }
                assistantParts.push(
                    ...toolCalls.map(
                        (tc) => new vscode.LanguageModelToolCallPart(tc.callId, tc.name, tc.input),
                    ),
                );
                conversationMessages.push(
                    vscode.LanguageModelChatMessage.Assistant(assistantParts),
                );

                // Execute tools and collect results
                const toolResults: vscode.LanguageModelToolResultPart[] = [];
                for (const toolCall of toolCalls) {
                    try {
                        const result = await vscode.lm.invokeTool(
                            toolCall.name,
                            {
                                toolInvocationToken: undefined, // Not in ChatParticipant context
                                input: toolCall.input,
                            },
                            token,
                        );

                        // LanguageModelToolResult has a content property with array of text parts
                        const resultContent: vscode.LanguageModelTextPart[] = [];
                        for (const part of result.content) {
                            if (part instanceof vscode.LanguageModelTextPart) {
                                resultContent.push(part);
                            }
                        }

                        toolResults.push(
                            new vscode.LanguageModelToolResultPart(toolCall.callId, resultContent),
                        );

                        const resultPreview = resultContent
                            .map((p) => p.value)
                            .join(' ')
                            .substring(0, 200);
                        logger.info(`Tool "${toolCall.name}" succeeded`, {
                            phase: options.phase || 'other',
                            callId: toolCall.callId,
                            resultParts: resultContent.length,
                            preview: resultPreview ? `${resultPreview}...` : '(empty)',
                        });
                    } catch (error) {
                        const errorMsg = error instanceof Error ? error.message : String(error);
                        toolResults.push(
                            new vscode.LanguageModelToolResultPart(toolCall.callId, [
                                new vscode.LanguageModelTextPart(`Error: ${errorMsg}`),
                            ]),
                        );
                        logger.error('Tool call failed', {
                            tool: toolCall.name,
                            error: errorMsg,
                        });
                    }
                }

                // Add tool results to conversation
                conversationMessages.push(vscode.LanguageModelChatMessage.User(toolResults));

                toolCallRound++;

                if (toolCallRound >= maxToolRounds - 2) {
                    logger.warn(
                        `Approaching tool round limit (${toolCallRound}/${maxToolRounds})`,
                        {
                            phase: options.phase || 'other',
                            label: options.label || 'unlabeled',
                            textSoFar:
                                finalText.length > 0
                                    ? `${finalText.substring(0, 100)}...`
                                    : '(none)',
                        },
                    );
                }
            }

            const duration = Date.now() - startTime;

            // Check for empty response
            if (!finalText || finalText.trim().length === 0) {
                const emptyError = new Error(
                    `LLM returned empty response after ${toolCallRound} tool rounds (hit limit: ${toolCallRound >= maxToolRounds})`,
                );
                lastError = emptyError;

                logger.error(`Empty LLM response (attempt ${attempt + 1}/${maxRetries + 1})`, {
                    phase: options.phase || 'other',
                    label: options.label || 'unlabeled',
                    model: model.id,
                    toolRounds: toolCallRound,
                    hitToolLimit: toolCallRound >= maxToolRounds,
                    conversationLength: conversationMessages.length,
                    durationMs: duration,
                });

                // Log to debug conversation log if provided
                if (options.debugLog) {
                    await options.debugLog.logLLMCall({
                        timestamp,
                        phase: options.phase || 'other',
                        label: options.label || 'unlabeled',
                        model: model.id,
                        promptMessages: [systemPrompt + '\n\n---\n\n' + userPrompt],
                        responseText: '',
                        durationMs: duration,
                        error: `Empty response (attempt ${attempt + 1}/${maxRetries + 1})`,
                        questionRound: options.questionRound,
                    });
                }

                // Retry if we have attempts left
                if (attempt < maxRetries) {
                    continue;
                }

                // No retries left, throw
                throw emptyError;
            }

            // Success!
            logger.debug(`LLM response received (attempt ${attempt + 1}/${maxRetries + 1})`, {
                phase: options.phase || 'other',
                label: options.label || 'unlabeled',
                model: model.id,
                responseLength: finalText.length,
                toolRounds: toolCallRound,
                durationMs: duration,
                wasRetry: isRetry,
            });

            // Log to debug conversation log if provided
            if (options.debugLog) {
                await options.debugLog.logLLMCall({
                    timestamp,
                    phase: options.phase || 'other',
                    label: options.label || 'unlabeled',
                    model: model.id,
                    promptMessages: [systemPrompt + '\n\n---\n\n' + userPrompt],
                    responseText: finalText,
                    durationMs: duration,
                    questionRound: options.questionRound,
                });
            }

            return finalText;
        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            lastError = error instanceof Error ? error : new Error(errorMessage);

            logger.error(`LLM request failed (attempt ${attempt + 1}/${maxRetries + 1})`, {
                phase: options.phase || 'other',
                label: options.label || 'unlabeled',
                model: model.id,
                error: errorMessage,
                durationMs: duration,
            });

            // Log to debug conversation log if provided
            if (options.debugLog) {
                await options.debugLog.logLLMCall({
                    timestamp,
                    phase: options.phase || 'other',
                    label: options.label || 'unlabeled',
                    model: model.id,
                    promptMessages: [systemPrompt + '\n\n---\n\n' + userPrompt],
                    responseText: '',
                    durationMs: duration,
                    error: `${errorMessage} (attempt ${attempt + 1}/${maxRetries + 1})`,
                    questionRound: options.questionRound,
                });
            }

            // Retry if we have attempts left (unless it's a cancellation)
            if (attempt < maxRetries && !(error instanceof vscode.CancellationError)) {
                continue;
            }

            // No retries left or cancellation, throw
            throw error;
        }
    }

    // Should never reach here, but TypeScript needs it
    throw lastError || new Error('LLM request failed after all retries');
}
