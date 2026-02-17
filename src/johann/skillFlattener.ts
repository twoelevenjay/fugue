/**
 * skillFlattener.ts — Flattening logic (global/shipped → local copy)
 *
 * CRITICAL RULE: If a project uses ANY skill (local OR global OR shipped),
 * that skill MUST exist in `.vscode/johann/skills/`.
 *
 * If a global/shipped skill is selected and not present locally:
 * - Clone it into local store
 * - Mark scope as "local-copy"
 * - Preserve version and content hash
 * - Record source_version and source_hash for provenance
 *
 * This ensures:
 * - Every project carries its skill dependencies
 * - Full reproducibility
 * - No hidden global dependency at runtime
 */

import { SkillDoc } from './skillTypes';
import { LocalSkillStore, GlobalSkillStore } from './skillStore';
import { SkillValidator } from './skillValidator';
import { getLogger } from './logger';

// ============================================================================
// Flattener
// ============================================================================

export class SkillFlattener {
    private logger = getLogger();
    private validator = new SkillValidator();

    /**
     * Ensure a skill exists in the local store.
     * If it's already local, this is a no-op.
     * If it's global/shipped, copy it to local with scope "local-copy".
     *
     * @param skill  The skill to flatten
     * @param localStore  The local skill store
     * @returns The local copy of the skill (may be the original if already local)
     */
    async flatten(skill: SkillDoc, localStore: LocalSkillStore): Promise<SkillDoc> {
        // Already local — nothing to do
        if (skill.metadata.scope === 'local' || skill.metadata.scope === 'local-copy') {
            // Verify it exists on disk
            const exists = await localStore.exists(skill.metadata.slug, skill.metadata.version);
            if (exists) {
                return skill;
            }
            // If somehow not on disk, save it
            this.logger.warn(
                `Local skill "${skill.metadata.slug}@${skill.metadata.version}" not on disk — re-saving`,
            );
            await localStore.saveSkill(skill);
            return skill;
        }

        // Check if a local copy already exists for this slug + version
        const existing = await localStore.loadSkill(skill.metadata.slug, skill.metadata.version);
        if (existing) {
            this.logger.debug(
                `Local copy already exists: ${skill.metadata.slug}@${skill.metadata.version}`,
            );
            return existing;
        }

        // Create local copy
        const localCopy: SkillDoc = {
            ...structuredClone(skill),
            metadata: {
                ...structuredClone(skill.metadata),
                scope: 'local-copy',
                origin: 'flattened',
                source_version: skill.metadata.version,
                source_hash: skill.metadata.content_hash ?? this.validator.computeHash(skill),
            },
        };

        // Compute hash for the local copy
        localCopy.metadata.content_hash = this.validator.computeHash(localCopy);

        await localStore.saveSkill(localCopy);

        this.logger.info(
            `Flattened skill "${skill.metadata.slug}@${skill.metadata.version}" ` +
                `from ${skill.metadata.scope} to local-copy`,
        );

        return localCopy;
    }

    /**
     * Flatten all skills that were used in a run.
     * Call this at end-of-run to ensure all dependencies are local.
     *
     * @param usedSkills  Skills used during the run
     * @param localStore  The local skill store
     * @returns Number of skills that were newly flattened
     */
    async flattenAll(usedSkills: SkillDoc[], localStore: LocalSkillStore): Promise<number> {
        let flattenedCount = 0;

        for (const skill of usedSkills) {
            if (skill.metadata.scope !== 'local' && skill.metadata.scope !== 'local-copy') {
                const existing = await localStore.exists(
                    skill.metadata.slug,
                    skill.metadata.version,
                );
                if (!existing) {
                    await this.flatten(skill, localStore);
                    flattenedCount++;
                }
            }
        }

        if (flattenedCount > 0) {
            this.logger.info(`Flattened ${flattenedCount} skill(s) to local store`);
        }

        return flattenedCount;
    }

    /**
     * Check if a global/shipped skill has been updated since the local copy was made.
     * Useful for suggesting updates during skill maintenance.
     */
    async checkForUpdates(
        localCopy: SkillDoc,
        globalStore: GlobalSkillStore,
    ): Promise<{ hasUpdate: boolean; latestVersion?: string; latestHash?: string }> {
        if (localCopy.metadata.scope !== 'local-copy') {
            return { hasUpdate: false };
        }

        const latest = await globalStore.loadLatestSkill(localCopy.metadata.slug);
        if (!latest) {
            return { hasUpdate: false };
        }

        const currentHash = localCopy.metadata.source_hash;
        const latestHash = latest.metadata.content_hash || this.validator.computeHash(latest);

        if (currentHash && currentHash !== latestHash) {
            return {
                hasUpdate: true,
                latestVersion: latest.metadata.version,
                latestHash,
            };
        }

        return { hasUpdate: false };
    }
}
