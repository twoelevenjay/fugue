/**
 * hooks.ts — Typed Lifecycle Hook System
 *
 * Inspired by OpenClaw's hook-based lifecycle and Gas Town's activity system.
 * Provides a typed event system for the orchestration pipeline so that
 * cross-cutting concerns (logging, memory flush, metrics) can be added
 * without modifying core orchestration code.
 *
 * Key capabilities:
 * - Typed hook names covering the full orchestration lifecycle
 * - Priority-ordered handler execution
 * - Pre-compaction memory flush (on_context_limit)
 * - Error isolation (one handler failure doesn't break others)
 */

import { OrchestrationPlan, Subtask, SubtaskResult, JohannSession } from './types';
import { getLogger } from './logger';

// ============================================================================
// Types
// ============================================================================

/**
 * All lifecycle hook names in the orchestration pipeline.
 */
export type HookName =
    | 'on_session_start'
    | 'before_planning'
    | 'after_planning'
    | 'before_subtask'
    | 'after_subtask'
    | 'before_merge'
    | 'after_merge'
    | 'before_memory_write'
    | 'on_error'
    | 'on_context_limit'
    | 'on_session_end';

/**
 * Context passed to hook handlers. Fields are populated based on
 * which lifecycle point is firing — not all fields are set for every hook.
 */
export interface HookContext {
    /** The user's original request */
    request?: string;
    /** Current session state */
    session?: JohannSession;
    /** Current or completed orchestration plan */
    plan?: OrchestrationPlan;
    /** The subtask being executed (before_subtask, after_subtask) */
    subtask?: Subtask;
    /** The result of the subtask (after_subtask) */
    subtaskResult?: SubtaskResult;
    /** Error that triggered the hook (on_error) */
    error?: Error;
    /** Estimated token count (on_context_limit) */
    estimatedTokens?: number;
    /** Model context window size (on_context_limit) */
    contextLimit?: number;
    /** Current tool round number (on_context_limit) */
    round?: number;
    /** Subtask ID (on_context_limit) */
    subtaskId?: string;
    /** Arbitrary metadata — extensible without changing the interface */
    metadata?: Record<string, unknown>;
}

/**
 * A registered hook handler.
 */
export interface HookHandler {
    /** Human-readable name for debugging */
    name: string;
    /** Priority — higher values run first (default: 0) */
    priority: number;
    /** The handler function — receives context, must not throw */
    handler: (context: HookContext) => Promise<void>;
}

// ============================================================================
// HookRunner
// ============================================================================

/**
 * Central hook registry and runner.
 *
 * Usage:
 * ```ts
 * const hooks = new HookRunner();
 * hooks.register('before_subtask', {
 *     name: 'log-subtask',
 *     priority: 10,
 *     handler: async (ctx) => console.log(`Starting: ${ctx.subtask?.title}`),
 * });
 * await hooks.run('before_subtask', { subtask });
 * ```
 */
export class HookRunner {
    private handlers = new Map<HookName, HookHandler[]>();
    private logger = getLogger();

    /**
     * Register a handler for a lifecycle hook.
     */
    register(hook: HookName, handler: HookHandler): void {
        if (!this.handlers.has(hook)) {
            this.handlers.set(hook, []);
        }
        this.handlers.get(hook)!.push(handler);
        // Sort by priority descending (higher = runs first)
        this.handlers.get(hook)!.sort((a, b) => b.priority - a.priority);
    }

    /**
     * Unregister a handler by name.
     */
    unregister(hook: HookName, handlerName: string): void {
        const list = this.handlers.get(hook);
        if (!list) return;
        const idx = list.findIndex(h => h.name === handlerName);
        if (idx >= 0) {
            list.splice(idx, 1);
        }
    }

    /**
     * Run all handlers for a hook in priority order.
     * Errors in individual handlers are caught and logged — they do NOT
     * propagate to the caller or prevent other handlers from running.
     */
    async run(hook: HookName, context: HookContext): Promise<void> {
        const list = this.handlers.get(hook);
        if (!list || list.length === 0) {
            return;
        }

        for (const entry of list) {
            try {
                await entry.handler(context);
            } catch (err) {
                this.logger.error(
                    `Hook "${hook}" handler "${entry.name}" failed: ${err instanceof Error ? err.message : String(err)}`
                );
                // Continue — one handler failure doesn't break others
            }
        }
    }

    /**
     * Check if any handlers are registered for a hook.
     */
    hasHandlers(hook: HookName): boolean {
        return (this.handlers.get(hook)?.length ?? 0) > 0;
    }

    /**
     * Get all registered handler names for a hook (debugging).
     */
    getHandlerNames(hook: HookName): string[] {
        return (this.handlers.get(hook) ?? []).map(h => h.name);
    }

    /**
     * Clear all handlers (for testing).
     */
    clear(): void {
        this.handlers.clear();
    }
}

// ============================================================================
// Default Hooks
// ============================================================================

/**
 * Create a HookRunner pre-configured with default handlers.
 *
 * Currently registers:
 * - on_context_limit: memory flush warning (the actual flush is wired
 *   in the orchestrator since it needs access to the memory system)
 * - on_error: error logging
 */
export function createDefaultHookRunner(): HookRunner {
    const runner = new HookRunner();

    // Log errors
    runner.register('on_error', {
        name: 'error-logger',
        priority: 0,
        handler: async (ctx) => {
            const logger = getLogger();
            logger.error(
                `Orchestration error: ${ctx.error?.message ?? 'unknown'}` +
                (ctx.subtask ? ` (subtask: ${ctx.subtask.title})` : '')
            );
        },
    });

    // Warn when approaching context limit
    runner.register('on_context_limit', {
        name: 'context-limit-warning',
        priority: 0,
        handler: async (ctx) => {
            const logger = getLogger();
            const pct = ctx.estimatedTokens && ctx.contextLimit
                ? ((ctx.estimatedTokens / ctx.contextLimit) * 100).toFixed(0)
                : '?';
            logger.info(
                `Context limit approaching (${pct}%) for subtask ${ctx.subtaskId ?? '?'} at round ${ctx.round ?? '?'}`
            );
        },
    });

    return runner;
}
