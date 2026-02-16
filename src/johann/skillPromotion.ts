/**
 * skillPromotion.ts — End-of-run promotion UI
 *
 * After a run completes, shows newly created local skills and offers
 * promotion to global store via VS Code information messages with buttons.
 *
 * Promotion rules:
 * - Copy to global store (don't delete local)
 * - Update scope metadata to "global", origin to "promoted"
 * - Published version is immutable
 * - Skill must have been used at least twice in same run OR used across two runs
 */

import * as vscode from 'vscode';
import {
    SkillDoc,
    PromotionCandidate,
} from './skillTypes';
import { LocalSkillStore, GlobalSkillStore } from './skillStore';
import { SkillValidator } from './skillValidator';
import { SkillLedger } from './skillLedger';
import { getLogger } from './logger';

// ============================================================================
// Promotion Manager
// ============================================================================

export class SkillPromotionManager {
    private logger = getLogger();
    private validator = new SkillValidator();

    /**
     * Identify skills eligible for promotion at end-of-run.
     *
     * Eligibility criteria:
     * - Scope is "local" (not already global, shipped, or a local-copy)
     * - Origin is "autonomous" (created by Johann this run or a previous run)
     * - Used at least twice in same run OR used across two separate runs
     */
    async identifyCandidates(
        localStore: LocalSkillStore,
        globalStore: GlobalSkillStore,
        ledger: SkillLedger,
        newSkillSlugs: Set<string>,
    ): Promise<PromotionCandidate[]> {
        const candidates: PromotionCandidate[] = [];
        const allLocalSkills = await localStore.listSkills();

        for (const skill of allLocalSkills) {
            // Only promote local, autonomous skills
            if (skill.metadata.scope !== 'local') {
                continue;
            }
            if (skill.metadata.origin !== 'autonomous' && skill.metadata.origin !== 'user') {
                continue;
            }

            const usageThisRun = ledger.getUsageCount(skill.metadata.slug);

            // Must demonstrate value: used >= 2 times this run OR across 2+ runs
            const qualifies = usageThisRun >= 2 || skill.history.runs_used_in >= 2;
            if (!qualifies) {
                continue;
            }

            // Check if a global version already exists
            const globalExisting = await globalStore.loadLatestSkill(skill.metadata.slug);
            const hasPreviousGlobalVersion = globalExisting !== undefined;

            let diffSummary: string | undefined;
            if (hasPreviousGlobalVersion && globalExisting) {
                diffSummary = this.computeDiffSummary(globalExisting, skill);
            }

            candidates.push({
                skill,
                usageCountThisRun: usageThisRun,
                hasPreviousGlobalVersion,
                diffSummary,
            });
        }

        return candidates;
    }

    /**
     * Show promotion UI for a single candidate.
     * Returns true if the user accepted promotion.
     */
    async promptForPromotion(
        candidate: PromotionCandidate,
        globalStore: GlobalSkillStore,
    ): Promise<boolean> {
        const skill = candidate.skill;
        const detail = [
            `**${skill.metadata.title}** (${skill.metadata.slug}@${skill.metadata.version})`,
            ``,
            `${skill.metadata.description}`,
            ``,
            `Used ${candidate.usageCountThisRun} time(s) this run, ${skill.history.total_uses} total.`,
            candidate.hasPreviousGlobalVersion
                ? `⚠ A previous global version exists.`
                : `This will be the first global version.`,
            candidate.diffSummary ? `\nChanges: ${candidate.diffSummary}` : '',
        ].join('\n');

        const action = await vscode.window.showInformationMessage(
            `Promote skill "${skill.metadata.title}" to global store?`,
            { modal: false, detail },
            'Promote to Global',
            'Dismiss'
        );

        if (action === 'Promote to Global') {
            await this.promoteSkill(skill, globalStore);
            return true;
        }

        return false;
    }

    /**
     * Show promotion UI for all candidates (batched).
     */
    async promptForAllPromotions(
        candidates: PromotionCandidate[],
        globalStore: GlobalSkillStore,
    ): Promise<number> {
        if (candidates.length === 0) {
            return 0;
        }

        let promoted = 0;

        for (const candidate of candidates) {
            const accepted = await this.promptForPromotion(candidate, globalStore);
            if (accepted) {
                promoted++;
            }
        }

        if (promoted > 0) {
            this.logger.info(`Promoted ${promoted}/${candidates.length} skill(s) to global store`);
        }

        return promoted;
    }

    /**
     * Promote a skill to the global store.
     * - Copies to global store
     * - Does NOT delete local copy
     * - Updates scope to "global", origin to "promoted"
     * - Sets content hash for immutability
     */
    async promoteSkill(
        skill: SkillDoc,
        globalStore: GlobalSkillStore,
    ): Promise<SkillDoc> {
        // Create the global copy
        const globalSkill: SkillDoc = {
            ...structuredClone(skill),
            metadata: {
                ...structuredClone(skill.metadata),
                scope: 'global',
                origin: 'promoted',
                content_hash: this.validator.computeHash(skill),
            },
        };

        await globalStore.saveSkill(globalSkill);

        this.logger.info(
            `Promoted skill "${skill.metadata.slug}@${skill.metadata.version}" to global store`
        );

        vscode.window.showInformationMessage(
            `Skill "${skill.metadata.title}" promoted to global store.`
        );

        return globalSkill;
    }

    /**
     * Compute a simple diff summary between two skill versions.
     */
    private computeDiffSummary(oldSkill: SkillDoc, newSkill: SkillDoc): string {
        const changes: string[] = [];

        if (oldSkill.metadata.version !== newSkill.metadata.version) {
            changes.push(`version ${oldSkill.metadata.version} → ${newSkill.metadata.version}`);
        }

        if (oldSkill.instruction.body !== newSkill.instruction.body) {
            const oldLen = oldSkill.instruction.body.length;
            const newLen = newSkill.instruction.body.length;
            const delta = newLen - oldLen;
            changes.push(`instruction body ${delta > 0 ? '+' : ''}${delta} chars`);
        }

        const oldStepCount = oldSkill.instruction.steps?.length ?? 0;
        const newStepCount = newSkill.instruction.steps?.length ?? 0;
        if (oldStepCount !== newStepCount) {
            changes.push(`steps ${oldStepCount} → ${newStepCount}`);
        }

        const oldKeywords = oldSkill.applies_to.keywords.length;
        const newKeywords = newSkill.applies_to.keywords.length;
        if (oldKeywords !== newKeywords) {
            changes.push(`keywords ${oldKeywords} → ${newKeywords}`);
        }

        return changes.length > 0 ? changes.join(', ') : 'Minimal changes';
    }
}

/**
 * Show end-of-run stale skill suggestions.
 * Called alongside promotion UI.
 */
export async function showStaleSuggestions(
    staleSkills: SkillDoc[],
): Promise<void> {
    if (staleSkills.length === 0) {
        return;
    }

    const slugList = staleSkills.map(s => s.metadata.slug).join(', ');
    const action = await vscode.window.showWarningMessage(
        `${staleSkills.length} skill(s) haven't been used in 5+ runs: ${slugList}`,
        'Review',
        'Dismiss'
    );

    if (action === 'Review') {
        // Open a quick pick to let the user see/delete stale skills
        const items = staleSkills.map(s => ({
            label: `${s.metadata.slug}@${s.metadata.version}`,
            description: s.metadata.description,
            detail: `Last used: ${s.metadata.last_used_at || 'never'} | Total uses: ${s.history.total_uses} | Unused streak: ${s.history.unused_run_streak} runs`,
        }));

        await vscode.window.showQuickPick(items, {
            title: 'Stale Skills',
            placeHolder: 'Review stale skills (close to dismiss)',
            canPickMany: false,
        });
    }
}
