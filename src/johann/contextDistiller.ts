/**
 * contextDistiller.ts — Structured Output Extraction & Context Distillation
 *
 * Inspired by the CLI System's structured summary extraction and OpenClaw's
 * pre-compaction memory patterns.
 *
 * Subagent outputs are parsed for a ```summary block, extracting structured
 * metadata. When building prompts for downstream tasks, the distiller
 * produces compact context strings instead of dumping raw (multi-KB) output.
 *
 * This keeps token growth linear O(n) rather than exponential O(2^n) as
 * dependency chains deepen.
 */

import { OrchestrationPlan, SubtaskResult } from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * Structured metadata extracted from a subagent's output.
 */
export interface StructuredSummary {
    /** What the subagent accomplished (1-2 sentences) */
    completed: string;
    /** Relative file paths modified */
    filesModified: string[];
    /** Exported identifiers created or modified */
    keyExports: string[];
    /** Packages / dependencies installed */
    dependenciesInstalled: string[];
    /** Key terminal commands that were run */
    commandsRun: string[];
    /** Freeform notes for downstream tasks */
    notes: string;
    /** Full raw output preserved as fallback */
    raw: string;
}

// ============================================================================
// Summary Block Prompt Fragment
// ============================================================================

/**
 * Instruction block to append to every subagent prompt.
 * Tells the model to emit a ```summary section at the end of its output.
 */
export const SUMMARY_BLOCK_INSTRUCTION = `

=== OUTPUT REQUIREMENTS ===
After completing your work, you MUST append a structured summary block at the very end of your response.
Use exactly this format (do NOT omit any field — use "none" or empty if not applicable):

\`\`\`summary
COMPLETED: <1-2 sentence description of what was accomplished>
FILES_MODIFIED: <comma-separated relative file paths, or "none">
KEY_EXPORTS: <comma-separated exported identifiers created/modified, or "none">
DEPENDENCIES_INSTALLED: <comma-separated package names, or "none">
COMMANDS_RUN: <comma-separated key terminal commands, or "none">
NOTES: <anything downstream tasks should know, or "none">
\`\`\`

This summary will be used by other tasks that depend on your work.
`;

// ============================================================================
// Extraction
// ============================================================================

/**
 * Extract a StructuredSummary from a subagent's raw output.
 *
 * If the output contains a ```summary block, it is parsed structurally.
 * If not, a best-effort fallback is produced from the raw text.
 */
export function extractSummary(rawOutput: string): StructuredSummary {
    const fallback: StructuredSummary = {
        completed: '',
        filesModified: [],
        keyExports: [],
        dependenciesInstalled: [],
        commandsRun: [],
        notes: '',
        raw: rawOutput,
    };

    // Try to find ```summary ... ``` block
    const summaryMatch = rawOutput.match(/```summary\s*\n([\s\S]*?)```/);
    if (!summaryMatch) {
        // No structured block — try to produce a fallback from the raw output
        return buildFallbackSummary(rawOutput);
    }

    const block = summaryMatch[1];

    function extractField(fieldName: string): string {
        const re = new RegExp(`^${fieldName}:\\s*(.*)$`, 'mi');
        const match = block.match(re);
        return match?.[1]?.trim() ?? '';
    }

    function splitList(value: string): string[] {
        if (!value || value.toLowerCase() === 'none') {
            return [];
        }
        return value
            .split(',')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }

    return {
        completed: extractField('COMPLETED') || 'Completed (no details provided)',
        filesModified: splitList(extractField('FILES_MODIFIED')),
        keyExports: splitList(extractField('KEY_EXPORTS')),
        dependenciesInstalled: splitList(extractField('DEPENDENCIES_INSTALLED')),
        commandsRun: splitList(extractField('COMMANDS_RUN')),
        notes: (() => {
            const n = extractField('NOTES');
            return (n && n.toLowerCase() !== 'none') ? n : '';
        })(),
        raw: rawOutput,
    };
}

/**
 * Fallback summary when the model didn't emit a ```summary block.
 * Heuristically extracts file paths and produces a basic description.
 */
function buildFallbackSummary(raw: string): StructuredSummary {
    // Extract file paths mentioned in tool calls or markdown
    const filePathRegex = /(?:creating|editing|modified|created|wrote|reading|read)\s+(?:file\s+)?[`"]?([a-zA-Z0-9_/.\-]+\.[a-zA-Z]{1,6})[`"]?/gi;
    const files: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = filePathRegex.exec(raw)) !== null) {
        if (!files.includes(m[1])) {
            files.push(m[1]);
        }
    }

    // First non-empty paragraph as summary
    const firstParagraph = raw
        .split('\n\n')
        .map(p => p.trim())
        .find(p => p.length > 10 && !p.startsWith('```') && !p.startsWith('>'));

    return {
        completed: firstParagraph
            ? firstParagraph.substring(0, 200)
            : 'Completed (summary block not provided)',
        filesModified: files,
        keyExports: [],
        dependenciesInstalled: [],
        commandsRun: [],
        notes: '',
        raw,
    };
}

// ============================================================================
// Distillation
// ============================================================================

/**
 * Distill a StructuredSummary into a compact context string for downstream
 * tasks. Much smaller than piping the full raw output.
 *
 * @param summary  The structured summary to distill
 * @param maxChars Maximum character budget for the distilled context (default 500)
 */
export function distillContext(summary: StructuredSummary, maxChars: number = 500): string {
    const parts: string[] = [];

    parts.push(`Completed: ${summary.completed}`);

    if (summary.filesModified.length > 0) {
        parts.push(`Files: ${summary.filesModified.join(', ')}`);
    }

    if (summary.keyExports.length > 0) {
        parts.push(`Exports: ${summary.keyExports.join(', ')}`);
    }

    if (summary.dependenciesInstalled.length > 0) {
        parts.push(`Dependencies added: ${summary.dependenciesInstalled.join(', ')}`);
    }

    if (summary.notes) {
        parts.push(`Notes: ${summary.notes}`);
    }

    let result = parts.join('\n');

    // Trim to budget
    if (result.length > maxChars) {
        result = result.substring(0, maxChars - 3) + '...';
    }

    return result;
}

/**
 * Gather distilled dependency context for a task.
 *
 * Walks the task's `dependsOn` list, extracts structured summaries from
 * their results, distills each, and concatenates them. Result is a compact
 * string ready to inject into the downstream subagent's prompt.
 *
 * @param taskId   The task that is about to execute
 * @param plan     The orchestration plan
 * @param results  Map of completed subtask results
 * @param maxCharsPerDep  Character budget per dependency summary
 */
export function gatherDependencyContext(
    taskId: string,
    plan: OrchestrationPlan,
    results: Map<string, SubtaskResult>,
    maxCharsPerDep: number = 400,
): string {
    const subtask = plan.subtasks.find(st => st.id === taskId);
    if (!subtask || subtask.dependsOn.length === 0) {
        return '';
    }

    const sections: string[] = [];

    for (const depId of subtask.dependsOn) {
        const depResult = results.get(depId);
        if (!depResult || !depResult.success) {
            continue;
        }

        const depSubtask = plan.subtasks.find(st => st.id === depId);
        const label = depSubtask?.title ?? depId;

        const summary = extractSummary(depResult.output);
        const distilled = distillContext(summary, maxCharsPerDep);

        sections.push(`[${label}]\n${distilled}`);
    }

    if (sections.length === 0) {
        return '';
    }

    return '=== DEPENDENCY CONTEXT (distilled) ===\n' + sections.join('\n\n') + '\n';
}
