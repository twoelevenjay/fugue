/**
 * skillLifecycle.ts — Autonomous skill creation lifecycle
 *
 * Johann may autonomously:
 * 1) Detect repeated procedural pattern
 * 2) Draft skill (in-memory)
 * 3) Validate against schema + runtime guards
 * 4) Publish to local store
 * 5) Immediately use it
 *
 * Deterministic creation heuristics:
 * - Same task type executed >= 2 times in same run
 * - Pattern includes multi-step structured behavior
 * - No existing matching skill found
 * - Estimated reuse probability > 0.6
 * - Current skill count below performance caps
 *
 * NOT allowed for:
 * - One-off debugging
 * - Ad-hoc exploratory tasks
 * - Single-file micro edits
 */

import { SkillDoc, DetectedPattern } from './skillTypes';
import { TaskType } from './types';
import { SkillValidator } from './skillValidator';
import { LocalSkillStore } from './skillStore';
import { SkillCapEnforcer } from './skillCaps';
import { findEquivalentSkill } from './skillSelector';
import { getLogger } from './logger';

// ============================================================================
// Pattern Tracker
// ============================================================================

/**
 * Tracks task execution patterns within a run to detect candidates
 * for autonomous skill creation.
 */
export class PatternTracker {
    /** Pattern key → observation records */
    private patterns = new Map<string, PatternObservation>();
    private logger = getLogger();

    /**
     * Record a task execution for pattern detection.
     */
    recordExecution(
        taskType: TaskType,
        description: string,
        filePatterns: string[],
        language?: string,
        framework?: string,
    ): void {
        const key = this.computePatternKey(taskType, description, filePatterns);
        const existing = this.patterns.get(key);

        if (existing) {
            existing.occurrences++;
            existing.descriptions.push(description.substring(0, 200));
            for (const fp of filePatterns) {
                existing.filePatterns.add(fp);
            }
        } else {
            this.patterns.set(key, {
                taskType,
                occurrences: 1,
                descriptions: [description.substring(0, 200)],
                filePatterns: new Set(filePatterns),
                language: language?.toLowerCase(),
                framework: framework?.toLowerCase(),
                firstSeen: Date.now(),
            });
        }
    }

    /**
     * Detect patterns that meet the threshold for skill creation.
     */
    detectCandidatePatterns(): DetectedPattern[] {
        const candidates: DetectedPattern[] = [];

        for (const [, obs] of this.patterns) {
            // Minimum occurrence threshold
            if (obs.occurrences < 2) {
                continue;
            }

            // Exclude one-off patterns
            if (this.isExcludedPattern(obs)) {
                continue;
            }

            const reuseProbability = this.estimateReuseProbability(obs);
            if (reuseProbability < 0.6) {
                continue;
            }

            candidates.push({
                description: this.synthesizeDescription(obs),
                occurrences: obs.occurrences,
                taskTypes: [obs.taskType],
                filePatterns: Array.from(obs.filePatterns),
                languageContext: obs.language ? [obs.language] : [],
                reuseProbability,
                exampleInputs: obs.descriptions.slice(0, 3),
            });
        }

        return candidates;
    }

    /**
     * Reset pattern tracking. Call at start of each run.
     */
    reset(): void {
        this.patterns.clear();
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private methods
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Compute a pattern key from task characteristics.
     * Groups similar tasks together using normalized features.
     */
    private computePatternKey(
        taskType: TaskType,
        description: string,
        filePatterns: string[],
    ): string {
        // Normalize description to key structural words
        const structuralWords = description
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 3)
            .filter((w) => !STOP_WORDS.has(w))
            .sort()
            .slice(0, 5)
            .join('-');

        // Normalize file patterns to extensions
        const extensions = filePatterns
            .map((fp) => {
                const match = fp.match(/\.(\w+)$/);
                return match ? match[1] : '';
            })
            .filter(Boolean)
            .sort()
            .join('-');

        return `${taskType}:${structuralWords}:${extensions}`;
    }

    /**
     * Check if a pattern should be excluded from skill creation.
     */
    private isExcludedPattern(obs: PatternObservation): boolean {
        // Exclude one-off debugging
        if (obs.taskType === 'debug' && obs.occurrences < 3) {
            return true;
        }

        // Exclude exploratory tasks (very short descriptions)
        if (obs.descriptions.every((d) => d.length < 30)) {
            return true;
        }

        // Exclude single-file micro edits
        if (obs.taskType === 'edit' && obs.filePatterns.size <= 1) {
            return true;
        }

        return false;
    }

    /**
     * Estimate the probability this pattern will be reused.
     */
    private estimateReuseProbability(obs: PatternObservation): number {
        let score = 0;

        // Repetition count contributes heavily
        score += Math.min(obs.occurrences / 5, 0.4); // Up to 0.4

        // File pattern diversity (more patterns → more general → more reusable)
        score += Math.min(obs.filePatterns.size / 10, 0.2); // Up to 0.2

        // Language/framework specificity (having a language context makes it more reusable)
        if (obs.language) {
            score += 0.1;
        }
        if (obs.framework) {
            score += 0.1;
        }

        // Task type reusability bonus
        const reusableTypes = new Set<TaskType>(['generate', 'refactor', 'test', 'review']);
        if (reusableTypes.has(obs.taskType)) {
            score += 0.2;
        }

        return Math.min(score, 1.0);
    }

    /**
     * Synthesize a human-readable description from observations.
     */
    private synthesizeDescription(obs: PatternObservation): string {
        const typeLabel = TASK_TYPE_LABELS[obs.taskType] || obs.taskType;
        const fileContext =
            obs.filePatterns.size > 0
                ? ` across ${Array.from(obs.filePatterns).slice(0, 3).join(', ')}`
                : '';
        const langContext = obs.language ? ` (${obs.language})` : '';

        return `${typeLabel}${fileContext}${langContext} — observed ${obs.occurrences} times`;
    }
}

interface PatternObservation {
    taskType: TaskType;
    occurrences: number;
    descriptions: string[];
    filePatterns: Set<string>;
    language?: string;
    framework?: string;
    firstSeen: number;
}

const TASK_TYPE_LABELS: Record<string, string> = {
    generate: 'Code generation pattern',
    refactor: 'Refactoring pattern',
    test: 'Test generation pattern',
    debug: 'Debug pattern',
    review: 'Code review pattern',
    spec: 'Specification pattern',
    edit: 'Edit pattern',
    design: 'Design pattern',
    'complex-refactor': 'Complex refactoring pattern',
};

const STOP_WORDS = new Set([
    'the',
    'and',
    'for',
    'that',
    'this',
    'with',
    'from',
    'have',
    'will',
    'been',
    'into',
    'each',
    'make',
    'like',
    'then',
    'than',
    'just',
    'also',
    'should',
    'would',
    'could',
    'about',
    'which',
    'their',
    'when',
    'what',
    'some',
    'other',
    'were',
    'there',
    'file',
    'code',
    'function',
    'class',
    'method',
    'variable',
]);

// ============================================================================
// Autonomous Skill Creator
// ============================================================================

export class AutonomousSkillCreator {
    private logger = getLogger();

    /**
     * Attempt to autonomously create a skill from a detected pattern.
     *
     * Lifecycle:
     * 1. Check performance caps
     * 2. Check for existing equivalent skill (dedupe)
     * 3. Draft skill
     * 4. Validate
     * 5. If invalid, retry once with adjustments
     * 6. Publish to local store
     *
     * @returns The created skill, or undefined if creation was not possible
     */
    async createFromPattern(
        pattern: DetectedPattern,
        existingSkills: SkillDoc[],
        localStore: LocalSkillStore,
        caps: SkillCapEnforcer,
        validator: SkillValidator,
    ): Promise<SkillDoc | undefined> {
        const slug = this.generateSlug(pattern);

        // ── 1. Check caps ──────────────────────────────────────────────────
        const capCheck = await caps.canCreateSkill(slug, localStore);
        if (!capCheck.allowed) {
            this.logger.info(`Skill creation denied for "${slug}": ${capCheck.reason}`);
            return undefined;
        }

        // ── 2. Dedupe check ────────────────────────────────────────────────
        const draft = this.draftSkill(slug, pattern);
        const equivalent = findEquivalentSkill(draft, existingSkills);
        if (equivalent) {
            this.logger.info(
                `Equivalent skill found: "${equivalent.metadata.slug}@${equivalent.metadata.version}" — skipping creation`,
            );
            return equivalent;
        }

        // ── 3. Validate ────────────────────────────────────────────────────
        let result = validator.validate(draft);
        if (!result.valid) {
            this.logger.info(`Draft validation failed for "${slug}": ${result.errors.join('; ')}`);

            // ── 4. Retry with revision ─────────────────────────────────────
            const revised = this.reviseSkill(draft, result.errors);
            result = validator.validate(revised);
            if (!result.valid) {
                this.logger.warn(
                    `Revised skill still invalid for "${slug}": ${result.errors.join('; ')}`,
                );
                return undefined;
            }

            // Use the revised version
            Object.assign(draft, revised);
        }

        // ── 5. Set hash and publish ────────────────────────────────────────
        draft.metadata.content_hash = validator.computeHash(draft);

        await localStore.saveSkill(draft);
        caps.recordSkillCreated(slug);

        this.logger.info(
            `Autonomously created skill "${slug}@${draft.metadata.version}" ` +
                `(pattern: ${pattern.occurrences} occurrences, reuse prob: ${pattern.reuseProbability.toFixed(2)})`,
        );

        return draft;
    }

    /**
     * Draft a skill document from a detected pattern.
     */
    private draftSkill(slug: string, pattern: DetectedPattern): SkillDoc {
        const title = this.generateTitle(pattern);
        const body = this.generateInstructionBody(pattern);
        const steps = this.generateSteps(pattern);

        return {
            schema_version: 'johann.skill.v1',
            metadata: {
                slug,
                version: '1.0.0',
                title,
                description: pattern.description.substring(0, 200),
                tags: this.generateTags(pattern),
                scope: 'local',
                origin: 'autonomous',
                created_at: new Date().toISOString(),
            },
            applies_to: {
                task_types: pattern.taskTypes,
                languages: pattern.languageContext.length > 0 ? pattern.languageContext : undefined,
                keywords: this.extractKeywords(pattern),
            },
            instruction: {
                body,
                steps: steps.length > 0 ? steps : undefined,
            },
            security: {
                allowed_tools: [],
                allowed_file_patterns: pattern.filePatterns.map((fp) => this.toGlobPattern(fp)),
                max_instruction_chars: 8000,
            },
            history: {
                total_uses: pattern.occurrences,
                runs_used_in: 1,
                recent_run_ids: [],
                unused_run_streak: 0,
            },
        };
    }

    /**
     * Revise a skill to fix validation errors.
     */
    private reviseSkill(skill: SkillDoc, errors: string[]): SkillDoc {
        const revised = structuredClone(skill);

        for (const error of errors) {
            // Fix URL errors by removing URLs from instruction body
            if (error.includes('contains URL')) {
                revised.instruction.body = revised.instruction.body.replace(
                    /https?:\/\/[^\s'")\]]+/gi,
                    '[URL-REMOVED]',
                );
            }

            // Fix instruction length
            if (error.includes('exceeds') && error.includes('chars')) {
                revised.instruction.body = revised.instruction.body.substring(0, 7500);
            }

            // Fix prohibited phrases
            if (error.includes('prohibited phrase')) {
                const phraseMatch = error.match(/"([^"]+)"/);
                if (phraseMatch) {
                    revised.instruction.body = revised.instruction.body.replace(
                        new RegExp(phraseMatch[1], 'gi'),
                        '[REDACTED]',
                    );
                }
            }
        }

        return revised;
    }

    /**
     * Generate a URL-safe slug from a pattern.
     */
    private generateSlug(pattern: DetectedPattern): string {
        const typePrefix = pattern.taskTypes[0] || 'task';
        const words = pattern.description
            .toLowerCase()
            .split(/\W+/)
            .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
            .slice(0, 3);

        const slug = [typePrefix, ...words].join('.');
        return slug.replace(/[^a-z0-9._-]/g, '-').substring(0, 50);
    }

    private generateTitle(pattern: DetectedPattern): string {
        const typeLabel = TASK_TYPE_LABELS[pattern.taskTypes[0]] || 'Task';
        const lang = pattern.languageContext[0] ? ` (${pattern.languageContext[0]})` : '';
        return `${typeLabel}${lang}`.substring(0, 80);
    }

    private generateInstructionBody(pattern: DetectedPattern): string {
        const parts: string[] = [];
        parts.push(`When this skill is triggered, follow this procedure:`);
        parts.push('');
        parts.push(`This pattern was observed ${pattern.occurrences} times.`);
        parts.push('');

        if (pattern.exampleInputs.length > 0) {
            parts.push('Example inputs that triggered this pattern:');
            for (const input of pattern.exampleInputs) {
                parts.push(`- ${input}`);
            }
            parts.push('');
        }

        if (pattern.filePatterns.length > 0) {
            parts.push('Typically operates on these file patterns:');
            for (const fp of pattern.filePatterns) {
                parts.push(`- ${fp}`);
            }
        }

        return parts.join('\n');
    }

    private generateSteps(pattern: DetectedPattern): string[] {
        const steps: string[] = [];

        steps.push('Analyze the input to identify the target files/components');
        if (pattern.taskTypes.includes('generate')) {
            steps.push('Generate the required code following project conventions');
        }
        if (pattern.taskTypes.includes('refactor')) {
            steps.push('Refactor the target code while preserving behavior');
        }
        if (pattern.taskTypes.includes('test')) {
            steps.push('Generate comprehensive tests with edge cases');
        }
        steps.push('Verify the changes compile and pass existing tests');

        return steps;
    }

    private generateTags(pattern: DetectedPattern): string[] {
        const tags: string[] = [...pattern.taskTypes];
        if (pattern.languageContext.length > 0) {
            tags.push(...pattern.languageContext);
        }
        return tags.slice(0, 10);
    }

    private extractKeywords(pattern: DetectedPattern): string[] {
        const allWords = pattern.exampleInputs.join(' ').toLowerCase();
        const tokens = allWords.split(/\W+/).filter((w) => w.length > 3 && !STOP_WORDS.has(w));

        // Count frequency and return top keywords
        const freq = new Map<string, number>();
        for (const t of tokens) {
            freq.set(t, (freq.get(t) || 0) + 1);
        }

        return Array.from(freq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([word]) => word);
    }

    private toGlobPattern(filePath: string): string {
        // Convert a specific file path to a glob pattern
        const ext = filePath.match(/\.(\w+)$/)?.[1];
        if (ext) {
            return `**/*.${ext}`;
        }
        return `**/${filePath}`;
    }
}
