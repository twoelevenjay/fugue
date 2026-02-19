import * as vscode from 'vscode';
import { RambleDebugConversationLog, DebugPhase } from './debugConversationLog';
import { getLogger } from './logger';

// ============================================================================
// RAMBLE LLM HELPERS — Logging-aware LLM interaction helpers
// ============================================================================

/**
 * Send a request to the LLM with optional debug logging.
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
    } = {},
): Promise<string> {
    const logger = getLogger();
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt),
    ];

    const requestOptions: vscode.LanguageModelChatRequestOptions = options.enableTools
        ? {
              tools: [
                  {
                      name: 'vscode_search',
                      description: 'Search the web for current information',
                      inputSchema: {
                          type: 'object',
                          properties: {
                              query: {
                                  type: 'string',
                                  description: 'Search query',
                              },
                          },
                          required: ['query'],
                      },
                  },
              ],
          }
        : {};

    logger.debug(`Sending LLM request`, {
        phase: options.phase || 'other',
        label: options.label || 'unlabeled',
        model: model.id,
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
        enableTools: options.enableTools || false,
    });

    try {
        const response = await model.sendRequest(messages, requestOptions, token);

        let result = '';
        for await (const chunk of response.text) {
            result += chunk;
        }

        const duration = Date.now() - startTime;

        logger.debug(`LLM response received`, {
            phase: options.phase || 'other',
            label: options.label || 'unlabeled',
            model: model.id,
            responseLength: result.length,
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
                responseText: result,
                durationMs: duration,
                questionRound: options.questionRound,
            });
        }

        return result;
    } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error(`LLM request failed`, {
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
                error: errorMessage,
                questionRound: options.questionRound,
            });
        }

        throw error;
    }
}
