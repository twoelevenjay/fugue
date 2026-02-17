/**
 * skillLedger.ts — Skill invocation logging for auditability
 *
 * Every skill invocation is logged to a JSONL file:
 *   .vscode/johann/sessions/<sessionId>/skill-invocations.jsonl
 *
 * Each entry records:
 * - run_id, skill_id, version, hash
 * - inputs, files_touched, tools_used
 * - success/failure, verification notes
 *
 * Integrates with the existing ExecutionLedger pattern (append-only JSONL).
 * Uses safeAppend for concurrency safety during parallel subtasks.
 */

import * as vscode from 'vscode';
import { SkillDoc, SkillInvocation } from './skillTypes';
import { safeAppend } from './safeIO';
import { getLogger } from './logger';

// ============================================================================
// Skill Invocation Logger
// ============================================================================

export class SkillLedger {
    private sessionDir: vscode.Uri | undefined;
    private invocations: SkillInvocation[] = [];
    private logger = getLogger();

    /**
     * Initialize with a session directory.
     * Creates the invocations file if it doesn't exist.
     */
    async initialize(sessionDir: vscode.Uri): Promise<void> {
        this.sessionDir = sessionDir;
    }

    /**
     * Log a skill invocation.
     */
    async logInvocation(invocation: SkillInvocation): Promise<void> {
        this.invocations.push(invocation);

        if (this.sessionDir) {
            const fileUri = vscode.Uri.joinPath(this.sessionDir, 'skill-invocations.jsonl');
            const line = JSON.stringify(invocation) + '\n';
            try {
                await safeAppend(fileUri, line, '', false);
            } catch (err) {
                this.logger.warn(
                    `Failed to log skill invocation: ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        }
    }

    /**
     * Create an invocation record from a skill and execution context.
     */
    createInvocationRecord(
        runId: string,
        skill: SkillDoc,
        inputs: string,
        success: boolean,
        filesTouched?: string[],
        toolsUsed?: string[],
        verificationNotes?: string,
    ): SkillInvocation {
        return {
            run_id: runId,
            skill_id: skill.metadata.slug,
            version: skill.metadata.version,
            hash: skill.metadata.content_hash || '',
            scope: skill.metadata.scope,
            inputs: inputs.substring(0, 500), // Cap input logging
            files_touched: filesTouched ?? [],
            tools_used: toolsUsed ?? [],
            success,
            verification_notes: verificationNotes,
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Get all invocations logged this run.
     */
    getRunInvocations(): readonly SkillInvocation[] {
        return this.invocations;
    }

    /**
     * Get the set of skill slugs used in this run.
     */
    getUsedSlugs(): Set<string> {
        return new Set(this.invocations.map((i) => i.skill_id));
    }

    /**
     * Get usage count for a specific skill in this run.
     */
    getUsageCount(slug: string): number {
        return this.invocations.filter((i) => i.skill_id === slug).length;
    }

    /**
     * Get all invocations from a previous session (read from disk).
     */
    static async loadFromSession(sessionDir: vscode.Uri): Promise<SkillInvocation[]> {
        const fileUri = vscode.Uri.joinPath(sessionDir, 'skill-invocations.jsonl');
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri);
            const content = new TextDecoder().decode(bytes);
            return content
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => {
                    try {
                        return JSON.parse(line) as SkillInvocation;
                    } catch {
                        return null;
                    }
                })
                .filter((inv): inv is SkillInvocation => inv !== null);
        } catch {
            return [];
        }
    }

    /**
     * Build a compact summary of skill usage in this run.
     * Suitable for injection into end-of-run reports.
     */
    buildRunSummary(): string {
        if (this.invocations.length === 0) {
            return 'No skills were invoked in this run.';
        }

        const bySlug = new Map<string, { count: number; version: string; successes: number }>();

        for (const inv of this.invocations) {
            const existing = bySlug.get(inv.skill_id);
            if (existing) {
                existing.count++;
                if (inv.success) {
                    existing.successes++;
                }
            } else {
                bySlug.set(inv.skill_id, {
                    count: 1,
                    version: inv.version,
                    successes: inv.success ? 1 : 0,
                });
            }
        }

        const lines: string[] = ['### Skill Usage This Run'];
        lines.push('| Skill | Version | Invocations | Success Rate |');
        lines.push('|-------|---------|-------------|--------------|');

        for (const [slug, stats] of bySlug.entries()) {
            const rate = stats.count > 0 ? ((stats.successes / stats.count) * 100).toFixed(0) : '0';
            lines.push(`| ${slug} | ${stats.version} | ${stats.count} | ${rate}% |`);
        }

        return lines.join('\n');
    }
}
