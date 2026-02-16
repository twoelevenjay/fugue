/**
 * skillStore.ts — Local and Global skill storage adapters
 *
 * Provides two ISkillStore implementations:
 * - LocalSkillStore: reads/writes `.vscode/johann/skills/`
 * - GlobalSkillStore: reads/writes `${globalStorageUri}/skills/`
 *
 * Both use safeIO.ts atomic writes and vscode.workspace.fs for
 * cross-platform compatibility.
 *
 * File naming convention:
 *   Published: `<slug>__<semver>.skill.yaml`
 *   Draft:     `<slug>__<semver>.draft.skill.yaml`
 */

import * as vscode from 'vscode';
import { SkillDoc, ISkillStore, skillFilename, parseSkillFilename } from './skillTypes';
import { parseSkillYaml, serializeSkillYaml } from './skillSchema';
import { safeWrite, safeRead } from './safeIO';
import { getLogger } from './logger';

// ============================================================================
// Abstract Base Store
// ============================================================================

abstract class BaseSkillStore implements ISkillStore {
    protected logger = getLogger();

    /** Subclasses provide the root directory URI */
    abstract getRootUri(): vscode.Uri;

    /**
     * List all published skills in the store.
     */
    async listSkills(): Promise<SkillDoc[]> {
        const rootUri = this.getRootUri();
        const skills: SkillDoc[] = [];

        try {
            const entries = await vscode.workspace.fs.readDirectory(rootUri);

            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File) {
                    continue;
                }
                if (!name.endsWith('.skill.yaml')) {
                    continue;
                }
                if (name.includes('.draft.')) {
                    continue;
                } // Skip drafts

                try {
                    const fileUri = vscode.Uri.joinPath(rootUri, name);
                    const content = await safeRead(fileUri);
                    if (content) {
                        const skill = parseSkillYaml(content);
                        skills.push(skill);
                    }
                } catch (err) {
                    this.logger.warn(`Failed to parse skill file ${name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        } catch {
            // Directory may not exist yet
        }

        return skills;
    }

    /**
     * Load a specific skill by slug and version.
     */
    async loadSkill(slug: string, version: string): Promise<SkillDoc | undefined> {
        const fileUri = this.getSkillUri(slug, version);
        try {
            const content = await safeRead(fileUri);
            if (!content) {
                return undefined;
            }
            return parseSkillYaml(content);
        } catch {
            return undefined;
        }
    }

    /**
     * Load the latest version of a skill by slug.
     * Scans all files matching the slug and returns the highest semver.
     */
    async loadLatestSkill(slug: string): Promise<SkillDoc | undefined> {
        const rootUri = this.getRootUri();

        try {
            const entries = await vscode.workspace.fs.readDirectory(rootUri);
            let latestVersion: string | undefined;
            let latestSkill: SkillDoc | undefined;

            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File) {
                    continue;
                }
                if (!name.endsWith('.skill.yaml')) {
                    continue;
                }
                if (name.includes('.draft.')) {
                    continue;
                }

                const parsed = parseSkillFilename(name);
                if (!parsed || parsed.slug !== slug) {
                    continue;
                }

                if (!latestVersion || compareSemver(parsed.version, latestVersion) > 0) {
                    try {
                        const fileUri = vscode.Uri.joinPath(rootUri, name);
                        const content = await safeRead(fileUri);
                        if (content) {
                            latestVersion = parsed.version;
                            latestSkill = parseSkillYaml(content);
                        }
                    } catch {
                        // Skip unparseable files
                    }
                }
            }

            return latestSkill;
        } catch {
            return undefined;
        }
    }

    /**
     * Save a published skill to disk (atomic write).
     */
    async saveSkill(skill: SkillDoc): Promise<void> {
        const fileUri = this.getSkillUri(skill.metadata.slug, skill.metadata.version);
        await this.ensureDirectory();
        const yaml = serializeSkillYaml(skill);
        await safeWrite(fileUri, yaml);
        this.logger.info(`Saved skill: ${skill.metadata.slug}@${skill.metadata.version} → ${fileUri.fsPath}`);
    }

    /**
     * Save a draft skill to disk.
     */
    async saveDraft(skill: SkillDoc): Promise<void> {
        const fileUri = this.getSkillUri(skill.metadata.slug, skill.metadata.version, true);
        await this.ensureDirectory();
        const yaml = serializeSkillYaml(skill);
        await safeWrite(fileUri, yaml);
        this.logger.debug(`Saved draft: ${skill.metadata.slug}@${skill.metadata.version}`);
    }

    /**
     * Delete a skill file.
     */
    async deleteSkill(slug: string, version: string): Promise<boolean> {
        const fileUri = this.getSkillUri(slug, version);
        try {
            await vscode.workspace.fs.delete(fileUri);
            this.logger.info(`Deleted skill: ${slug}@${version}`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Check if a skill file exists.
     */
    async exists(slug: string, version: string): Promise<boolean> {
        const fileUri = this.getSkillUri(slug, version);
        try {
            await vscode.workspace.fs.stat(fileUri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get the URI for a skill file.
     */
    getSkillUri(slug: string, version: string, isDraft: boolean = false): vscode.Uri {
        const filename = skillFilename(slug, version, isDraft);
        return vscode.Uri.joinPath(this.getRootUri(), filename);
    }

    /**
     * Count total number of published skills.
     */
    async countSkills(): Promise<number> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.getRootUri());
            return entries.filter(
                ([name, type]) => type === vscode.FileType.File &&
                    name.endsWith('.skill.yaml') &&
                    !name.includes('.draft.')
            ).length;
        } catch {
            return 0;
        }
    }

    /**
     * Count versions of a specific slug.
     */
    async countVersions(slug: string): Promise<number> {
        try {
            const entries = await vscode.workspace.fs.readDirectory(this.getRootUri());
            return entries.filter(([name, type]) => {
                if (type !== vscode.FileType.File) {
                    return false;
                }
                if (!name.endsWith('.skill.yaml') || name.includes('.draft.')) {
                    return false;
                }
                const parsed = parseSkillFilename(name);
                return parsed?.slug === slug;
            }).length;
        } catch {
            return 0;
        }
    }

    /**
     * List all draft skills.
     */
    async listDrafts(): Promise<SkillDoc[]> {
        const rootUri = this.getRootUri();
        const drafts: SkillDoc[] = [];

        try {
            const entries = await vscode.workspace.fs.readDirectory(rootUri);
            for (const [name, type] of entries) {
                if (type !== vscode.FileType.File) {
                    continue;
                }
                if (!name.includes('.draft.skill.yaml')) {
                    continue;
                }

                try {
                    const fileUri = vscode.Uri.joinPath(rootUri, name);
                    const content = await safeRead(fileUri);
                    if (content) {
                        drafts.push(parseSkillYaml(content));
                    }
                } catch {
                    // Skip
                }
            }
        } catch {
            // Directory may not exist
        }

        return drafts;
    }

    /**
     * Delete a draft file.
     */
    async deleteDraft(slug: string, version: string): Promise<boolean> {
        const fileUri = this.getSkillUri(slug, version, true);
        try {
            await vscode.workspace.fs.delete(fileUri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Ensure the store directory exists.
     */
    protected async ensureDirectory(): Promise<void> {
        try {
            await vscode.workspace.fs.createDirectory(this.getRootUri());
        } catch {
            // Already exists
        }
    }
}

// ============================================================================
// Local Skill Store — .vscode/johann/skills/
// ============================================================================

export class LocalSkillStore extends BaseSkillStore {
    private rootUri: vscode.Uri;

    constructor(workspaceUri?: vscode.Uri) {
        super();
        const folders = vscode.workspace.workspaceFolders;
        const base = workspaceUri ?? folders?.[0]?.uri;
        if (!base) {
            throw new Error('No workspace folder available for LocalSkillStore');
        }
        this.rootUri = vscode.Uri.joinPath(base, '.vscode', 'johann', 'skills');
    }

    getRootUri(): vscode.Uri {
        return this.rootUri;
    }
}

// ============================================================================
// Global Skill Store — ${globalStorageUri}/skills/
// ============================================================================

export class GlobalSkillStore extends BaseSkillStore {
    private rootUri: vscode.Uri;

    constructor(globalStorageUri: vscode.Uri) {
        super();
        this.rootUri = vscode.Uri.joinPath(globalStorageUri, 'skills');
    }

    getRootUri(): vscode.Uri {
        return this.rootUri;
    }
}

// ============================================================================
// Semver comparison helper
// ============================================================================

/**
 * Compare two semver strings.
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
        const av = pa[i] ?? 0;
        const bv = pb[i] ?? 0;
        if (av !== bv) {
            return av - bv;
        }
    }
    return 0;
}

/**
 * Bump a semver string by patch version.
 */
export function bumpPatch(version: string): string {
    const parts = version.split('.').map(Number);
    parts[2] = (parts[2] ?? 0) + 1;
    return parts.join('.');
}

/**
 * Bump a semver string by minor version (resets patch).
 */
export function bumpMinor(version: string): string {
    const parts = version.split('.').map(Number);
    parts[1] = (parts[1] ?? 0) + 1;
    parts[2] = 0;
    return parts.join('.');
}
