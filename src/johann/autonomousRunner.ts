import * as vscode from 'vscode';
import {
    ProjectPlan,
    ProjectPhase,
    AutonomousRunState,
    RunLoopConfig,
    PhaseResult,
    ProjectPhaseStatus
} from './types';
import { Orchestrator } from './orchestrator';
import { getLogger } from './logger';
import { atomicWrite } from './safeIO';
import { SessionPersistence } from './sessionPersistence';
import { EventEmitter } from 'events';

const logger = getLogger();

export class AutonomousRunner extends EventEmitter {
    private state: AutonomousRunState;
    private isPaused: boolean = false;
    private orchestrator: Orchestrator;
    private sessionId: string;

    constructor(plan: ProjectPlan, config: RunLoopConfig, sessionId: string) {
        super();
        this.sessionId = sessionId;
        this.orchestrator = new Orchestrator();
        this.state = {
            plan,
            config,
            activePhaseId: undefined,
            activeStreamIds: [],
            history: [],
            startTime: Date.now(),
            lastUpdateTime: Date.now(),
            retryCounts: {}
        };
    }

    async run(userModel: vscode.LanguageModelChat, token: vscode.CancellationToken): Promise<void> {
        logger.info(`AutonomousRunner: Starting project "${this.state.plan.title}" (Session: ${this.sessionId})`);
        this.emit('started', this.state.plan);

        try {
            while (!this.isProjectComplete() && !token.isCancellationRequested) {
                if (this.isPaused) {
                    logger.info('AutonomousRunner: Loop is paused. Waiting for resume.');
                    this.emit('paused');
                    await this.waitForResume();
                    if (token.isCancellationRequested) break;
                }

                const nextPhase = this.getNextExecutablePhase();
                if (!nextPhase) {
                    if (this.hasRunningPhases()) {
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        continue;
                    } else if (this.hasFailedPhases() && this.state.config.pauseOnFailure) {
                        logger.warn('AutonomousRunner: Project stalled due to phase failures.');
                        this.isPaused = true;
                        continue;
                    } else {
                        logger.info('AutonomousRunner: No more executable phases.');
                        break;
                    }
                }

                await this.executePhase(nextPhase, userModel, token);

                if (this.state.config.autoContinue === false) {
                    logger.info('AutonomousRunner: Pausing between phases as per config.');
                    this.isPaused = true;
                }
            }

            if (this.isProjectComplete()) {
                logger.info('AutonomousRunner: Project completed successfully.');
                this.emit('allPhasesComplete', this.state.plan);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`AutonomousRunner: Fatal error in run loop: ${msg}`);
            this.emit('error', err);
        }
    }

    /**
     * Pause the execution between phases.
     */
    pause(): void {
        this.isPaused = true;
        this.logHistory('runner_paused', 'User requested pause');
    }

    /**
     * Resume a paused execution.
     */
    resume(): void {
        this.isPaused = false;
        this.logHistory('runner_resumed', 'User requested resume');
        this.emit('resumed');
    }

    private async executePhase(
        phase: ProjectPhase,
        userModel: vscode.LanguageModelChat,
        token: vscode.CancellationToken
    ): Promise<void> {
        this.state.activePhaseId = phase.id;
        phase.status = 'running';
        phase.startTime = Date.now();
        await this.persistState();

        this.emit('phaseStarted', phase);
        this.logHistory('phase_started', { phaseId: phase.id, title: phase.title });

        try {
            logger.info(`AutonomousRunner: Executing phase ${phase.id}: ${phase.title}`);

            const mockResponse: vscode.ChatResponseStream = {
                markdown: () => mockResponse,
                button: () => mockResponse,
                progress: () => mockResponse,
                reference: () => mockResponse,
                push: () => mockResponse,
                anchor: () => mockResponse,
                fileTree: () => mockResponse,
                codeblock: () => mockResponse,
            } as any;

            const context = `Goal: ${this.state.plan.goal}\n\nPhase Goal: ${phase.description}`;

            await this.orchestrator.orchestrate(
                phase.description,
                context,
                context,
                userModel,
                mockResponse,
                token
            );

            phase.status = 'completed';
            phase.endTime = Date.now();
            phase.result = {
                success: true,
                output: `Phase ${phase.id} completed successfully.`,
                artifacts: []
            };

            this.emit('phaseCompleted', phase);
            this.logHistory('phase_completed', { phaseId: phase.id });

        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`AutonomousRunner: Phase ${phase.id} failed: ${msg}`);

            this.state.retryCounts[phase.id] = (this.state.retryCounts[phase.id] || 0) + 1;

            if (this.state.retryCounts[phase.id] < this.state.config.maxRetriesPerPhase) {
                phase.status = 'pending';
                this.logHistory('phase_retrying', { phaseId: phase.id, attempt: this.state.retryCounts[phase.id] });
            } else {
                phase.status = 'failed';
                phase.result = {
                    success: false,
                    output: `Phase failed after ${this.state.retryCounts[phase.id]} attempts.`,
                    artifacts: [],
                    errors: [msg]
                };
                this.emit('phaseFailed', phase, err);
                this.logHistory('phase_failed', { phaseId: phase.id, error: msg });
            }
        } finally {
            this.state.activePhaseId = undefined;
            await this.persistState();
        }
    }

    private getNextExecutablePhase(): ProjectPhase | undefined {
        return this.state.plan.phases.find(p => {
            if (p.status !== 'pending') return false;

            const dependenciesMet = p.dependsOn.every(depId => {
                const dep = this.state.plan.phases.find(phase => phase.id === depId);
                return dep && dep.status === 'completed';
            });

            return dependenciesMet;
        });
    }

    private isProjectComplete(): boolean {
        return this.state.plan.phases.every(p => p.status === 'completed' || p.status === 'skipped');
    }

    private hasFailedPhases(): boolean {
        return this.state.plan.phases.some(p => p.status === 'failed');
    }

    private hasRunningPhases(): boolean {
        return this.state.plan.phases.some(p => p.status === 'running');
    }

    private logHistory(event: string, details?: any): void {
        this.state.history.push({
            timestamp: Date.now(),
            event,
            details
        });
    }

    private async persistState(): Promise<void> {
        this.state.lastUpdateTime = Date.now();
        const baseDir = SessionPersistence.prototype['getBaseDir']?.call({});
        if (!baseDir) return;

        const statePath = vscode.Uri.joinPath(baseDir, this.sessionId, 'run-loop-state.json');

        try {
            await atomicWrite(statePath, JSON.stringify(this.state, null, 2));
        } catch (err) {
            logger.error(`AutonomousRunner: Failed to persist state: ${err}`);
        }
    }

    private async waitForResume(): Promise<void> {
        return new Promise(resolve => {
            const onResumed = () => {
                this.off('resumed', onResumed);
                resolve();
            };
            this.on('resumed', onResumed);
        });
    }

    static async load(sessionId: string): Promise<AutonomousRunner | null> {
        const baseDir = SessionPersistence.prototype['getBaseDir']?.call({});
        if (!baseDir) return null;

        const statePath = vscode.Uri.joinPath(baseDir, sessionId, 'run-loop-state.json');

        try {
            const bytes = await vscode.workspace.fs.readFile(statePath);
            const data = JSON.parse(new TextDecoder().decode(bytes)) as AutonomousRunState;

            const runner = new AutonomousRunner(data.plan, data.config, sessionId);
            runner.state = data;
            return runner;
        } catch {
            return null;
        }
    }
}
