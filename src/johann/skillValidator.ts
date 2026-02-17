/**
 * skillValidator.ts — Schema validation + runtime security guards
 *
 * Enforces:
 * - JSON schema structure validation (all required fields present/typed)
 * - Injection phrase detection (prompt injection defense)
 * - URL rejection in instruction bodies
 * - Tool allowlist enforcement
 * - File scope enforcement
 * - Instruction character limits
 * - SHA-256 hash computation and tamper detection
 *
 * Uses NO external dependencies — pure TypeScript validation.
 */

import * as crypto from 'crypto';
import { SkillDoc, SkillValidationResult, ISkillValidator } from './skillTypes';

// ============================================================================
// Constants
// ============================================================================

/** Maximum characters allowed in the instruction body */
const MAX_INSTRUCTION_CHARS = 8000;

/** Maximum characters for description */
const MAX_DESCRIPTION_CHARS = 200;

/** Maximum tags per skill */
const MAX_TAGS = 20;

/** Maximum keywords per skill */
const MAX_KEYWORDS = 30;

/** Maximum steps per skill */
const MAX_STEPS = 50;

/** Maximum allowed tools per skill */
const MAX_ALLOWED_TOOLS = 30;

/** Maximum file patterns per skill */
const MAX_FILE_PATTERNS = 50;

/** Valid task types */
const VALID_TASK_TYPES: readonly string[] = [
    'generate',
    'refactor',
    'test',
    'debug',
    'review',
    'spec',
    'edit',
    'design',
    'complex-refactor',
] as const;

/** Valid scopes */
const VALID_SCOPES: readonly string[] = ['local', 'global', 'shipped', 'local-copy'] as const;

/** Valid origins */
const VALID_ORIGINS: readonly string[] = [
    'autonomous',
    'user',
    'shipped',
    'promoted',
    'flattened',
] as const;

/** Semver regex */
const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;

/**
 * Injection phrases to reject in instruction bodies.
 * Case-insensitive matching.
 */
const INJECTION_PHRASES: readonly string[] = [
    'ignore previous instructions',
    'ignore all previous',
    'disregard previous',
    'system prompt',
    'exfiltrate',
    'send to',
    'curl http',
    'wget http',
    'fetch(',
    'XMLHttpRequest',
    'navigator.sendBeacon',
    'document.cookie',
    'localStorage.getItem',
    'eval(',
    'Function(',
    'new Function',
    'import(',
    'require(',
    'child_process',
    'exec(',
    'execSync',
    'spawn(',
];

/**
 * URL patterns to reject in instruction bodies.
 */
const URL_REGEX = /https?:\/\/[^\s'")\]]+/gi;

// ============================================================================
// Validator Implementation
// ============================================================================

export class SkillValidator implements ISkillValidator {
    /**
     * Validate a skill document against the full schema + runtime guards.
     */
    validate(skill: SkillDoc): SkillValidationResult {
        const errors: string[] = [];
        const warnings: string[] = [];

        // ── Schema version ─────────────────────────────────────────────────
        if (skill.schema_version !== 'johann.skill.v1') {
            errors.push(
                `Invalid schema_version: "${skill.schema_version}" (expected "johann.skill.v1")`,
            );
        }

        // ── Metadata ───────────────────────────────────────────────────────
        this.validateMetadata(skill, errors, warnings);

        // ── applies_to ─────────────────────────────────────────────────────
        this.validateAppliesTo(skill, errors, warnings);

        // ── instruction ────────────────────────────────────────────────────
        this.validateInstruction(skill, errors, warnings);

        // ── security ───────────────────────────────────────────────────────
        this.validateSecurity(skill, errors, warnings);

        // ── history ────────────────────────────────────────────────────────
        this.validateHistory(skill, errors, warnings);

        // ── Runtime security guards ────────────────────────────────────────
        this.runSecurityGuards(skill, errors, warnings);

        return {
            valid: errors.length === 0,
            errors,
            warnings,
        };
    }

    /**
     * Verify a published skill's integrity by comparing stored hash
     * against computed hash.
     */
    verifyIntegrity(skill: SkillDoc): boolean {
        if (!skill.metadata.content_hash) {
            return false; // No hash stored — can't verify
        }
        const computed = this.computeHash(skill);
        return computed === skill.metadata.content_hash;
    }

    /**
     * Compute SHA-256 hash of the skill's instruction body.
     */
    computeHash(skill: SkillDoc): string {
        const content = JSON.stringify({
            body: skill.instruction.body,
            steps: skill.instruction.steps,
            output_format: skill.instruction.output_format,
            inputs: skill.instruction.inputs,
        });
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private validation methods
    // ════════════════════════════════════════════════════════════════════════

    private validateMetadata(skill: SkillDoc, errors: string[], warnings: string[]): void {
        const m = skill.metadata;
        if (!m) {
            errors.push('Missing required field: metadata');
            return;
        }

        if (!m.slug || typeof m.slug !== 'string') {
            errors.push('metadata.slug is required and must be a string');
        } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(m.slug)) {
            errors.push(
                `metadata.slug "${m.slug}" must be lowercase alphanumeric with dots/hyphens/underscores`,
            );
        }

        if (!m.version || typeof m.version !== 'string') {
            errors.push('metadata.version is required and must be a string');
        } else if (!SEMVER_REGEX.test(m.version)) {
            errors.push(`metadata.version "${m.version}" must be valid semver (e.g., "1.0.0")`);
        }

        if (!m.title || typeof m.title !== 'string') {
            errors.push('metadata.title is required and must be a string');
        }

        if (!m.description || typeof m.description !== 'string') {
            errors.push('metadata.description is required and must be a string');
        } else if (m.description.length > MAX_DESCRIPTION_CHARS) {
            errors.push(
                `metadata.description exceeds ${MAX_DESCRIPTION_CHARS} chars (${m.description.length})`,
            );
        }

        if (!Array.isArray(m.tags)) {
            errors.push('metadata.tags must be an array');
        } else if (m.tags.length > MAX_TAGS) {
            warnings.push(
                `metadata.tags has ${m.tags.length} entries (max recommended: ${MAX_TAGS})`,
            );
        }

        if (!VALID_SCOPES.includes(m.scope)) {
            errors.push(`metadata.scope "${m.scope}" must be one of: ${VALID_SCOPES.join(', ')}`);
        }

        if (!VALID_ORIGINS.includes(m.origin)) {
            errors.push(
                `metadata.origin "${m.origin}" must be one of: ${VALID_ORIGINS.join(', ')}`,
            );
        }

        if (!m.created_at || typeof m.created_at !== 'string') {
            errors.push('metadata.created_at is required');
        }
    }

    private validateAppliesTo(skill: SkillDoc, errors: string[], warnings: string[]): void {
        const a = skill.applies_to;
        if (!a) {
            errors.push('Missing required field: applies_to');
            return;
        }

        if (!Array.isArray(a.task_types) || a.task_types.length === 0) {
            errors.push('applies_to.task_types must be a non-empty array');
        } else {
            for (const tt of a.task_types) {
                if (!VALID_TASK_TYPES.includes(tt)) {
                    errors.push(`applies_to.task_types contains invalid type: "${tt}"`);
                }
            }
        }

        if (!Array.isArray(a.keywords)) {
            errors.push('applies_to.keywords must be an array');
        } else if (a.keywords.length > MAX_KEYWORDS) {
            warnings.push(
                `applies_to.keywords has ${a.keywords.length} entries (max: ${MAX_KEYWORDS})`,
            );
        }

        if (a.languages && !Array.isArray(a.languages)) {
            errors.push('applies_to.languages must be an array');
        }

        if (a.frameworks && !Array.isArray(a.frameworks)) {
            errors.push('applies_to.frameworks must be an array');
        }

        if (a.repo_patterns && !Array.isArray(a.repo_patterns)) {
            errors.push('applies_to.repo_patterns must be an array');
        }
    }

    private validateInstruction(skill: SkillDoc, errors: string[], warnings: string[]): void {
        const inst = skill.instruction;
        if (!inst) {
            errors.push('Missing required field: instruction');
            return;
        }

        if (!inst.body || typeof inst.body !== 'string') {
            errors.push('instruction.body is required and must be a string');
        } else {
            const maxChars = skill.security?.max_instruction_chars ?? MAX_INSTRUCTION_CHARS;
            if (inst.body.length > maxChars) {
                errors.push(`instruction.body exceeds ${maxChars} chars (${inst.body.length})`);
            }
            if (inst.body.trim().length === 0) {
                errors.push('instruction.body must not be empty');
            }
        }

        if (inst.steps && !Array.isArray(inst.steps)) {
            errors.push('instruction.steps must be an array');
        } else if (inst.steps && inst.steps.length > MAX_STEPS) {
            warnings.push(`instruction.steps has ${inst.steps.length} entries (max: ${MAX_STEPS})`);
        }
    }

    private validateSecurity(skill: SkillDoc, errors: string[], warnings: string[]): void {
        const sec = skill.security;
        if (!sec) {
            errors.push('Missing required field: security');
            return;
        }

        if (!Array.isArray(sec.allowed_tools)) {
            errors.push('security.allowed_tools must be an array');
        } else if (sec.allowed_tools.length > MAX_ALLOWED_TOOLS) {
            warnings.push(
                `security.allowed_tools has ${sec.allowed_tools.length} entries (max: ${MAX_ALLOWED_TOOLS})`,
            );
        }

        if (!Array.isArray(sec.allowed_file_patterns)) {
            errors.push('security.allowed_file_patterns must be an array');
        } else if (sec.allowed_file_patterns.length > MAX_FILE_PATTERNS) {
            warnings.push(
                `security.allowed_file_patterns has ${sec.allowed_file_patterns.length} entries (max: ${MAX_FILE_PATTERNS})`,
            );
        }

        if (typeof sec.max_instruction_chars !== 'number' || sec.max_instruction_chars <= 0) {
            errors.push('security.max_instruction_chars must be a positive number');
        }
    }

    private validateHistory(skill: SkillDoc, errors: string[], _warnings: string[]): void {
        const h = skill.history;
        if (!h) {
            errors.push('Missing required field: history');
            return;
        }

        if (typeof h.total_uses !== 'number') {
            errors.push('history.total_uses must be a number');
        }
        if (typeof h.runs_used_in !== 'number') {
            errors.push('history.runs_used_in must be a number');
        }
        if (!Array.isArray(h.recent_run_ids)) {
            errors.push('history.recent_run_ids must be an array');
        }
        if (typeof h.unused_run_streak !== 'number') {
            errors.push('history.unused_run_streak must be a number');
        }
    }

    /**
     * Runtime security guards — injection detection, URL rejection, etc.
     */
    private runSecurityGuards(skill: SkillDoc, errors: string[], _warnings: string[]): void {
        if (!skill.instruction?.body) {
            return;
        }

        const body = skill.instruction.body;
        const bodyLower = body.toLowerCase();

        // ── Injection phrase detection ──────────────────────────────────────
        for (const phrase of INJECTION_PHRASES) {
            if (bodyLower.includes(phrase.toLowerCase())) {
                errors.push(`SECURITY: Instruction body contains prohibited phrase: "${phrase}"`);
            }
        }

        // ── URL rejection ──────────────────────────────────────────────────
        const urls = body.match(URL_REGEX);
        if (urls && urls.length > 0) {
            errors.push(
                `SECURITY: Instruction body contains URL(s): ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? '...' : ''}`,
            );
        }

        // ── Check steps for injections too ────────────────────────────────
        if (skill.instruction.steps) {
            for (const step of skill.instruction.steps) {
                const stepLower = step.toLowerCase();
                for (const phrase of INJECTION_PHRASES) {
                    if (stepLower.includes(phrase.toLowerCase())) {
                        errors.push(
                            `SECURITY: Instruction step contains prohibited phrase: "${phrase}"`,
                        );
                        break; // One error per step is enough
                    }
                }
                const stepUrls = step.match(URL_REGEX);
                if (stepUrls && stepUrls.length > 0) {
                    errors.push(`SECURITY: Instruction step contains URL(s)`);
                    break;
                }
            }
        }

        // ── Tool allowlist sanity ──────────────────────────────────────────
        if (skill.security?.allowed_tools) {
            const suspiciousTools = skill.security.allowed_tools.filter(
                (t) => t.includes('..') || t.includes('/') || t.includes('\\'),
            );
            if (suspiciousTools.length > 0) {
                errors.push(`SECURITY: Suspicious tool names: ${suspiciousTools.join(', ')}`);
            }
        }

        // ── File pattern sanity ────────────────────────────────────────────
        if (skill.security?.allowed_file_patterns) {
            for (const pattern of skill.security.allowed_file_patterns) {
                // Reject path traversal
                if (pattern.includes('..') || pattern.startsWith('/') || /^[A-Z]:/i.test(pattern)) {
                    errors.push(
                        `SECURITY: File pattern "${pattern}" contains path traversal or absolute path`,
                    );
                }
            }
        }
    }
}
