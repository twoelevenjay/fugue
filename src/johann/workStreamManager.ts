import * as vscode from 'vscode';
import * as path from 'path';
import { WorkStream, WorkStreamStatus, OrchestrationPlan, Subtask } from './types';
import { WorktreeManager } from './worktreeManager';
import { getExecutionWaves, Wave } from './graphManager';
import { safeRead, safeWrite } from './safeIO';
import { JohannLogger } from './logger';

/**
 * Coordinates multiple independent feature branches running in parallel.
 * Each work stream operates in its own git worktree.
 */
export class WorkStreamManager {
    private streams = new Map<string, WorkStream>();
    private worktreeManager: WorktreeManager;
    private storagePath: string;
    private logger: JohannLogger;

    constructor(
        workspaceRoot: string,
        sessionId: string,
        storagePath: string,
        logger: JohannLogger
    ) {
        this.worktreeManager = new WorktreeManager(workspaceRoot, sessionId);
        this.storagePath = storagePath;
        this.logger = logger;
    }

    /**
     * Initializes the manager and its underlying worktree manager.
     */
    async initialize(): Promise<void> {
        const ready = await this.worktreeManager.initialize();
        if (!ready) {
            this.logger.error('Failed to initialize WorktreeManager. Git repository may be invalid or not found.');
            return;
        }

        // Try to load persisted state
        await this.loadState();
    }

    /**
     * Creates a new work stream with its own branch and worktree.
     */
    async createWorkStream(config: {
        id: string;
        name: string;
        phases: string[];
        dependencies?: string[];
    }): Promise<WorkStream> {
        this.logger.info(`Creating work stream: ${config.name} (${config.id})`);

        // Create the git worktree
        const worktree = await this.worktreeManager.createWorktree(config.id);

        const stream: WorkStream = {
            id: config.id,
            name: config.name,
            branch: worktree.branch,
            rootPath: worktree.worktreePath,
            status: 'initializing',
            phases: config.phases,
            dependencies: config.dependencies || []
        };

        this.streams.set(stream.id, stream);
        await this.saveState();
        return stream;
    }

    /**
     * Begins execution of a work stream's plan.
     */
    async startWorkStream(id: string): Promise<void> {
        await this.updateStreamStatus(id, 'active');
    }

    /**
     * Gracefully pauses a stream.
     */
    async pauseWorkStream(id: string): Promise<void> {
        const stream = this.streams.get(id);
        if (stream && stream.status === 'active') {
            stream.status = 'initializing';
            await this.saveState();
        }
    }

    /**
     * Returns current status of a work stream.
     */
    getStreamStatus(id: string): WorkStream['status'] | undefined {
        return this.streams.get(id)?.status;
    }

    /**
     * Returns a work stream by ID.
     */
    getWorkStream(id: string): WorkStream | undefined {
        return this.streams.get(id);
    }

    /**
     * Returns all managed work streams.
     */
    getAllStreams(): WorkStream[] {
        return Array.from(this.streams.values());
    }

    /**
     * Updates the status of a work stream.
     */
    async updateStreamStatus(id: string, status: WorkStream['status']): Promise<void> {
        const stream = this.streams.get(id);
        if (stream) {
            stream.status = status;
            await this.saveState();
        }
    }

    /**
     * Calculates the current status distribution across all streams.
     */
    getStreamStatusSummary(): WorkStreamStatus {
        const all = this.getAllStreams();
        return {
            activeStreams: all.filter(s => s.status === 'active').length,
            completedStreams: all.filter(s => s.status === 'completed').length,
            failedStreams: all.filter(s => s.status === 'failed').length,
            pendingStreams: all.filter(s => s.status === 'initializing').length
        };
    }

    /**
     * Resolves work stream dependencies and returns execution waves.
     * Reuses the DAG wave computation logic from graphManager.ts.
     */
    getExecutionWaves(): Wave[] {
        const streamsArray = Array.from(this.streams.values());
        if (streamsArray.length === 0) {
            return [];
        }

        const subtaskShims: Subtask[] = streamsArray.map(stream => ({
            id: stream.id,
            title: stream.name,
            description: '',
            complexity: 'trivial',
            dependsOn: stream.dependencies,
            successCriteria: [],
            status: 'pending',
            attempts: 0,
            maxAttempts: 1
        }));

        const dummyPlan: OrchestrationPlan = {
            summary: 'Execution Wave Calculation',
            subtasks: subtaskShims,
            strategy: 'parallel',
            successCriteria: [],
            overallComplexity: 'trivial'
        };

        return getExecutionWaves(dummyPlan);
    }

    /**
     * Merges a completed work stream back into the main branch and cleans up.
     */
    async completeWorkStream(id: string): Promise<boolean> {
        this.logger.info(`Completing work stream: ${id}`);
        const stream = this.streams.get(id);
        if (!stream) return false;

        stream.status = 'merging';
        await this.saveState();

        const mergeResult = await this.worktreeManager.mergeWorktree(id);
        if (mergeResult.success) {
            stream.status = 'completed';
            await this.worktreeManager.cleanupWorktree(id);
            await this.saveState();
            return true;
        } else {
            this.logger.error(`Merge failed for stream ${id}: ${mergeResult.error}`);
            stream.status = 'failed';
            await this.saveState();
            return false;
        }
    }

    /**
     * Persists the current work stream state to disk.
     */
    private async saveState(): Promise<void> {
        const stateFile = path.join(this.storagePath, 'work-streams.json');
        const data = Array.from(this.streams.values());
        try {
            await safeWrite(vscode.Uri.file(stateFile), JSON.stringify(data, null, 2));
        } catch (err) {
            this.logger.error(`Failed to save work stream state: ${err}`);
        }
    }

    /**
     * Loads persisted work stream state from disk.
     */
    private async loadState(): Promise<void> {
        const stateFile = path.join(this.storagePath, 'work-streams.json');
        try {
            const content = await safeRead(vscode.Uri.file(stateFile));
            if (content) {
                const data = JSON.parse(content) as WorkStream[];
                for (const stream of data) {
                    this.streams.set(stream.id, stream);
                }
            }
        } catch (err) {
            this.logger.info('No persisted work stream state found.');
        }
    }

    /**
     * Clean up all work streams and their worktrees.
     */
    async cleanup(): Promise<void> {
        await this.worktreeManager.cleanupAll();
        this.streams.clear();
        await this.saveState();
    }
}
