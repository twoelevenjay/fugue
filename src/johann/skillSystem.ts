/**
 * skillSystem.ts — Top-level facade for the Johann Skill Subsystem
 *
 * Single entry point that the Orchestrator uses. Wires together:
 * - LocalSkillStore + GlobalSkillStore (storage)
 * - SkillValidator (schema + runtime guards)
 * - SkillSelector (deterministic routing + dedupe)
 * - SkillCapEnforcer (anti-explosion caps)
 * - SkillFlattener (global → local-copy)
 * - SkillLedger (JSONL invocation audit log)
 * - SkillPromotionManager (end-of-run promotion UI)
 * - PatternTracker + AutonomousSkillCreator (lifecycle)
 * - SHIPPED_SKILLS (bundled defaults)
 *
 * Lifecycle (called by orchestrator):
 *   1. initialize() → load stores, caps
 *   2. selectSkillForTask() → routing + flattening + ledger
 *   3. recordExecution() → pattern tracking
 *   4. finalize() → promotion UI + stale warnings
 */

import * as vscode from 'vscode';
import {
    SkillDoc,
    SkillSelectionResult,
    SkillSelectionContext,
    SkillPerformanceCaps,
    DEFAULT_SKILL_CAPS,
} from './skillTypes';
import { TaskType } from './types';
import { LocalSkillStore, GlobalSkillStore } from './skillStore';
import { SkillValidator } from './skillValidator';
import { SkillSelector } from './skillSelector';
import { SkillCapEnforcer } from './skillCaps';
import { SkillFlattener } from './skillFlattener';
import { SkillLedger } from './skillLedger';
import { SkillPromotionManager, showStaleSuggestions } from './skillPromotion';
import { PatternTracker, AutonomousSkillCreator } from './skillLifecycle';
import { SHIPPED_SKILLS } from './shippedSkills';
import { getLogger } from './logger';

// ============================================================================
// Skill System Configuration
// ============================================================================

export interface SkillSystemConfig {
    /** VS Code global storage URI (for global skills) */
    globalStorageUri: vscode.Uri;
    /** Session ID for ledger and persistence */
    sessionId: string;
    /** Session directory URI for ledger files */
    sessionDirUri: vscode.Uri;
    /** Performance cap overrides (merged with defaults) */
    caps?: Partial<SkillPerformanceCaps>;
    /** Whether autonomous skill creation is enabled */
    autonomousCreationEnabled?: boolean;
    /** Whether end-of-run promotion UI is enabled */
    promotionEnabled?: boolean;
}

// ============================================================================
// Skill System — The top-level facade
// ============================================================================

export class SkillSystem {
    private localStore: LocalSkillStore;
    private globalStore: GlobalSkillStore;
    private validator: SkillValidator;
    private selector: SkillSelector;
    private caps: SkillCapEnforcer;
    private flattener: SkillFlattener;
    private ledger: SkillLedger;
    private promotionManager: SkillPromotionManager;
    private patternTracker: PatternTracker;
    private autonomousCreator: AutonomousSkillCreator;

    private config: SkillSystemConfig;
    private initialized = false;
    private logger = getLogger();

    /** Cached merged list of all available skills (refreshed on initialize) */
    private allSkills: SkillDoc[] = [];

    constructor(config: SkillSystemConfig) {
        this.config = config;

        const mergedCaps: SkillPerformanceCaps = {
            ...DEFAULT_SKILL_CAPS,
            ...config.caps,
        };

        this.localStore = new LocalSkillStore();
        this.globalStore = new GlobalSkillStore(config.globalStorageUri);
        this.validator = new SkillValidator();
        this.selector = new SkillSelector();
        this.caps = new SkillCapEnforcer(mergedCaps);
        this.flattener = new SkillFlattener();
        this.ledger = new SkillLedger();
        this.promotionManager = new SkillPromotionManager();
        this.patternTracker = new PatternTracker();
        this.autonomousCreator = new AutonomousSkillCreator();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Lifecycle
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Initialize the skill system. Must be called before any other method.
     * Loads all skills from all stores and validates shipped skills.
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        this.caps.resetRunCounters();
        this.patternTracker.reset();

        // Initialize the ledger with the session directory
        await this.ledger.initialize(this.config.sessionDirUri);

        await this.refreshSkillCache();
        this.initialized = true;

        this.logger.info(
            `Skill system initialized: ` +
            `${this.allSkills.length} total skills ` +
            `(${SHIPPED_SKILLS.length} shipped, ` +
            `${(await this.globalStore.listSkills()).length} global, ` +
            `${(await this.localStore.listSkills()).length} local)`
        );
    }

    /**
     * Finalize the skill system at end of run.
     * - Shows promotion UI for eligible local skills
     * - Shows stale skill warnings
     * - Updates unused streaks
     */
    async finalize(): Promise<void> {
        if (!this.initialized) {
            return;
        }

        try {
            // Update unused streaks across local skills
            const localSkills = await this.localStore.listSkills();
            const usedSlugs = this.ledger.getUsedSlugs();
            const updatedSkills = this.caps.updateUnusedStreaks(localSkills, usedSlugs);

            // Persist updated skills
            for (const skill of updatedSkills) {
                await this.localStore.saveSkill(skill);
            }

            // Show promotion UI if enabled
            if (this.config.promotionEnabled !== false) {
                const candidates = await this.promotionManager.identifyCandidates(
                    this.localStore,
                    this.globalStore,
                    this.ledger,
                    usedSlugs,
                );
                if (candidates.length > 0) {
                    await this.promotionManager.promptForAllPromotions(
                        candidates,
                        this.globalStore,
                    );
                }
            }

            // Show stale skill warnings
            const staleReport = this.caps.detectStaleSkills(localSkills);
            if (staleReport.staleSkills.length > 0) {
                await showStaleSuggestions(staleReport.staleSkills);
            }
        } catch (err) {
            this.logger.warn(`Skill system finalization error: ${err}`);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Core Operations
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Select the best skill for a task context.
     * Handles routing, flattening, and ledger logging.
     *
     * @returns Selection result with the chosen skill (or none)
     */
    async selectSkillForTask(context: SkillSelectionContext): Promise<SkillSelectionResult> {
        this.ensureInitialized();

        // Refresh cache in case new skills were created this run
        await this.refreshSkillCache();

        const result = await this.selector.select(context, this.allSkills);

        // Flatten if selected skill is global or shipped (ensure local copy exists)
        if (result.skill && (result.skill.metadata.scope === 'global' || result.skill.metadata.scope === 'shipped')) {
            try {
                const flattened = await this.flattener.flatten(result.skill, this.localStore);
                if (flattened) {
                    result.skill = flattened;
                    result.flattened = true;
                }
            } catch (err) {
                this.logger.warn(`Flattening failed for "${result.skill.metadata.slug}": ${err}`);
            }
        }

        if (result.skill) {
            // Log the invocation (partial — success/files/tools filled later)
            const invocation = this.ledger.createInvocationRecord(
                context.runId,
                result.skill,
                context.description,
                true, // tentatively successful; update later in recordExecution
            );
            await this.ledger.logInvocation(invocation);

            this.logger.info(
                `Skill selected: "${result.skill.metadata.slug}@${result.skill.metadata.version}" ` +
                `(score: ${result.candidates[0]?.score.toFixed(1)}, ${result.logMessage})`
            );
        }

        return result;
    }

    /**
     * Record a task execution for pattern tracking.
     * Called after each subtask completes, regardless of skill usage.
     * This feeds the autonomous skill creation heuristics.
     */
    recordExecution(
        taskType: TaskType,
        description: string,
        filePatterns: string[],
        language?: string,
        framework?: string,
    ): void {
        if (!this.initialized) {
            return;
        }

        this.patternTracker.recordExecution(
            taskType,
            description,
            filePatterns,
            language,
            framework,
        );
    }

    /**
     * Attempt autonomous skill creation from detected patterns.
     * Called periodically during a run (e.g., between waves).
     *
     * @returns Array of newly created skills
     */
    async attemptAutonomousCreation(): Promise<SkillDoc[]> {
        if (!this.initialized) {
            return [];
        }
        if (this.config.autonomousCreationEnabled === false) {
            return [];
        }

        const patterns = this.patternTracker.detectCandidatePatterns();
        if (patterns.length === 0) {
            return [];
        }

        const created: SkillDoc[] = [];

        for (const pattern of patterns) {
            try {
                const skill = await this.autonomousCreator.createFromPattern(
                    pattern,
                    this.allSkills,
                    this.localStore,
                    this.caps,
                    this.validator,
                );

                if (skill) {
                    created.push(skill);
                    this.allSkills.push(skill);
                }
            } catch (err) {
                this.logger.warn(
                    `Autonomous skill creation failed for pattern "${pattern.description}": ${err}`
                );
            }
        }

        if (created.length > 0) {
            this.logger.info(
                `Autonomously created ${created.length} skill(s): ` +
                created.map(s => s.metadata.slug).join(', ')
            );
        }

        return created;
    }

    // ════════════════════════════════════════════════════════════════════════
    // Query Methods
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Get all available skills (all scopes).
     */
    getAllSkills(): readonly SkillDoc[] {
        return this.allSkills;
    }

    /**
     * Get the run summary from the ledger.
     */
    getRunSummary(): { totalInvocations: number; uniqueSlugs: number; usedSlugs: string[] } {
        const invocations = this.ledger.getRunInvocations();
        const usedSlugs = Array.from(this.ledger.getUsedSlugs());
        return {
            totalInvocations: invocations.length,
            uniqueSlugs: usedSlugs.length,
            usedSlugs,
        };
    }

    /**
     * Format all available skills for inclusion in a system prompt.
     */
    formatForPrompt(): string {
        if (this.allSkills.length === 0) {
            return 'No skills available.';
        }

        const lines: string[] = ['## Available Skills\n'];

        // Group by scope
        const byScope = new Map<string, SkillDoc[]>();
        for (const skill of this.allSkills) {
            const scope = skill.metadata.scope;
            if (!byScope.has(scope)) {
                byScope.set(scope, []);
            }
            byScope.get(scope)!.push(skill);
        }

        for (const [scope, skills] of byScope) {
            lines.push(`### ${scope} skills`);
            for (const skill of skills) {
                const types = skill.applies_to.task_types.join(', ');
                const kw = skill.applies_to.keywords.slice(0, 5).join(', ');
                lines.push(
                    `- **${skill.metadata.slug}** v${skill.metadata.version}: ` +
                    `${skill.metadata.description} [types: ${types}] [keywords: ${kw}]`
                );
            }
            lines.push('');
        }

        return lines.join('\n');
    }

    /**
     * Validate a skill document.
     */
    validateSkill(skill: SkillDoc) {
        return this.validator.validate(skill);
    }

    // ════════════════════════════════════════════════════════════════════════
    // Internal
    // ════════════════════════════════════════════════════════════════════════

    private ensureInitialized(): void {
        if (!this.initialized) {
            throw new Error('SkillSystem.initialize() must be called before use');
        }
    }

    /**
     * Refresh the in-memory skill cache from all stores.
     */
    private async refreshSkillCache(): Promise<void> {
        const [local, global] = await Promise.all([
            this.localStore.listSkills(),
            this.globalStore.listSkills(),
        ]);

        // Merge: shipped → global → local (local wins on slug conflicts)
        const bySlug = new Map<string, SkillDoc>();

        // Shipped (lowest priority)
        for (const skill of SHIPPED_SKILLS) {
            bySlug.set(`${skill.metadata.slug}@${skill.metadata.scope}`, skill);
        }

        // Global
        for (const skill of global) {
            bySlug.set(`${skill.metadata.slug}@${skill.metadata.scope}`, skill);
        }

        // Local (highest priority)
        for (const skill of local) {
            bySlug.set(`${skill.metadata.slug}@${skill.metadata.scope}`, skill);
        }

        this.allSkills = Array.from(bySlug.values());
    }
}
