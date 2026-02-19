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
 * Send a request to the LLM with optional debug logging and retry logic.
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

        const messages = [
            vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
        ];

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
            const response = await model.sendRequest(messages, requestOptions, token);

            let result = '';
            let chunkCount = 0;
            for await (const chunk of response.text) {
                result += chunk;
                chunkCount++;
            }

            const duration = Date.now() - startTime;

            // Check for empty response
            if (!result || result.trim().length === 0) {
                const emptyError = new Error(
                    `LLM returned empty response (${chunkCount} chunks received, all empty)`,
                );
                lastError = emptyError;

                logger.warn(`Empty LLM response (attempt ${attempt + 1}/${maxRetries + 1})`, {
                    phase: options.phase || 'other',
                    label: options.label || 'unlabeled',
                    model: model.id,
                    chunkCount,
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
                responseLength: result.length,
                chunkCount,
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
                    responseText: result,
                    durationMs: duration,
                    questionRound: options.questionRound,
                });
            }

            return result;
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
