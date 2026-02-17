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
 * Task type classification for model selection.
 * Enables deterministic routing to free (0×) vs premium models.
 */
export type TaskType =
    | 'generate' // Code generation, scaffolding, boilerplate
    | 'refactor' // Code transformations, renames, moves
    | 'test' // Test generation and writing
    | 'debug' // Debugging, fixing failures, error analysis
    | 'review' // Code review, security, edge cases
    | 'spec' // Planning, documentation, communication
    | 'edit' // Small edits, formatting, single functions
    | 'design' // Architecture decisions, multi-file design
    | 'complex-refactor'; // Large-scale refactors requiring deep reasoning

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
    /** Task type for routing and multi-pass strategy selection */
    taskType?: TaskType;
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
    /** Worktree path for filesystem isolation during parallel execution */
    worktreePath?: string;
    /** Whether to use multi-pass execution for this subtask */
    useMultiPass?: boolean;
    /** Skill hint for routing — auto-inferred or manually set */
    skillHint?: string;
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
    /** Cost multiplier (0 = free, 1 = standard premium, 3 = opus, etc.) */
    costMultiplier: number;
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
        /** Preserved output from successful executions (even if review rejected) */
        output?: string;
        /** Duration of this attempt */
        durationMs?: number;
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
    /** Whether to use git worktrees for parallel subtask isolation */
    useWorktrees: boolean;
    /** Memory directory relative to workspace root */
    memoryDir: string;
    /** VS Code global storage URI (for global skill store) */
    globalStorageUri?: import('vscode').Uri;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
    maxSubtasks: 20,
    maxAttemptsPerSubtask: 5,
    allowParallelExecution: true,
    useWorktrees: true,
    memoryDir: '.vscode/johann',
};

// ============================================================================
// BACKGROUND TASK MANAGEMENT
// ============================================================================

/**
 * Status of a background task.
 */
export type BackgroundTaskStatus =
    | 'running' // Currently executing
    | 'paused' // Paused (e.g., waiting for user input)
    | 'completed' // Successfully finished
    | 'failed' // Failed with error
    | 'cancelled'; // User cancelled

/**
 * Progress information for a background task.
 */
export interface BackgroundTaskProgress {
    /** Current execution phase */
    phase: 'planning' | 'executing' | 'reviewing' | 'merging' | 'finalizing';
    /** Number of completed subtasks */
    completedSubtasks: number;
    /** Total number of subtasks */
    totalSubtasks: number;
    /** Currently executing subtask (if any) */
    currentSubtask?: string;
    /** Progress percentage (0-100) */
    percentage: number;
}

/**
 * A background orchestration task.
 * Runs asynchronously while user continues working.
 */
export interface BackgroundTask {
    /** Unique task identifier */
    id: string;
    /** Associated session ID */
    sessionId: string;
    /** Task type (currently only orchestration) */
    type: 'orchestration';
    /** Current status */
    status: BackgroundTaskStatus;
    /** When the task started */
    startedAt: string;
    /** When the task finished (if completed/failed/cancelled) */
    completedAt?: string;
    /** Progress information */
    progress: BackgroundTaskProgress;
    /** Cancellation token source for stopping the task */
    cancellationToken: vscode.CancellationTokenSource;
    /** Original user request */
    request: string;
    /** Summary of the request for display */
    summary: string;
    /** Error message (if failed) */
    error?: string;
}

// ============================================================================
// AUTONOMOUS EXECUTION TYPES
// ============================================================================

/**
 * Status of a project phase during autonomous execution.
 */
export type ProjectPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'skipped';

/**
 * A single phase within a multi-phase ProjectPlan.
 */
export interface ProjectPhase {
    /** Unique id within the project */
    readonly id: string;
    /** Human-readable title */
    readonly title: string;
    /** Full description of what this phase should achieve */
    readonly description: string;
    /** The orchestration plan (may be generated just-in-time if missing) */
    orchestrationPlan?: OrchestrationPlan;
    /** IDs of phases this depends on */
    readonly dependsOn: string[];
    /** Current status */
    status: ProjectPhaseStatus;
    /** Result of the phase (if completed) */
    result?: PhaseResult;
    /** Start timestamp */
    startTime?: number;
    /** End timestamp */
    endTime?: number;
}

/**
 * The result of executing a project phase.
 */
export interface PhaseResult {
    /** Whether the phase met its success criteria */
    success: boolean;
    /** Summary of output/artifacts */
    output: string;
    /** Paths to created/modified files */
    artifacts: string[];
    /** Error messages encountered */
    errors?: string[];
}

/**
 * A high-level plan for a multi-phase autonomous project.
 */
export interface ProjectPlan {
    /** Unique project identifier */
    readonly id: string;
    /** Human-readable title */
    readonly title: string;
    /** The high-level goal of the project */
    readonly goal: string;
    /** Ordered or dependency-linked phases */
    phases: ProjectPhase[];
    /** Project metadata */
    metadata: {
        createdAt: number;
        model: string;
        totalEstimatedDuration?: number;
    };
}

/**
 * Configuration for the autonomous run loop.
 */
export interface RunLoopConfig {
    /** Maximum parallel work streams */
    readonly maxParallelStreams: number;
    /** Whether to automatically proceed to next phase on success */
    readonly autoContinue: boolean;
    /** Whether to pause the entire loop on any phase failure */
    readonly pauseOnFailure: boolean;
    /** Path to the progress dashboard file */
    readonly dashboardPath: string;
    /** Max retries per phase before giving up or pausing */
    readonly maxRetriesPerPhase: number;
    /** Requirement for human review based on task complexity */
    readonly requireReviewForComplexity: TaskComplexity[];
    /** Heartbeat interval in milliseconds */
    readonly heartbeatIntervalMs: number;
}

/**
 * Current state of the autonomous execution.
 */
export interface AutonomousRunState {
    /** The plan being executed */
    plan: ProjectPlan;
    /** Active configuration */
    config: RunLoopConfig;
    /** ID of the phase currently being executed */
    activePhaseId?: string;
    /** IDs of streams currently executing in parallel */
    activeStreamIds: string[];
    /** Execution history log */
    history: Array<{
        timestamp: number;
        event: string;
        details?: any;
    }>;
    /** Start timestamp of the run */
    startTime: number;
    /** Last time the state was saved */
    lastUpdateTime: number;
    /** Retry counts per phase */
    retryCounts: Record<string, number>;
}

/**
 * Represents an independent feature branch work unit.
 */
export interface WorkStream {
    /** Unique stream identifier */
    readonly id: string;
    /** User-friendly name */
    readonly name: string;
    /** Associated git branch */
    readonly branch: string;
    /** Root directory for this stream (often a worktree) */
    readonly rootPath: string;
    /** Current work stream status */
    status: 'initializing' | 'active' | 'merging' | 'completed' | 'failed' | 'aborting';
    /** IDs of phases assigned to this stream */
    phases: string[];
    /** Stream dependencies (IDs of other streams) */
    dependencies: string[];
}

/**
 * Dependency graph of work streams.
 */
export interface WorkStreamGraph {
    /** Map of stream IDs to work stream metadata */
    streams: Map<string, WorkStream>;
    /** Current concurrency limit */
    concurrencyLimit: number;
}

/**
 * Runtime status summary of all work streams.
 */
export interface WorkStreamStatus {
    activeStreams: number;
    completedStreams: number;
    failedStreams: number;
    pendingStreams: number;
}

/**
 * Result of a background health check.
 */
export interface HealthCheck {
    /** Timestamp of the check */
    timestamp: number;
    /** Status indicator */
    status: 'healthy' | 'degraded' | 'critical';
    /** List of issues found */
    issues: string[];
}

/**
 * Configuration for the self-monitoring system.
 */
export interface MonitorConfig {
    /** Milliseconds of inactivity before a task is considered stalled */
    stallThresholdMs: number;
    /** Maximum disk usage in GB before warning */
    maxDiskUsageGb: number;
    /** Maximum allowed concurrent subtasks across all streams */
    maxConcurrentSubtasks: number;
}

/**
 * Record of a detected stall in execution.
 */
export interface StallDetection {
    /** ID of the stalled task */
    taskId: string;
    /** ID of the work stream */
    streamId: string;
    /** Timestamp of last known activity */
    lastActivity: number;
    /** Action taken to resolve the stall */
    actionTaken: 'none' | 'ping' | 'escalate' | 'restart';
}
