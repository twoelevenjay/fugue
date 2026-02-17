import * as vscode from 'vscode';

// ============================================================================
// RETRY — Resilient execution layer for transient errors
//
// Provides:
// - Smart error classification (network, rate-limit, cancellation, etc.)
// - Exponential backoff with jitter
// - Configurable retry policies
// - Safe error message extraction (no more [object Object])
// ============================================================================

/**
 * Error categories for classification-based handling.
 */
export type ErrorCategory =
    | 'network' // Transient network errors — retry immediately
    | 'rate-limit' // API quota / request limit — retry with longer backoff
    | 'api-compat' // API compatibility error (unsupported parameter) — skip model, try another
    | 'cancelled' // User cancelled — do not retry
    | 'auth' // Authentication / permission — do not retry
    | 'unknown'; // Unclassified — retry cautiously

/**
 * Result of classifying an error.
 */
export interface ClassifiedError {
    category: ErrorCategory;
    message: string;
    retryable: boolean;
    userGuidance: string;
}

// Patterns for matching network-related errors
const NETWORK_PATTERNS = [
    'err_network',
    'network_changed',
    'econnreset',
    'econnrefused',
    'econnaborted',
    'etimedout',
    'epipe',
    'enetunreach',
    'ehostunreach',
    'enotfound',
    'socket hang up',
    'fetch failed',
    'network error',
    'network request failed',
    'failed to fetch',
    'net::err_',
    'dns_probe',
    'connection reset',
    'connection refused',
    'connection aborted',
    'connection timed out',
];

// Patterns for matching rate-limit / quota errors
// Use multi-word patterns to avoid false positives (e.g., "rate" matching "generate")
const RATE_LIMIT_PATTERNS = [
    'rate limit',
    'rate_limit',
    'ratelimit',
    'too many requests',
    'too many',
    'quota exceeded',
    'quota',
    'throttl',
    '429',
    'slow down',
    'request limit',
];

// Patterns for cancellation
const CANCEL_PATTERNS = ['cancel', 'abort', 'user abort'];

// Patterns for API compatibility errors (unsupported parameters, etc.)
// These are NOT retryable with the same model — need a different model
const API_COMPAT_PATTERNS = [
    'unsupported parameter',
    'unsupported_value',
    'invalid_request_error',
    'context_management',
    'no lowest priority node', // gpt-4o-mini fails 100% with this graph-scheduling error
];

// Patterns for auth errors
const AUTH_PATTERNS = [
    'unauthorized',
    'forbidden',
    '401',
    '403',
    'authentication',
    'permission denied',
    'access denied',
];

/**
 * Safely extract an error message from any thrown value.
 * Handles Error instances, strings, objects with message/code properties,
 * and the dreaded [object Object].
 */
export function extractErrorMessage(err: unknown): string {
    if (err === null || err === undefined) {
        return 'Unknown error (null/undefined)';
    }

    if (typeof err === 'string') {
        return err;
    }

    if (err instanceof Error) {
        // Include the error code if present (common in Node/VS Code errors)
        const code = (err as NodeJS.ErrnoException).code;
        const parts: string[] = [];
        if (code) {
            parts.push(`[${code}]`);
        }
        parts.push(err.message);
        if (err.cause && typeof err.cause === 'object' && 'message' in err.cause) {
            parts.push(`(caused by: ${(err.cause as Error).message})`);
        }
        return parts.join(' ');
    }

    // Handle objects that look like errors but aren't Error instances
    if (typeof err === 'object') {
        const obj = err as Record<string, unknown>;

        // Try common error properties
        const message = obj.message ?? obj.msg ?? obj.error ?? obj.reason;
        const code = obj.code ?? obj.errorCode ?? obj.statusCode;

        if (typeof message === 'string' && message.length > 0) {
            return code ? `[${code}] ${message}` : message;
        }

        // Last resort: try JSON serialization
        try {
            const json = JSON.stringify(err, null, 0);
            if (json && json !== '{}' && json.length < 500) {
                return json;
            }
        } catch {
            // circular reference or other issue
        }

        return `Non-standard error object: ${Object.keys(obj).join(', ') || '(empty)'}`;
    }

    return `Unexpected error type (${typeof err}): ${String(err)}`;
}

/**
 * Classify an error into a category with retry guidance.
 */
export function classifyError(err: unknown): ClassifiedError {
    const message = extractErrorMessage(err);
    const lower = message.toLowerCase();

    // Check cancellation first (highest priority)
    if (err instanceof vscode.CancellationError || CANCEL_PATTERNS.some((p) => lower.includes(p))) {
        return {
            category: 'cancelled',
            message,
            retryable: false,
            userGuidance: 'Request was cancelled.',
        };
    }

    // Check network errors
    if (NETWORK_PATTERNS.some((p) => lower.includes(p))) {
        return {
            category: 'network',
            message,
            retryable: true,
            userGuidance:
                'A transient network error occurred. Johann will retry automatically. ' +
                'If this persists, check your internet connection.',
        };
    }

    // Check API compatibility errors BEFORE rate limits (more specific check first)
    // These are NOT retryable with the same model — need a different model
    if (API_COMPAT_PATTERNS.some((p) => lower.includes(p))) {
        return {
            category: 'api-compat',
            message,
            retryable: false, // Not retryable with SAME model, but orchestrator should try DIFFERENT model
            userGuidance:
                'This model does not support a required API parameter. Johann will try a different model.',
        };
    }

    // Check rate limiting
    if (RATE_LIMIT_PATTERNS.some((p) => lower.includes(p))) {
        return {
            category: 'rate-limit',
            message,
            retryable: true,
            userGuidance:
                'Copilot request limit was reached. Johann will wait and retry. ' +
                'Consider increasing `github.copilot.chat.agent.maxRequests` in VS Code settings.',
        };
    }

    // Check auth
    if (AUTH_PATTERNS.some((p) => lower.includes(p))) {
        return {
            category: 'auth',
            message,
            retryable: false,
            userGuidance:
                'Authentication or permission error. Make sure GitHub Copilot is active and signed in.',
        };
    }

    // Unknown — retry once cautiously
    return {
        category: 'unknown',
        message,
        retryable: true,
        userGuidance: `An unexpected error occurred: ${message}`,
    };
}

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
    /** Maximum number of retry attempts (not counting the initial attempt) */
    maxRetries: number;
    /** Base delay in ms before first retry */
    baseDelayMs: number;
    /** Maximum delay in ms (cap for exponential backoff) */
    maxDelayMs: number;
    /** Multiplier for exponential backoff (default 2) */
    backoffMultiplier: number;
    /** Whether to add jitter to prevent thundering herd */
    jitter: boolean;
    /** Which error categories should trigger a retry */
    retryableCategories: ErrorCategory[];
}

/** Conservative retry policy for planning phase. */
export const PLANNING_RETRY_POLICY: RetryPolicy = {
    maxRetries: 3,
    baseDelayMs: 2000,
    maxDelayMs: 15000,
    backoffMultiplier: 2,
    jitter: true,
    retryableCategories: ['network', 'rate-limit', 'unknown'],
};

/** Moderate retry policy for subtask execution. */
export const EXECUTION_RETRY_POLICY: RetryPolicy = {
    maxRetries: 2,
    baseDelayMs: 3000,
    maxDelayMs: 20000,
    backoffMultiplier: 2,
    jitter: true,
    retryableCategories: ['network', 'rate-limit'],
};

/** Lenient retry policy for non-critical operations (reviews, merges). */
export const REVIEW_RETRY_POLICY: RetryPolicy = {
    maxRetries: 1,
    baseDelayMs: 2000,
    maxDelayMs: 5000,
    backoffMultiplier: 1,
    jitter: false,
    retryableCategories: ['network'],
};

/**
 * Calculate the delay before the next retry attempt.
 */
function calculateDelay(attempt: number, policy: RetryPolicy): number {
    let delay = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt);
    delay = Math.min(delay, policy.maxDelayMs);

    if (policy.jitter) {
        // Add ±25% jitter
        const jitterRange = delay * 0.25;
        delay += Math.random() * jitterRange * 2 - jitterRange;
    }

    return Math.round(delay);
}

/**
 * Sleep for a given number of milliseconds, respecting cancellation.
 * Returns true if sleep completed, false if cancelled.
 */
async function cancellableSleep(ms: number, token?: vscode.CancellationToken): Promise<boolean> {
    return new Promise((resolve) => {
        let listener: vscode.Disposable | undefined;
        const timeout = setTimeout(() => {
            listener?.dispose();
            resolve(true);
        }, ms);

        if (token) {
            listener = token.onCancellationRequested(() => {
                clearTimeout(timeout);
                listener?.dispose();
                resolve(false);
            });
        }
    });
}

/**
 * Execute an async function with retry logic.
 *
 * @param fn - The async function to execute
 * @param policy - Retry policy to apply
 * @param token - Cancellation token
 * @param onRetry - Optional callback invoked before each retry (for logging/streaming)
 * @returns The result of fn, or throws the last error if all retries fail
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    policy: RetryPolicy,
    token?: vscode.CancellationToken,
    onRetry?: (
        attempt: number,
        maxRetries: number,
        error: ClassifiedError,
        delayMs: number,
    ) => void,
): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        try {
            return await fn();
        } catch (err) {
            lastError = err;

            // Don't retry on the last attempt
            if (attempt >= policy.maxRetries) {
                break;
            }

            const classified = classifyError(err);

            // Don't retry if not retryable or not in allowed categories
            if (
                !classified.retryable ||
                !policy.retryableCategories.includes(classified.category)
            ) {
                break;
            }

            // Calculate backoff delay (longer for rate limits)
            let delayMs = calculateDelay(attempt, policy);
            if (classified.category === 'rate-limit') {
                delayMs = Math.max(delayMs, 10000); // At least 10s for rate limits
            }

            // Notify caller about the retry
            if (onRetry) {
                onRetry(attempt + 1, policy.maxRetries, classified, delayMs);
            }

            // Wait before retrying
            const completed = await cancellableSleep(delayMs, token);
            if (!completed) {
                throw new vscode.CancellationError();
            }
        }
    }

    // All retries exhausted — throw the last error
    throw lastError;
}
