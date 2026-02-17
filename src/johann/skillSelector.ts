/**
 * skillSelector.ts — Skill selection algorithm + dedupe engine
 *
 * Implements the deterministic skill selection pipeline:
 * 1) Match applies_to.task_types
 * 2) Filter language/framework
 * 3) Match repo_patterns
 * 4) Prefer local > global > shipped
 * 5) Highest semver wins
 * 6) Most recently used wins if tie
 * 7) Log selection in ledger
 *
 * Also implements the global-first dedupe policy:
 * Before creating a new local skill, search shipped → global → local.
 */

import {
    SkillDoc,
    SkillSelectionContext,
    SkillSelectionResult,
    ISkillSelector,
} from './skillTypes';
import { compareSemver } from './skillStore';
import { getLogger } from './logger';

// ============================================================================
// Score weights
// ============================================================================

const WEIGHTS = {
    /** Base score for task type match */
    TASK_TYPE_MATCH: 10,
    /** Bonus for each matching keyword */
    KEYWORD_MATCH: 2,
    /** Bonus for keyword substring match */
    KEYWORD_SUBSTRING: 1,
    /** Bonus for language match */
    LANGUAGE_MATCH: 5,
    /** Bonus for framework match */
    FRAMEWORK_MATCH: 5,
    /** Bonus for repo pattern match */
    REPO_PATTERN_MATCH: 3,
    /** Scope priority bonus: local > global > shipped */
    SCOPE_LOCAL: 6,
    SCOPE_LOCAL_COPY: 5,
    SCOPE_GLOBAL: 3,
    SCOPE_SHIPPED: 1,
    /** Bonus per semver level above 1.0.0 */
    SEMVER_BONUS: 0.5,
    /** Recency bonus — recently used skills score higher */
    RECENCY_BONUS: 2,
};

// ============================================================================
// Selector Implementation
// ============================================================================

export class SkillSelector implements ISkillSelector {
    private logger = getLogger();

    /**
     * Select the best skill for a given context from all available skills.
     *
     * @param context  The task context to match against
     * @param allSkills  Combined list of local + global + shipped skills (caller provides)
     */
    async select(
        context: SkillSelectionContext,
        allSkills?: SkillDoc[],
    ): Promise<SkillSelectionResult> {
        const skills = allSkills ?? [];

        if (skills.length === 0) {
            return {
                skill: undefined,
                candidates: [],
                flattened: false,
                logMessage: 'No skills available',
            };
        }

        // Score all skills
        const scored = skills
            .map((skill) => {
                const { score, reasons } = this.scoreSkill(skill, context);
                return { skill, score, matchReasons: reasons };
            })
            .filter((c) => c.score > 0)
            .sort((a, b) => b.score - a.score);

        if (scored.length === 0) {
            return {
                skill: undefined,
                candidates: [],
                flattened: false,
                logMessage: `No matching skills for taskType=${context.taskType}`,
            };
        }

        const winner = scored[0];
        const logMessage =
            `Selected skill "${winner.skill.metadata.slug}@${winner.skill.metadata.version}" ` +
            `(score: ${winner.score.toFixed(1)}, scope: ${winner.skill.metadata.scope}) ` +
            `for taskType=${context.taskType}, ` +
            `reasons: [${winner.matchReasons.join(', ')}]`;

        this.logger.info(logMessage);

        return {
            skill: winner.skill,
            candidates: scored,
            flattened: false, // Flattening is handled by the caller (SkillSystem)
            logMessage,
        };
    }

    /**
     * Score a skill against a selection context.
     * Returns the composite score and reasons for the score.
     */
    scoreSkill(
        skill: SkillDoc,
        context: SkillSelectionContext,
    ): { score: number; reasons: string[] } {
        let score = 0;
        const reasons: string[] = [];

        // ── 1. Task type match (required) ──────────────────────────────────
        if (skill.applies_to.task_types.includes(context.taskType)) {
            score += WEIGHTS.TASK_TYPE_MATCH;
            reasons.push(`taskType:${context.taskType}`);
        } else {
            return { score: 0, reasons: ['no-task-type-match'] };
        }

        // ── 2. Keyword matching ────────────────────────────────────────────
        if (skill.applies_to.keywords.length > 0 && context.description) {
            const descLower = context.description.toLowerCase();
            const descTokens = new Set(descLower.split(/\W+/).filter((t) => t.length > 2));

            for (const keyword of skill.applies_to.keywords) {
                const kwLower = keyword.toLowerCase();
                if (descTokens.has(kwLower)) {
                    score += WEIGHTS.KEYWORD_MATCH;
                    reasons.push(`keyword:${keyword}`);
                } else if (descLower.includes(kwLower)) {
                    score += WEIGHTS.KEYWORD_SUBSTRING;
                    reasons.push(`keyword-sub:${keyword}`);
                }
            }
        }

        // ── 3. Language match ──────────────────────────────────────────────
        if (context.language && skill.applies_to.languages) {
            const langLower = context.language.toLowerCase();
            if (skill.applies_to.languages.some((l) => l.toLowerCase() === langLower)) {
                score += WEIGHTS.LANGUAGE_MATCH;
                reasons.push(`lang:${context.language}`);
            }
        }

        // ── 4. Framework match ─────────────────────────────────────────────
        if (context.framework && skill.applies_to.frameworks) {
            const fwLower = context.framework.toLowerCase();
            if (skill.applies_to.frameworks.some((f) => f.toLowerCase() === fwLower)) {
                score += WEIGHTS.FRAMEWORK_MATCH;
                reasons.push(`framework:${context.framework}`);
            }
        }

        // ── 5. Repo pattern match ──────────────────────────────────────────
        if (context.filePaths && skill.applies_to.repo_patterns) {
            for (const pattern of skill.applies_to.repo_patterns) {
                const regex = globToRegex(pattern);
                if (context.filePaths.some((fp) => regex.test(fp))) {
                    score += WEIGHTS.REPO_PATTERN_MATCH;
                    reasons.push(`repo-pattern:${pattern}`);
                    break; // One match is enough
                }
            }
        }

        // ── 6. Scope priority ──────────────────────────────────────────────
        switch (skill.metadata.scope) {
            case 'local':
                score += WEIGHTS.SCOPE_LOCAL;
                break;
            case 'local-copy':
                score += WEIGHTS.SCOPE_LOCAL_COPY;
                break;
            case 'global':
                score += WEIGHTS.SCOPE_GLOBAL;
                break;
            case 'shipped':
                score += WEIGHTS.SCOPE_SHIPPED;
                break;
        }

        // ── 7. Semver bonus ────────────────────────────────────────────────
        const semverDelta = compareSemver(skill.metadata.version, '1.0.0');
        if (semverDelta > 0) {
            score += WEIGHTS.SEMVER_BONUS * semverDelta;
        }

        // ── 8. Recency bonus ───────────────────────────────────────────────
        if (skill.metadata.last_used_at) {
            const lastUsed = new Date(skill.metadata.last_used_at).getTime();
            const hoursSinceUse = (Date.now() - lastUsed) / (1000 * 60 * 60);
            if (hoursSinceUse < 24) {
                score += WEIGHTS.RECENCY_BONUS;
                reasons.push('recent-use');
            }
        }

        return { score, reasons };
    }
}

// ============================================================================
// Dedupe Engine
// ============================================================================

/**
 * Search for an existing equivalent skill across all stores.
 * Returns the matching skill if found, or undefined.
 *
 * Equivalence is determined by:
 * - Same slug (exact match)
 * - Same major version
 * - Similar instruction body (>80% overlap by Jaccard similarity)
 */
export function findEquivalentSkill(
    candidate: SkillDoc,
    existingSkills: SkillDoc[],
): SkillDoc | undefined {
    const candidateSlug = candidate.metadata.slug;
    const candidateMajor = candidate.metadata.version.split('.')[0];

    // First: exact slug + same major version
    for (const existing of existingSkills) {
        if (existing.metadata.slug === candidateSlug) {
            const existingMajor = existing.metadata.version.split('.')[0];
            if (existingMajor === candidateMajor) {
                return existing;
            }
        }
    }

    // Second: instruction body similarity (slugs differ but content is near-identical)
    const candidateTokens = tokenize(candidate.instruction.body);
    for (const existing of existingSkills) {
        const existingTokens = tokenize(existing.instruction.body);
        const similarity = jaccardSimilarity(candidateTokens, existingTokens);
        if (similarity > 0.8) {
            return existing;
        }
    }

    return undefined;
}

/**
 * Tokenize a text into a set of normalized words.
 */
function tokenize(text: string): Set<string> {
    return new Set(
        text
            .toLowerCase()
            .split(/\W+/)
            .filter((t) => t.length > 2),
    );
}

/**
 * Compute Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) {
        return 1;
    }
    let intersection = 0;
    for (const token of a) {
        if (b.has(token)) {
            intersection++;
        }
    }
    const union = a.size + b.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Convert a simple glob pattern to a regex.
 * Supports: * (any chars), ? (single char), ** (recursive)
 */
function globToRegex(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '<<GLOBSTAR>>')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/<<GLOBSTAR>>/g, '.*');
    return new RegExp(`^${escaped}$`, 'i');
}
