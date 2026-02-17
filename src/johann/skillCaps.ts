/**
 * skillCaps.ts — Performance cap enforcement layer
 *
 * Prevents skill explosion with hard limits:
 * - Max local skills total: 50
 * - Max new skills per run: 5
 * - Max versions per skill: 10
 * - Min time between versions: 10 minutes
 * - Consolidation suggestions at 40+ skills
 * - Stale detection after 5 unused runs
 */

import { SkillDoc, SkillPerformanceCaps, DEFAULT_SKILL_CAPS } from './skillTypes';
import { LocalSkillStore } from './skillStore';
import { getLogger } from './logger';

// ============================================================================
// Cap Check Result
// ============================================================================

export interface CapCheckResult {
    /** Whether the operation is allowed */
    allowed: boolean;
    /** Reason if denied */
    reason?: string;
    /** Suggestion for the user/agent */
    suggestion?: string;
    /** Current counts for diagnostics */
    diagnostics: {
        totalLocalSkills: number;
        newSkillsThisRun: number;
        versionsForSlug: number;
    };
}

// ============================================================================
// Stale Skill Detection
// ============================================================================

export interface StaleSkillReport {
    /** Skills that haven't been used in N+ runs */
    staleSkills: SkillDoc[];
    /** Skills to suggest deprecation for */
    deprecationCandidates: SkillDoc[];
}

// ============================================================================
// Cap Enforcer
// ============================================================================

export class SkillCapEnforcer {
    private caps: SkillPerformanceCaps;
    private newSkillsThisRun = 0;
    private lastVersionTimes = new Map<string, number>(); // slug → epoch ms
    private logger = getLogger();

    constructor(caps: SkillPerformanceCaps = DEFAULT_SKILL_CAPS) {
        this.caps = caps;
    }

    /**
     * Reset per-run counters. Call at the start of each orchestration run.
     */
    resetRunCounters(): void {
        this.newSkillsThisRun = 0;
        this.lastVersionTimes.clear();
    }

    /**
     * Check whether a new skill can be created.
     */
    async canCreateSkill(slug: string, store: LocalSkillStore): Promise<CapCheckResult> {
        const totalSkills = await store.countSkills();
        const versionsForSlug = await store.countVersions(slug);

        const diagnostics = {
            totalLocalSkills: totalSkills,
            newSkillsThisRun: this.newSkillsThisRun,
            versionsForSlug,
        };

        // ── Hard limit: max local skills ───────────────────────────────────
        if (totalSkills >= this.caps.maxLocalSkills) {
            return {
                allowed: false,
                reason: `Local skill limit reached (${totalSkills}/${this.caps.maxLocalSkills})`,
                suggestion:
                    'Consider consolidating or deprecating unused skills before creating new ones.',
                diagnostics,
            };
        }

        // ── Hard limit: max new skills per run ─────────────────────────────
        if (this.newSkillsThisRun >= this.caps.maxNewSkillsPerRun) {
            return {
                allowed: false,
                reason: `New skill limit for this run reached (${this.newSkillsThisRun}/${this.caps.maxNewSkillsPerRun})`,
                suggestion: 'Wait for the next run to create more skills.',
                diagnostics,
            };
        }

        // ── Hard limit: max versions per slug ──────────────────────────────
        if (versionsForSlug >= this.caps.maxVersionsPerSkill) {
            return {
                allowed: false,
                reason: `Version limit for "${slug}" reached (${versionsForSlug}/${this.caps.maxVersionsPerSkill})`,
                suggestion: 'Consider a major version bump or consolidating versions.',
                diagnostics,
            };
        }

        // ── Rate limit: min time between versions ──────────────────────────
        const lastTime = this.lastVersionTimes.get(slug);
        if (lastTime) {
            const elapsed = Date.now() - lastTime;
            if (elapsed < this.caps.minTimeBetweenVersionsMs) {
                const remainingMs = this.caps.minTimeBetweenVersionsMs - elapsed;
                const remainingMin = Math.ceil(remainingMs / 60000);
                return {
                    allowed: false,
                    reason: `Too soon to create another version of "${slug}" (wait ${remainingMin} min)`,
                    diagnostics,
                };
            }
        }

        // ── Soft warning: consolidation threshold ──────────────────────────
        let suggestion: string | undefined;
        if (totalSkills >= this.caps.consolidationThreshold) {
            suggestion =
                `You have ${totalSkills} local skills (threshold: ${this.caps.consolidationThreshold}). ` +
                'Consider consolidating related skills before creating new ones.';
        }

        return {
            allowed: true,
            suggestion,
            diagnostics,
        };
    }

    /**
     * Record that a new skill was created in this run.
     */
    recordSkillCreated(slug: string): void {
        this.newSkillsThisRun++;
        this.lastVersionTimes.set(slug, Date.now());
        this.logger.info(
            `Skill created: ${slug} (${this.newSkillsThisRun}/${this.caps.maxNewSkillsPerRun} this run)`,
        );
    }

    /**
     * Detect stale skills that haven't been used in N+ runs.
     */
    detectStaleSkills(skills: SkillDoc[]): StaleSkillReport {
        const staleSkills: SkillDoc[] = [];
        const deprecationCandidates: SkillDoc[] = [];

        for (const skill of skills) {
            // Skip shipped skills — they're always available
            if (skill.metadata.scope === 'shipped') {
                continue;
            }

            if (skill.history.unused_run_streak >= this.caps.staleAfterUnusedRuns) {
                staleSkills.push(skill);

                // Deprecation candidate if also low total uses
                if (skill.history.total_uses <= 2) {
                    deprecationCandidates.push(skill);
                }
            }
        }

        return { staleSkills, deprecationCandidates };
    }

    /**
     * Update unused_run_streak for all skills at end of run.
     * Skills used this run get their streak reset to 0.
     * Skills NOT used get their streak incremented.
     *
     * @param allSkills  All local skills
     * @param usedSlugs  Set of skill slugs used in the current run
     * @returns Skills that were updated (caller should persist them)
     */
    updateUnusedStreaks(allSkills: SkillDoc[], usedSlugs: Set<string>): SkillDoc[] {
        const updated: SkillDoc[] = [];

        for (const skill of allSkills) {
            if (usedSlugs.has(skill.metadata.slug)) {
                if (skill.history.unused_run_streak !== 0) {
                    skill.history.unused_run_streak = 0;
                    updated.push(skill);
                }
            } else {
                skill.history.unused_run_streak++;
                updated.push(skill);
            }
        }

        return updated;
    }

    /**
     * Get current caps for diagnostics.
     */
    getCaps(): Readonly<SkillPerformanceCaps> {
        return this.caps;
    }

    /**
     * Get current run stats.
     */
    getRunStats(): { newSkillsThisRun: number; maxPerRun: number } {
        return {
            newSkillsThisRun: this.newSkillsThisRun,
            maxPerRun: this.caps.maxNewSkillsPerRun,
        };
    }
}
