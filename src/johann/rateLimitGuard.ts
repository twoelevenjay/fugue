import * as vscode from 'vscode';
import { getLogger } from './logger';
import { classifyError, extractErrorMessage } from './retry';

// ============================================================================
// RATE LIMIT GUARD — Proactive throttling + reactive recovery
//
// Two-layer protection against API rate limits:
//
// Layer 1 — PROACTIVE: Tracks request timestamps per model family.
//   Before each sendRequest, applies a throttle pause if we're approaching
//   the limit (sliding-window token bucket).
//
// Layer 2 — REACTIVE: Catches 429 / rate-limit errors, parses Retry-After
//   hints, applies exponential backoff with jitter, and retries.
//
// Shared across all parallel subtasks via the Orchestrator, so one agent
// hitting a limit signals ALL agents to slow down.
// ============================================================================

/**
 * Configuration for the rate limit guard.
 */
export interface RateLimitConfig {
    /**
     * Maximum requests per sliding window before proactive throttling kicks in.
     * Default: 15 requests per window (conservative for Copilot Chat).
     */
    maxRequestsPerWindow: number;

    /**
     * Size of the sliding window in milliseconds.
     * Default: 60_000 (1 minute).
     */
    windowMs: number;

    /**
     * Minimum pause in ms when proactive throttle triggers.
     * Default: 2_000 (2 seconds).
     */
    proactivePauseMs: number;

    /**
     * Base backoff in ms for reactive retry after a rate limit error.
     * Default: 10_000 (10 seconds).
     */
    reactiveBaseMs: number;

    /**
     * Maximum backoff in ms for reactive retry.
     * Default: 120_000 (2 minutes).
     */
    reactiveMaxMs: number;

    /**
     * Maximum number of consecutive rate-limit retries before giving up.
     * Default: 5.
     */
    maxRetries: number;
}

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
    maxRequestsPerWindow: 15,
    windowMs: 60_000,
    proactivePauseMs: 2_000,
    reactiveBaseMs: 10_000,
    reactiveMaxMs: 120_000,
    maxRetries: 5,
};

/**
 * Per-family tracking bucket.
 */
interface FamilyBucket {
    /** Timestamps of recent requests (within sliding window). */
    timestamps: number[];
    /** Current consecutive rate-limit hits (resets on success). */
    consecutiveHits: number;
    /** Global cooldown — no requests before this timestamp. */
    cooldownUntil: number;
}

/**
 * Result of a guarded sendRequest call.
 */
export interface GuardedResponse {
    /** The LLM response (present on success). */
    response: vscode.LanguageModelChatResponse;
    /** How long we paused before the request (proactive throttle), in ms. */
    proactivePauseMs: number;
    /** How long we paused due to reactive backoff (across all retries), in ms. */
    reactivePauseMs: number;
    /** Number of rate-limit retries that occurred. */
    retryCount: number;
}

/**
 * Shared rate limit guard.
 *
 * Create ONE instance in the Orchestrator and pass it to all SubagentManagers
 * so parallel agents share the same sliding window.
 */
export class RateLimitGuard {
    private readonly config: RateLimitConfig;
    private readonly buckets = new Map<string, FamilyBucket>();

    constructor(config?: Partial<RateLimitConfig>) {
        this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
    }

    /**
     * Get or create the tracking bucket for a model family.
     */
    private getBucket(family: string): FamilyBucket {
        let bucket = this.buckets.get(family);
        if (!bucket) {
            bucket = { timestamps: [], consecutiveHits: 0, cooldownUntil: 0 };
            this.buckets.set(family, bucket);
        }
        return bucket;
    }

    /**
     * Prune timestamps outside the sliding window.
     */
    private pruneWindow(bucket: FamilyBucket, now: number): void {
        const cutoff = now - this.config.windowMs;
        bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);
    }

    /**
     * Calculate how long to pause before the next request (proactive throttle).
     * Returns 0 if no pause is needed.
     */
    private calculateProactivePause(bucket: FamilyBucket, now: number): number {
        // Honour active cooldown from a prior rate-limit hit
        if (now < bucket.cooldownUntil) {
            return bucket.cooldownUntil - now;
        }

        this.pruneWindow(bucket, now);

        const count = bucket.timestamps.length;
        if (count < this.config.maxRequestsPerWindow) {
            return 0;
        }

        // We're at or above the limit.  Wait until the oldest request falls
        // out of the window, plus a small safety margin.
        const oldest = bucket.timestamps[0];
        const waitUntil = oldest + this.config.windowMs + this.config.proactivePauseMs;
        return Math.max(waitUntil - now, this.config.proactivePauseMs);
    }

    /**
     * Calculate reactive backoff after a rate-limit error.
     * Uses exponential backoff with ±25% jitter.
     */
    private calculateReactiveBackoff(consecutiveHits: number, retryAfterMs?: number): number {
        // If the server told us how long to wait, respect that (with a floor)
        if (retryAfterMs && retryAfterMs > 0) {
            return Math.max(retryAfterMs, this.config.reactiveBaseMs);
        }

        const base = this.config.reactiveBaseMs * Math.pow(2, consecutiveHits - 1);
        const capped = Math.min(base, this.config.reactiveMaxMs);

        // Add ±25% jitter
        const jitter = capped * 0.25;
        return Math.round(capped + Math.random() * jitter * 2 - jitter);
    }

    /**
     * Try to extract a Retry-After value (in ms) from an error.
     */
    private extractRetryAfter(err: unknown): number | undefined {
        const msg = extractErrorMessage(err).toLowerCase();

        // Pattern: "retry after 30s" or "retry-after: 30"
        const secondsMatch = msg.match(/retry[- ]?after[:\s]*(\d+)\s*s/i);
        if (secondsMatch) {
            return parseInt(secondsMatch[1], 10) * 1000;
        }

        // Pattern: "retry after 30000ms" or "retry-after: 30000"
        const msMatch = msg.match(/retry[- ]?after[:\s]*(\d{4,})/i);
        if (msMatch) {
            return parseInt(msMatch[1], 10);
        }

        // Pattern: "wait N seconds" / "try again in N seconds"
        const waitMatch = msg.match(/(?:wait|try again in)\s+(\d+)\s*(?:second|sec)/i);
        if (waitMatch) {
            return parseInt(waitMatch[1], 10) * 1000;
        }

        // Pattern: plain number that looks like seconds (e.g. "30" at the end
        // of a "Too Many Requests" message)
        const trailingNum = msg.match(/(?:too many requests|rate limit).*?(\d+)\s*$/i);
        if (trailingNum) {
            const val = parseInt(trailingNum[1], 10);
            // Heuristic: if < 600, treat as seconds; otherwise ms
            return val < 600 ? val * 1000 : val;
        }

        return undefined;
    }

    /**
     * Sleep for `ms` milliseconds, cancellable via token.
     * Returns false if cancelled.
     */
    private async sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
        if (ms <= 0) {
            return true;
        }
        return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
                listener.dispose();
                resolve(true);
            }, ms);
            const listener = token.onCancellationRequested(() => {
                clearTimeout(timeout);
                listener.dispose();
                resolve(false);
            });
        });
    }

    /**
     * Send a request through the rate limit guard.
     *
     * This wraps `model.sendRequest()` with:
     *   1. Proactive pause (sliding-window throttle)
     *   2. Reactive retry on 429 / rate-limit errors
     *   3. Cross-agent cooldown propagation
     *
     * @throws if cancelled or if all retries are exhausted
     */
    async guardedSendRequest(
        model: vscode.LanguageModelChat,
        family: string,
        messages: vscode.LanguageModelChatMessage[],
        options: vscode.LanguageModelChatRequestOptions,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
    ): Promise<GuardedResponse> {
        const logger = getLogger();
        const bucket = this.getBucket(family);
        let proactivePauseTotal = 0;
        let reactivePauseTotal = 0;
        let retryCount = 0;

        // === LAYER 1: PROACTIVE THROTTLE ===
        const proactivePause = this.calculateProactivePause(bucket, Date.now());
        if (proactivePause > 0) {
            logger.info(
                `[RateLimitGuard] Proactive throttle for "${family}": ` +
                    `pausing ${(proactivePause / 1000).toFixed(1)}s ` +
                    `(${bucket.timestamps.length} requests in window)`,
            );
            if (stream) {
                stream.markdown(
                    `\n> ⏳ Rate limit guard: pausing ${(proactivePause / 1000).toFixed(1)}s ` +
                        `to stay under request limits…\n`,
                );
            }
            const ok = await this.sleep(proactivePause, token);
            if (!ok) {
                throw new vscode.CancellationError();
            }
            proactivePauseTotal += proactivePause;
        }

        // === LAYER 2: REQUEST + REACTIVE RETRY LOOP ===
        while (true) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            try {
                // Record this request timestamp
                bucket.timestamps.push(Date.now());

                const response = await model.sendRequest(messages, options, token);

                // Success — reset consecutive hit counter
                bucket.consecutiveHits = 0;

                return {
                    response,
                    proactivePauseMs: proactivePauseTotal,
                    reactivePauseMs: reactivePauseTotal,
                    retryCount,
                };
            } catch (err) {
                const classified = classifyError(err);

                if (classified.category !== 'rate-limit') {
                    // Not a rate limit — re-throw for the caller to handle
                    throw err;
                }

                // Rate limit hit
                retryCount++;
                bucket.consecutiveHits++;

                if (retryCount > this.config.maxRetries) {
                    logger.warn(
                        `[RateLimitGuard] Exhausted ${this.config.maxRetries} retries ` +
                            `for "${family}". Giving up.`,
                    );
                    throw err;
                }

                // Calculate backoff
                const retryAfterMs = this.extractRetryAfter(err);
                const backoff = this.calculateReactiveBackoff(bucket.consecutiveHits, retryAfterMs);

                // Set a global cooldown so other agents sharing this guard also pause
                bucket.cooldownUntil = Date.now() + backoff;

                logger.warn(
                    `[RateLimitGuard] Rate limit hit for "${family}" ` +
                        `(attempt ${retryCount}/${this.config.maxRetries}). ` +
                        `Backing off ${(backoff / 1000).toFixed(1)}s` +
                        (retryAfterMs ? ` (server said ${(retryAfterMs / 1000).toFixed(0)}s)` : ''),
                );

                if (stream) {
                    stream.markdown(
                        `\n> ⏸️ Rate limited — waiting ${(backoff / 1000).toFixed(1)}s ` +
                            `before retry ${retryCount}/${this.config.maxRetries}…\n`,
                    );
                }

                const ok = await this.sleep(backoff, token);
                if (!ok) {
                    throw new vscode.CancellationError();
                }
                reactivePauseTotal += backoff;
            }
        }
    }

    /**
     * Get a diagnostic summary of current rate limit state.
     */
    getDiagnostics(): string {
        const now = Date.now();
        const lines: string[] = ['=== Rate Limit Guard Diagnostics ===', ''];

        if (this.buckets.size === 0) {
            lines.push('No model families tracked yet.');
            return lines.join('\n');
        }

        for (const [family, bucket] of this.buckets) {
            this.pruneWindow(bucket, now);
            const inCooldown = now < bucket.cooldownUntil;
            const cooldownRemaining = inCooldown
                ? ((bucket.cooldownUntil - now) / 1000).toFixed(1) + 's'
                : 'none';

            lines.push(
                `**${family}:** ${bucket.timestamps.length}/${this.config.maxRequestsPerWindow} ` +
                    `requests in window | consecutive hits: ${bucket.consecutiveHits} | ` +
                    `cooldown: ${cooldownRemaining}`,
            );
        }

        return lines.join('\n');
    }

    /**
     * Reset all tracking state.  Useful at session boundaries.
     */
    reset(): void {
        this.buckets.clear();
    }
}
