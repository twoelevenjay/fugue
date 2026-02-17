/**
 * skillSchema.ts — YAML parsing and serialization for skill files
 *
 * Provides lightweight YAML ↔ SkillDoc conversion without external
 * YAML libraries. Uses a simple recursive YAML parser sufficient for
 * the skill schema's flat/predictable structure.
 *
 * For reading: parses YAML into SkillDoc
 * For writing: serializes SkillDoc to YAML
 */

import {
    SkillDoc,
    SkillMetadata,
    SkillAppliesTo,
    SkillInstruction,
    SkillSecurity,
    SkillHistory,
} from './skillTypes';

// ============================================================================
// YAML → SkillDoc Parser
// ============================================================================

/**
 * Parse a YAML string into a SkillDoc.
 * This is a purpose-built parser for the johann.skill.v1 schema.
 * It handles the specific nested structure we define, not arbitrary YAML.
 *
 * @throws Error if the YAML is structurally invalid
 */
export function parseSkillYaml(yaml: string): SkillDoc {
    const obj = parseSimpleYaml(yaml);

    return {
        schema_version: (obj['schema_version'] as 'johann.skill.v1') ?? 'johann.skill.v1',
        metadata: parseMetadata((obj['metadata'] ?? {}) as Record<string, unknown>),
        applies_to: parseAppliesTo((obj['applies_to'] ?? {}) as Record<string, unknown>),
        instruction: parseInstructionBlock((obj['instruction'] ?? {}) as Record<string, unknown>),
        security: parseSecurityBlock((obj['security'] ?? {}) as Record<string, unknown>),
        history: parseHistoryBlock((obj['history'] ?? {}) as Record<string, unknown>),
    };
}

function parseMetadata(obj: Record<string, unknown>): SkillMetadata {
    return {
        slug: String(obj['slug'] ?? ''),
        version: String(obj['version'] ?? '1.0.0'),
        title: String(obj['title'] ?? ''),
        description: String(obj['description'] ?? ''),
        tags: toStringArray(obj['tags']),
        scope: (obj['scope'] as SkillMetadata['scope']) ?? 'local',
        origin: (obj['origin'] as SkillMetadata['origin']) ?? 'autonomous',
        created_at: String(obj['created_at'] ?? new Date().toISOString()),
        last_used_at: obj['last_used_at'] ? String(obj['last_used_at']) : undefined,
        content_hash: obj['content_hash'] ? String(obj['content_hash']) : undefined,
        source_version: obj['source_version'] ? String(obj['source_version']) : undefined,
        source_hash: obj['source_hash'] ? String(obj['source_hash']) : undefined,
    };
}

function parseAppliesTo(obj: Record<string, unknown>): SkillAppliesTo {
    return {
        task_types: toStringArray(obj['task_types']) as SkillAppliesTo['task_types'],
        languages: obj['languages'] ? toStringArray(obj['languages']) : undefined,
        frameworks: obj['frameworks'] ? toStringArray(obj['frameworks']) : undefined,
        repo_patterns: obj['repo_patterns'] ? toStringArray(obj['repo_patterns']) : undefined,
        keywords: toStringArray(obj['keywords']),
    };
}

function parseInstructionBlock(obj: Record<string, unknown>): SkillInstruction {
    return {
        body: String(obj['body'] ?? ''),
        steps: obj['steps'] ? toStringArray(obj['steps']) : undefined,
        output_format: obj['output_format'] ? String(obj['output_format']) : undefined,
        inputs: obj['inputs'] ? toStringArray(obj['inputs']) : undefined,
    };
}

function parseSecurityBlock(obj: Record<string, unknown>): SkillSecurity {
    return {
        allowed_tools: toStringArray(obj['allowed_tools']),
        allowed_file_patterns: toStringArray(obj['allowed_file_patterns']),
        max_instruction_chars:
            typeof obj['max_instruction_chars'] === 'number' ? obj['max_instruction_chars'] : 8000,
    };
}

function parseHistoryBlock(obj: Record<string, unknown>): SkillHistory {
    return {
        total_uses: typeof obj['total_uses'] === 'number' ? obj['total_uses'] : 0,
        runs_used_in: typeof obj['runs_used_in'] === 'number' ? obj['runs_used_in'] : 0,
        recent_run_ids: toStringArray(obj['recent_run_ids']),
        unused_run_streak:
            typeof obj['unused_run_streak'] === 'number' ? obj['unused_run_streak'] : 0,
    };
}

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((v) => String(v));
    }
    if (typeof value === 'string' && value.trim()) {
        return value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
}

// ============================================================================
// SkillDoc → YAML Serializer
// ============================================================================

/**
 * Serialize a SkillDoc to a YAML string.
 */
export function serializeSkillYaml(skill: SkillDoc): string {
    const lines: string[] = [];

    lines.push(`schema_version: "${skill.schema_version}"`);
    lines.push('');

    // ── metadata ───────────────────────────────────────────────────────
    lines.push('metadata:');
    lines.push(`  slug: "${skill.metadata.slug}"`);
    lines.push(`  version: "${skill.metadata.version}"`);
    lines.push(`  title: "${escapeYaml(skill.metadata.title)}"`);
    lines.push(`  description: "${escapeYaml(skill.metadata.description)}"`);
    lines.push(`  tags:`);
    for (const tag of skill.metadata.tags) {
        lines.push(`    - "${tag}"`);
    }
    lines.push(`  scope: "${skill.metadata.scope}"`);
    lines.push(`  origin: "${skill.metadata.origin}"`);
    lines.push(`  created_at: "${skill.metadata.created_at}"`);
    if (skill.metadata.last_used_at) {
        lines.push(`  last_used_at: "${skill.metadata.last_used_at}"`);
    }
    if (skill.metadata.content_hash) {
        lines.push(`  content_hash: "${skill.metadata.content_hash}"`);
    }
    if (skill.metadata.source_version) {
        lines.push(`  source_version: "${skill.metadata.source_version}"`);
    }
    if (skill.metadata.source_hash) {
        lines.push(`  source_hash: "${skill.metadata.source_hash}"`);
    }
    lines.push('');

    // ── applies_to ─────────────────────────────────────────────────────
    lines.push('applies_to:');
    lines.push('  task_types:');
    for (const tt of skill.applies_to.task_types) {
        lines.push(`    - "${tt}"`);
    }
    if (skill.applies_to.languages && skill.applies_to.languages.length > 0) {
        lines.push('  languages:');
        for (const lang of skill.applies_to.languages) {
            lines.push(`    - "${lang}"`);
        }
    }
    if (skill.applies_to.frameworks && skill.applies_to.frameworks.length > 0) {
        lines.push('  frameworks:');
        for (const fw of skill.applies_to.frameworks) {
            lines.push(`    - "${fw}"`);
        }
    }
    if (skill.applies_to.repo_patterns && skill.applies_to.repo_patterns.length > 0) {
        lines.push('  repo_patterns:');
        for (const rp of skill.applies_to.repo_patterns) {
            lines.push(`    - "${rp}"`);
        }
    }
    lines.push('  keywords:');
    for (const kw of skill.applies_to.keywords) {
        lines.push(`    - "${kw}"`);
    }
    lines.push('');

    // ── instruction ────────────────────────────────────────────────────
    lines.push('instruction:');
    lines.push(`  body: |`);
    for (const bodyLine of skill.instruction.body.split('\n')) {
        lines.push(`    ${bodyLine}`);
    }
    if (skill.instruction.steps && skill.instruction.steps.length > 0) {
        lines.push('  steps:');
        for (const step of skill.instruction.steps) {
            lines.push(`    - "${escapeYaml(step)}"`);
        }
    }
    if (skill.instruction.output_format) {
        lines.push(`  output_format: "${escapeYaml(skill.instruction.output_format)}"`);
    }
    if (skill.instruction.inputs && skill.instruction.inputs.length > 0) {
        lines.push('  inputs:');
        for (const inp of skill.instruction.inputs) {
            lines.push(`    - "${escapeYaml(inp)}"`);
        }
    }
    lines.push('');

    // ── security ───────────────────────────────────────────────────────
    lines.push('security:');
    lines.push('  allowed_tools:');
    for (const tool of skill.security.allowed_tools) {
        lines.push(`    - "${tool}"`);
    }
    lines.push('  allowed_file_patterns:');
    for (const fp of skill.security.allowed_file_patterns) {
        lines.push(`    - "${fp}"`);
    }
    lines.push(`  max_instruction_chars: ${skill.security.max_instruction_chars}`);
    lines.push('');

    // ── history ────────────────────────────────────────────────────────
    lines.push('history:');
    lines.push(`  total_uses: ${skill.history.total_uses}`);
    lines.push(`  runs_used_in: ${skill.history.runs_used_in}`);
    lines.push('  recent_run_ids:');
    for (const rid of skill.history.recent_run_ids) {
        lines.push(`    - "${rid}"`);
    }
    lines.push(`  unused_run_streak: ${skill.history.unused_run_streak}`);

    return lines.join('\n') + '\n';
}

/**
 * Escape special characters for YAML double-quoted strings.
 */
function escapeYaml(s: string): string {
    return s
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

// ============================================================================
// Simple YAML Parser
// ============================================================================

/**
 * Parse a simple YAML document into a nested object.
 *
 * Supports:
 * - Key-value pairs (string, number, boolean)
 * - Nested objects via indentation
 * - Arrays via "- " syntax
 * - Quoted strings (single and double)
 * - Block scalars (| and >)
 * - Comments (# ...)
 *
 * Does NOT support:
 * - Anchors & aliases
 * - Multi-document streams
 * - Flow sequences/mappings
 * - Complex keys
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
    const lines = yaml.split('\n');
    const result: Record<string, unknown> = {};
    const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [
        { obj: result, indent: -1 },
    ];

    let i = 0;
    while (i < lines.length) {
        const rawLine = lines[i];
        const trimmed = rawLine.replace(/#.*$/, '').trimEnd(); // Strip comments

        // Skip empty lines
        if (trimmed.trim() === '') {
            i++;
            continue;
        }

        const indent = rawLine.search(/\S/);
        if (indent < 0) {
            i++;
            continue;
        }

        // Pop stack to find parent at correct indent level
        while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
            stack.pop();
        }
        const parent = stack[stack.length - 1].obj;

        const content = trimmed.trim();

        // Array item: "- value" or "- key: value"
        if (content.startsWith('- ')) {
            const parentKey = findParentKeyForArray(lines, i, indent);
            if (parentKey && parent[parentKey] === undefined) {
                parent[parentKey] = [];
            }
            const arr = parentKey ? parent[parentKey] : undefined;
            if (Array.isArray(arr)) {
                const itemValue = content.substring(2).trim();
                arr.push(parseYamlValue(itemValue));
            }
            i++;
            continue;
        }

        // Key-value pair: "key: value" or "key:"
        const kvMatch = content.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)?$/);
        if (kvMatch) {
            const key = kvMatch[1];
            const rawValue = (kvMatch[2] ?? '').trim();

            if (rawValue === '' || rawValue === '|' || rawValue === '>') {
                // Block scalar or nested object
                if (rawValue === '|' || rawValue === '>') {
                    // Block scalar — read indented lines
                    const blockIndent = indent + 2; // Expect at least +2 indent
                    const blockLines: string[] = [];
                    let j = i + 1;
                    while (j < lines.length) {
                        const bl = lines[j];
                        const blIndent = bl.search(/\S/);
                        if (bl.trim() === '') {
                            blockLines.push('');
                            j++;
                            continue;
                        }
                        if (blIndent >= blockIndent) {
                            blockLines.push(bl.substring(blockIndent));
                            j++;
                        } else {
                            break;
                        }
                    }
                    // Trim trailing empty lines
                    while (
                        blockLines.length > 0 &&
                        blockLines[blockLines.length - 1].trim() === ''
                    ) {
                        blockLines.pop();
                    }
                    parent[key] = blockLines.join(rawValue === '|' ? '\n' : ' ');
                    i = j;
                    continue;
                }

                // Check if next line is an array or nested object
                const nextLineIdx = findNextNonEmpty(lines, i + 1);
                if (nextLineIdx < lines.length) {
                    const nextContent = lines[nextLineIdx].trim();
                    if (nextContent.startsWith('- ')) {
                        // It's an array container
                        parent[key] = [];
                        stack.push({ obj: parent, indent });
                    } else {
                        // It's a nested object
                        const nested: Record<string, unknown> = {};
                        parent[key] = nested;
                        stack.push({ obj: nested, indent });
                    }
                }
            } else {
                // Simple value
                parent[key] = parseYamlValue(rawValue);
            }
        }

        i++;
    }

    return result;
}

/**
 * Parse a YAML scalar value (string, number, boolean, null).
 */
function parseYamlValue(raw: string): unknown {
    if (!raw) {
        return '';
    }

    // Quoted string
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw
            .slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }

    // Boolean
    if (raw === 'true') {
        return true;
    }
    if (raw === 'false') {
        return false;
    }

    // Null
    if (raw === 'null' || raw === '~') {
        return null;
    }

    // Number
    const num = Number(raw);
    if (!isNaN(num) && raw !== '') {
        return num;
    }

    // Plain string
    return raw;
}

/**
 * Walk backwards from an array item to find which key "owns" it.
 */
function findParentKeyForArray(
    lines: string[],
    idx: number,
    itemIndent: number,
): string | undefined {
    for (let j = idx - 1; j >= 0; j--) {
        const line = lines[j].replace(/#.*$/, '').trimEnd();
        if (line.trim() === '') {
            continue;
        }
        const lineIndent = lines[j].search(/\S/);
        if (lineIndent < itemIndent) {
            const match = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
            if (match) {
                return match[1];
            }
            // Also match "key:" with nothing after — parent key for this array
            const kvMatch = line.trim().match(/^([a-zA-Z_][a-zA-Z0-9_]*):/);
            if (kvMatch) {
                return kvMatch[1];
            }
            return undefined;
        }
    }
    return undefined;
}

/**
 * Find next non-empty line index.
 */
function findNextNonEmpty(lines: string[], start: number): number {
    for (let i = start; i < lines.length; i++) {
        if (lines[i].trim() !== '') {
            return i;
        }
    }
    return lines.length;
}
