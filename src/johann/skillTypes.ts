/**
 * skillTypes.ts — Core type definitions for the Johann Skill Subsystem
 *
 * Defines the complete type system for YAML-based skills including:
 * - SkillDoc: The full in-memory representation of a skill file
 * - SkillScope: Where a skill resides and its provenance
 * - SkillInvocation: Ledger entry for auditing skill usage
 * - SkillStore/SkillValidator/SkillSelector: Service interfaces
 *
 * Schema version: johann.skill.v1
 */

import { TaskType } from './types';

// ============================================================================
// Enums & Literals
// ============================================================================

/** Where the skill lives and how it got there. */
export type SkillScope =
    | 'local'       // Created autonomously in repo's .vscode/johann/skills/
    | 'global'      // Promoted by user to global store
    | 'shipped'     // Bundled with the extension
    | 'local-copy'; // Flattened copy of a global/shipped skill

/** Lifecycle state of a skill file. */
export type SkillStatus =
    | 'draft'       // In-progress, not yet validated (*.draft.skill.yaml)
    | 'published'   // Validated and immutable (*.skill.yaml)
    | 'stale'       // Unused across N runs, candidate for deprecation
    | 'tampered'    // Hash mismatch detected — disabled
    | 'deprecated'; // Marked for removal

/** How a skill was created. */
export type SkillOrigin =
    | 'autonomous'  // Created by Johann during a run
    | 'user'        // Created via explicit user action
    | 'shipped'     // Bundled with extension
    | 'promoted'    // Promoted from local to global
    | 'flattened';  // Copied from global/shipped to local

// ============================================================================
// Skill Document — The full YAML structure
// ============================================================================

/**
 * The complete in-memory representation of a `.skill.yaml` file.
 * Maps 1:1 to the YAML on disk.
 */
export interface SkillDoc {
    /** Schema version — must be "johann.skill.v1" */
    schema_version: 'johann.skill.v1';

    /** Metadata block */
    metadata: SkillMetadata;

    /** What this skill applies to */
    applies_to: SkillAppliesTo;

    /** The skill's instruction body */
    instruction: SkillInstruction;

    /** Tool and file access restrictions */
    security: SkillSecurity;

    /** Usage and versioning history */
    history: SkillHistory;
}

export interface SkillMetadata {
    /** URL-safe slug (e.g., "scaffold.component") */
    slug: string;
    /** Semantic version (e.g., "1.0.0") */
    version: string;
    /** Human-readable title */
    title: string;
    /** Short description (max 200 chars) */
    description: string;
    /** Categorization tags */
    tags: string[];
    /** local | global | shipped | local-copy */
    scope: SkillScope;
    /** How the skill was created */
    origin: SkillOrigin;
    /** ISO 8601 creation timestamp */
    created_at: string;
    /** ISO 8601 last-used timestamp (mutable field on published skills) */
    last_used_at?: string;
    /** SHA-256 hash of the instruction body (set on publish, used for tamper detection) */
    content_hash?: string;
    /** For local-copy: the version of the source skill that was copied */
    source_version?: string;
    /** For local-copy: the hash of the source skill */
    source_hash?: string;
}

export interface SkillAppliesTo {
    /** Task types this skill handles */
    task_types: TaskType[];
    /** Programming languages (lowercase, e.g., "typescript", "python") */
    languages?: string[];
    /** Frameworks (e.g., "react", "express", "django") */
    frameworks?: string[];
    /** Glob patterns for repo structures that trigger this skill */
    repo_patterns?: string[];
    /** Keywords for inference-based routing */
    keywords: string[];
}

export interface SkillInstruction {
    /** The system prompt instruction body (max 8000 chars) */
    body: string;
    /** Structured steps the agent should follow */
    steps?: string[];
    /** Output format hint */
    output_format?: string;
    /** Expected inputs description */
    inputs?: string[];
}

export interface SkillSecurity {
    /** Allowed tool names (empty = no tool restriction) */
    allowed_tools: string[];
    /** File path patterns the skill may access (glob) */
    allowed_file_patterns: string[];
    /** Maximum instruction body length */
    max_instruction_chars: number;
}

export interface SkillHistory {
    /** Total number of times this skill has been invoked */
    total_uses: number;
    /** Number of distinct runs this skill was used in */
    runs_used_in: number;
    /** Run IDs that used this skill (last N) */
    recent_run_ids: string[];
    /** Number of consecutive runs where this skill was NOT used */
    unused_run_streak: number;
}

// ============================================================================
// Skill Invocation Record — Ledger entry for auditing
// ============================================================================

/**
 * Logged every time a skill is invoked during a run.
 */
export interface SkillInvocation {
    /** Run/session ID */
    run_id: string;
    /** Skill slug */
    skill_id: string;
    /** Skill version */
    version: string;
    /** SHA-256 hash at time of invocation */
    hash: string;
    /** Scope at time of invocation */
    scope: SkillScope;
    /** Input description that triggered this skill */
    inputs: string;
    /** Files the skill touched */
    files_touched: string[];
    /** Tools the skill used */
    tools_used: string[];
    /** Whether the skill's instructions were followed successfully */
    success: boolean;
    /** Verification result notes */
    verification_notes?: string;
    /** ISO timestamp */
    timestamp: string;
}

// ============================================================================
// Performance Caps
// ============================================================================

/**
 * Hard limits to prevent skill explosion.
 */
export interface SkillPerformanceCaps {
    /** Maximum total local skills per project */
    maxLocalSkills: number;
    /** Maximum new skills that can be created in a single run */
    maxNewSkillsPerRun: number;
    /** Maximum versions per skill slug */
    maxVersionsPerSkill: number;
    /** Minimum seconds between skill version bumps */
    minTimeBetweenVersionsMs: number;
    /** When local skill count exceeds this, suggest consolidation */
    consolidationThreshold: number;
    /** Number of runs without use before marking stale */
    staleAfterUnusedRuns: number;
}

export const DEFAULT_SKILL_CAPS: SkillPerformanceCaps = {
    maxLocalSkills: 50,
    maxNewSkillsPerRun: 5,
    maxVersionsPerSkill: 10,
    minTimeBetweenVersionsMs: 10 * 60 * 1000, // 10 minutes
    consolidationThreshold: 40,
    staleAfterUnusedRuns: 5,
};

// ============================================================================
// Pattern Detection — For autonomous skill creation heuristics
// ============================================================================

/**
 * A detected procedural pattern that may warrant skill creation.
 */
export interface DetectedPattern {
    /** Description of the pattern */
    description: string;
    /** Number of times observed in current run */
    occurrences: number;
    /** Task types involved */
    taskTypes: TaskType[];
    /** File patterns involved */
    filePatterns: string[];
    /** Language/framework context */
    languageContext: string[];
    /** Estimated reuse probability (0-1) */
    reuseProbability: number;
    /** Example inputs that triggered this pattern */
    exampleInputs: string[];
}

// ============================================================================
// Skill Selection Result
// ============================================================================

/**
 * Result of the skill selection algorithm.
 */
export interface SkillSelectionResult {
    /** The selected skill (or undefined if none matched) */
    skill?: SkillDoc;
    /** All candidates considered, with scores */
    candidates: Array<{
        skill: SkillDoc;
        score: number;
        matchReasons: string[];
    }>;
    /** Whether the skill was flattened (copied from global to local) */
    flattened: boolean;
    /** Log message for auditing */
    logMessage: string;
}

// ============================================================================
// Promotion Candidate — Shown in end-of-run UI
// ============================================================================

/**
 * A skill that's eligible for promotion to global store.
 */
export interface PromotionCandidate {
    /** The skill document */
    skill: SkillDoc;
    /** Usage count during the current run */
    usageCountThisRun: number;
    /** Whether a previous version exists in global store */
    hasPreviousGlobalVersion: boolean;
    /** Diff summary from previous version (if applicable) */
    diffSummary?: string;
}

// ============================================================================
// Service Interfaces
// ============================================================================

/**
 * Storage adapter interface — abstracts local vs. global file access.
 */
export interface ISkillStore {
    /** List all skills in this store */
    listSkills(): Promise<SkillDoc[]>;
    /** Load a specific skill by slug and version */
    loadSkill(slug: string, version: string): Promise<SkillDoc | undefined>;
    /** Load the latest version of a skill by slug */
    loadLatestSkill(slug: string): Promise<SkillDoc | undefined>;
    /** Save a skill (write to disk) */
    saveSkill(skill: SkillDoc): Promise<void>;
    /** Save a draft skill */
    saveDraft(skill: SkillDoc): Promise<void>;
    /** Delete a skill file */
    deleteSkill(slug: string, version: string): Promise<boolean>;
    /** Check if a skill exists */
    exists(slug: string, version: string): Promise<boolean>;
    /** Get the URI for a skill file */
    getSkillUri(slug: string, version: string, isDraft?: boolean): import('vscode').Uri;
}

/**
 * Validation service interface.
 */
export interface ISkillValidator {
    /** Validate a skill document against schema + runtime guards */
    validate(skill: SkillDoc): SkillValidationResult;
    /** Verify a published skill's integrity (hash check) */
    verifyIntegrity(skill: SkillDoc): boolean;
    /** Compute SHA-256 hash of the instruction body */
    computeHash(skill: SkillDoc): string;
}

/**
 * Result of skill validation.
 */
export interface SkillValidationResult {
    /** Whether the skill passes all checks */
    valid: boolean;
    /** List of validation errors */
    errors: string[];
    /** List of warnings (non-blocking) */
    warnings: string[];
}

/**
 * Skill selection service interface.
 */
export interface ISkillSelector {
    /** Select the best skill for a given task context */
    select(context: SkillSelectionContext): Promise<SkillSelectionResult>;
}

/**
 * Context provided to the skill selector.
 */
export interface SkillSelectionContext {
    /** Task type being executed */
    taskType: TaskType;
    /** Task description */
    description: string;
    /** Programming language (if known) */
    language?: string;
    /** Framework (if known) */
    framework?: string;
    /** File paths being worked on */
    filePaths?: string[];
    /** Run ID for ledger logging */
    runId: string;
}

// ============================================================================
// Skill filename helpers
// ============================================================================

/**
 * Build the canonical filename for a skill.
 * Published: `<slug>__<semver>.skill.yaml`
 * Draft: `<slug>__<semver>.draft.skill.yaml`
 */
export function skillFilename(slug: string, version: string, isDraft: boolean = false): string {
    const safe = slug.replace(/[^a-z0-9._-]/gi, '-');
    const ver = version.replace(/[^0-9.]/g, '');
    return isDraft
        ? `${safe}__${ver}.draft.skill.yaml`
        : `${safe}__${ver}.skill.yaml`;
}

/**
 * Parse a skill filename into its components.
 * Returns undefined if the filename doesn't match the expected pattern.
 */
export function parseSkillFilename(filename: string): { slug: string; version: string; isDraft: boolean } | undefined {
    const match = filename.match(/^(.+?)__(\d+\.\d+\.\d+)(?:\.draft)?\.skill\.yaml$/);
    if (!match) {
        return undefined;
    }
    return {
        slug: match[1],
        version: match[2],
        isDraft: filename.includes('.draft.skill.yaml'),
    };
}
