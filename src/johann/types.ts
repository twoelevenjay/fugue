import * as vscode from 'vscode';

// ============================================================================
// CORE TYPES — Johann Orchestration System
// ============================================================================

/**
 * Represents how complex/difficult a subtask is.
 * The orchestrator uses this to select the right model tier.
 */
export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';

/**
 * Status of a subtask as it moves through the orchestration pipeline.
 */
export type SubtaskStatus =
    | 'pending'
    | 'in-progress'
    | 'reviewing'
    | 'completed'
    | 'failed'
    | 'escalated';

/**
 * The orchestration plan produced by the task decomposer.
 * Contains the full breakdown, dependencies, and execution strategy.
 */
export interface OrchestrationPlan {
    /** A concise summary of the overall goal */
    summary: string;
    /** The subtasks to execute */
    subtasks: Subtask[];
    /** Execution strategy: serial, parallel, or mixed */
    strategy: 'serial' | 'parallel' | 'mixed';
    /** Success criteria for the overall plan */
    successCriteria: string[];
    /** Estimated total complexity */
    overallComplexity: TaskComplexity;
}

/**
 * A single subtask within an orchestration plan.
 * Each subtask maps to one subagent invocation.
 */
export interface Subtask {
    /** Unique id within the plan */
    id: string;
    /** Human-readable title */
    title: string;
    /** Full description / prompt for the subagent */
    description: string;
    /** Complexity rating — drives model selection */
    complexity: TaskComplexity;
    /** IDs of subtasks this depends on (must complete first) */
    dependsOn: string[];
    /** Success criteria specific to this subtask */
    successCriteria: string[];
    /** Current status */
    status: SubtaskStatus;
    /** Which model was assigned */
    assignedModel?: string;
    /** The result produced by the subagent (if completed) */
    result?: SubtaskResult;
    /** Number of attempts so far */
    attempts: number;
    /** Maximum attempts before giving up */
    maxAttempts: number;
}

/**
 * The result of executing a single subtask.
 */
export interface SubtaskResult {
    /** Whether the subtask met its success criteria */
    success: boolean;
    /** The model that produced this result */
    modelUsed: string;
    /** The output produced */
    output: string;
    /** Review notes from the orchestrator */
    reviewNotes: string;
    /** Duration in ms */
    durationMs: number;
    /** Timestamp */
    timestamp: string;
}

/**
 * A model descriptor — what's available in VS Code.
 */
export interface ModelInfo {
    /** The vscode LanguageModelChat instance */
    model: vscode.LanguageModelChat;
    /** Vendor (e.g., 'copilot') */
    vendor: string;
    /** Family (e.g., 'gpt-4o', 'claude-3.5-sonnet') */
    family: string;
    /** Full identifier */
    id: string;
    /** Display name */
    name: string;
    /** Estimated capability tier (1=basic, 5=frontier) */
    tier: number;
    /** Max input tokens (if known) */
    maxInputTokens?: number;
}

/**
 * Model escalation record — tracks which models have been tried for a subtask.
 */
export interface EscalationRecord {
    subtaskId: string;
    /** Models tried in order, with their results */
    attempts: Array<{
        modelId: string;
        tier: number;
        success: boolean;
        reason: string;
    }>;
}

/**
 * A memory entry stored in the .vscode/johann/ directory.
 */
export interface MemoryEntry {
    /** ISO timestamp */
    timestamp: string;
    /** Category of the memory */
    category: 'task' | 'decision' | 'learning' | 'context' | 'error';
    /** Short title */
    title: string;
    /** Full content */
    content: string;
    /** Tags for retrieval */
    tags: string[];
    /** Related subtask IDs (if applicable) */
    relatedSubtasks?: string[];
}

/**
 * Full session state for Johann.
 */
export interface JohannSession {
    /** Unique session id */
    sessionId: string;
    /** The original user request */
    originalRequest: string;
    /** The orchestration plan */
    plan: OrchestrationPlan | null;
    /** Current overall status */
    status: 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed';
    /** Escalation records */
    escalations: EscalationRecord[];
    /** When the session started */
    startedAt: string;
    /** When the session finished */
    completedAt?: string;
    /** Workspace context snapshot */
    workspaceContext: string;
}

/**
 * Configuration for the orchestrator.
 */
export interface OrchestratorConfig {
    /** Maximum number of subtasks per plan */
    maxSubtasks: number;
    /** Maximum attempts per subtask before failure */
    maxAttemptsPerSubtask: number;
    /** Whether to run independent subtasks in parallel */
    allowParallelExecution: boolean;
    /** Memory directory relative to workspace root */
    memoryDir: string;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
    maxSubtasks: 10,
    maxAttemptsPerSubtask: 3,
    allowParallelExecution: true,
    memoryDir: '.vscode/johann',
};
