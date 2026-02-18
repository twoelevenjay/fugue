import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Subtask, SubtaskResult } from './types';

/**
 * Verification result for a subtask.
 */
export interface VerificationResult {
    /** Whether verification passed */
    passed: boolean;
    /** Issues found during verification */
    issues: string[];
    /** Warnings (non-blocking) */
    warnings: string[];
}

/**
 * Verify a subtask result by checking actual filesystem state and exit codes.
 * This provides ground-truth verification, not LLM-based interpretation.
 */
export async function verifySubtaskResult(
    subtask: Subtask,
    result: SubtaskResult,
): Promise<VerificationResult> {
    const issues: string[] = [];
    const warnings: string[] = [];

    // Check exit codes from tool results
    if (result.toolResults) {
        const failures = result.toolResults.filter(
            (t) => t.tool === 'run_in_terminal' && t.exitCode !== undefined && t.exitCode !== 0,
        );

        for (const failure of failures) {
            issues.push(
                `Command failed (exit ${failure.exitCode}): ${failure.command || 'unknown'}`,
            );
        }
    }

    // Parse claimed file creations from output
    const fileCreations = parseFileCreations(result.output);

    // Check if claimed files actually exist
    for (const filePath of fileCreations) {
        // Resolve relative paths against workspace root or worktree
        const resolvedPath = subtask.worktreePath
            ? path.join(subtask.worktreePath, filePath)
            : filePath;

        if (!fs.existsSync(resolvedPath)) {
            issues.push(`File claimed but not found: ${filePath}`);
        }
    }

    // If no tool results and no file checks, warn that verification is limited
    if (!result.toolResults && fileCreations.length === 0) {
        warnings.push('No tool results or file creations to verify - falling back to review');
    }

    return {
        passed: issues.length === 0,
        issues,
        warnings,
    };
}

/**
 * Parse file creation claims from worker output.
 * Looks for file paths in tool responses and summary text.
 */
export function parseFileCreations(output: string): string[] {
    const filePaths: Set<string> = new Set();

    // Pattern 1: Look for "Created: path/to/file.ts" patterns
    const createdPattern =
        /(?:Created|created|Writing|writing|Wrote|wrote):\s*([^\s\n]+\.[a-z]+)/gi;
    let match;
    while ((match = createdPattern.exec(output)) !== null) {
        filePaths.add(match[1]);
    }

    // Pattern 2: Look for file paths in backticks (common in summaries)
    const backtickPattern = /`([^`]+\.[a-z]+)`/g;
    while ((match = backtickPattern.exec(output)) !== null) {
        const maybeFile = match[1];
        // Filter out URLs and code snippets
        if (!maybeFile.includes('://') && !maybeFile.includes(' ')) {
            filePaths.add(maybeFile);
        }
    }

    return Array.from(filePaths);
}

/**
 * Run a verification command and return exit code.
 * Used when subtask specifies a verificationCommand.
 */
export function runVerificationCommand(
    command: string,
    cwd?: string,
): { exitCode: number; output: string } {
    try {
        const output = execSync(command, {
            cwd: cwd || process.cwd(),
            encoding: 'utf-8',
            timeout: 60000, // 1 minute max
            stdio: 'pipe',
        });
        return { exitCode: 0, output };
    } catch (error: any) {
        return {
            exitCode: error.status || 1,
            output: error.stdout || error.stderr || error.message,
        };
    }
}
