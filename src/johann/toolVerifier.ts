// ============================================================================
// TOOL VERIFIER — Run automated checks as oracles for code quality
//
// Provides "truth signal" for code generation and repair loops.
// Runs: compilation, type checking, linting, tests, formatting.
//
// This is the highest-value multi-pass pattern because tools provide
// deterministic, objective feedback that's better than model guessing.
// ============================================================================

import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process'; // eslint-disable-line no-restricted-imports -- Required: runs verification tools (npm, tsc, etc.)
import { JohannLogger, getLogger } from './logger';

/**
 * Result from running a verification check.
 */
export interface VerificationResult {
    /** Check that was run */
    check: 'compile' | 'typecheck' | 'lint' | 'test' | 'format';

    /** Whether the check passed */
    passed: boolean;

    /** Error output if failed */
    errors?: string[];

    /** Exit code from the tool */
    exitCode?: number;

    /** Full output (stdout + stderr) */
    output: string;

    /** Time taken in ms */
    timeMs: number;
}

/**
 * Configuration for verification checks.
 */
export interface VerificationConfig {
    /** Which checks to run */
    checks: Array<'compile' | 'typecheck' | 'lint' | 'test' | 'format'>;

    /** Stop on first failure */
    failFast: boolean;

    /** Timeout per check in ms */
    timeoutPerCheck: number;

    /** Working directory */
    cwd: string;
}

export class ToolVerifier {
    private logger: JohannLogger;

    constructor(logger: JohannLogger) {
        this.logger = logger;
    }

    /**
     * Run all configured verification checks.
     */
    async verify(
        config: VerificationConfig,
        modifiedFiles?: string[]
    ): Promise<{
        allPassed: boolean;
        results: VerificationResult[];
        summary: string;
    }> {
        const results: VerificationResult[] = [];
        let allPassed = true;

        for (const check of config.checks) {
            this.logger.debug(`Running check: ${check}`);

            const result = await this.runCheck(check, config, modifiedFiles);
            results.push(result);

            if (!result.passed) {
                allPassed = false;
                if (config.failFast) {
                    break;
                }
            }
        }

        const summary = this.summarizeResults(results);

        return { allPassed, results, summary };
    }

    /**
     * Run a single verification check.
     */
    private async runCheck(
        check: 'compile' | 'typecheck' | 'lint' | 'test' | 'format',
        config: VerificationConfig,
        modifiedFiles?: string[]
    ): Promise<VerificationResult> {
        const startTime = Date.now();

        try {
            switch (check) {
                case 'compile':
                    return await this.runCompile(config, startTime);
                case 'typecheck':
                    return await this.runTypecheck(config, startTime);
                case 'lint':
                    return await this.runLint(config, modifiedFiles, startTime);
                case 'test':
                    return await this.runTests(config, modifiedFiles, startTime);
                case 'format':
                    return await this.runFormat(config, modifiedFiles, startTime);
                default:
                    return {
                        check,
                        passed: false,
                        output: `Unknown check: ${check}`,
                        timeMs: Date.now() - startTime,
                    };
            }
        } catch (error) {
            this.logger.error(`Check ${check} failed with exception: ${error}`);
            return {
                check,
                passed: false,
                errors: [String(error)],
                output: String(error),
                timeMs: Date.now() - startTime,
            };
        }
    }

    /**
     * Run compilation check.
     * Tries common build commands: npm run build, tsc, gradle build, mvn compile.
     */
    private async runCompile(
        config: VerificationConfig,
        startTime: number
    ): Promise<VerificationResult> {
        // Check for package.json build script
        const packageJsonPath = path.join(config.cwd, 'package.json');
        try {
            const packageJson = JSON.parse(
                await vscode.workspace.fs.readFile(vscode.Uri.file(packageJsonPath)).then(
                    buf => Buffer.from(buf).toString('utf8')
                )
            );

            if (packageJson.scripts?.compile) {
                return await this.runCommand('npm', ['run', 'compile'], config, startTime, 'compile');
            } else if (packageJson.scripts?.build) {
                return await this.runCommand('npm', ['run', 'build'], config, startTime, 'compile');
            }
        } catch {
            // package.json doesn't exist or can't be read
        }

        // Try tsc directly (TypeScript)
        if (await this.fileExists(path.join(config.cwd, 'tsconfig.json'))) {
            return await this.runCommand('npx', ['tsc', '--noEmit'], config, startTime, 'compile');
        }

        // Try other common build tools
        // TODO: Add gradle, maven, cargo, etc.

        return {
            check: 'compile',
            passed: true, // No build system found = nothing to compile
            output: 'No build configuration found, skipping compilation check',
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Run type checking.
     * Uses TypeScript tsc or other type checkers.
     */
    private async runTypecheck(
        config: VerificationConfig,
        startTime: number
    ): Promise<VerificationResult> {
        // TypeScript
        if (await this.fileExists(path.join(config.cwd, 'tsconfig.json'))) {
            return await this.runCommand('npx', ['tsc', '--noEmit'], config, startTime, 'typecheck');
        }

        // Python (mypy)
        if (await this.fileExists(path.join(config.cwd, 'mypy.ini')) ||
            await this.fileExists(path.join(config.cwd, 'setup.cfg'))) {
            return await this.runCommand('mypy', ['.'], config, startTime, 'typecheck');
        }

        return {
            check: 'typecheck',
            passed: true,
            output: 'No type checker configuration found',
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Run linting.
     */
    private async runLint(
        config: VerificationConfig,
        modifiedFiles: string[] | undefined,
        startTime: number
    ): Promise<VerificationResult> {
        // ESLint
        if (await this.fileExists(path.join(config.cwd, '.eslintrc.json')) ||
            await this.fileExists(path.join(config.cwd, '.eslintrc.js')) ||
            await this.fileExists(path.join(config.cwd, 'eslint.config.mjs'))) {

            const args = ['eslint'];
            if (modifiedFiles && modifiedFiles.length > 0) {
                args.push(...modifiedFiles);
            } else {
                args.push('.');
            }

            return await this.runCommand('npx', args, config, startTime, 'lint');
        }

        // Python (ruff, flake8, pylint)
        if (await this.fileExists(path.join(config.cwd, 'ruff.toml')) ||
            await this.fileExists(path.join(config.cwd, '.ruff.toml'))) {
            return await this.runCommand('ruff', ['check', '.'], config, startTime, 'lint');
        }

        return {
            check: 'lint',
            passed: true,
            output: 'No linter configuration found',
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Run tests.
     */
    private async runTests(
        config: VerificationConfig,
        modifiedFiles: string[] | undefined,
        startTime: number
    ): Promise<VerificationResult> {
        // Check for test script in package.json
        const packageJsonPath = path.join(config.cwd, 'package.json');
        try {
            const packageJson = JSON.parse(
                await vscode.workspace.fs.readFile(vscode.Uri.file(packageJsonPath)).then(
                    buf => Buffer.from(buf).toString('utf8')
                )
            );

            if (packageJson.scripts?.test) {
                return await this.runCommand('npm', ['test'], config, startTime, 'test');
            }
        } catch {
            // No package.json
        }

        // Try pytest (Python)
        if (await this.fileExists(path.join(config.cwd, 'pytest.ini')) ||
            await this.fileExists(path.join(config.cwd, 'pyproject.toml'))) {
            return await this.runCommand('pytest', [], config, startTime, 'test');
        }

        return {
            check: 'test',
            passed: true,
            output: 'No test configuration found',
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Run formatting check.
     */
    private async runFormat(
        config: VerificationConfig,
        modifiedFiles: string[] | undefined,
        startTime: number
    ): Promise<VerificationResult> {
        // Prettier
        if (await this.fileExists(path.join(config.cwd, '.prettierrc'))) {
            const args = ['prettier', '--check'];
            if (modifiedFiles && modifiedFiles.length > 0) {
                args.push(...modifiedFiles);
            } else {
                args.push('.');
            }
            return await this.runCommand('npx', args, config, startTime, 'format');
        }

        // Python (black, ruff format)
        if (await this.fileExists(path.join(config.cwd, 'pyproject.toml'))) {
            return await this.runCommand('black', ['--check', '.'], config, startTime, 'format');
        }

        return {
            check: 'format',
            passed: true,
            output: 'No formatter configuration found',
            timeMs: Date.now() - startTime,
        };
    }

    /**
     * Run a verification command and return standardized result.
     *
     * SECURITY: Uses execFile (not exec/spawn+shell) to avoid shell injection.
     * Commands are always one of a fixed set: npm, npx, tsc, etc.
     * Arguments are passed as an array, never interpolated into a shell string.
     */
    private async runCommand(
        command: string,
        args: string[],
        config: VerificationConfig,
        startTime: number,
        check: 'compile' | 'typecheck' | 'lint' | 'test' | 'format'
    ): Promise<VerificationResult> {
        return new Promise((resolve) => {
            const proc = execFile(command, args, {
                cwd: config.cwd,
                timeout: config.timeoutPerCheck,
                maxBuffer: 1024 * 1024, // 1MB output cap
            }, (error, stdout, stderr) => {
                const output = `${stdout}\n${stderr}`.trim();
                const exitCode = error ? (error as any).code ?? 1 : 0;
                const passed = exitCode === 0;

                const errors = passed ? undefined : this.extractErrors(output, check);

                resolve({
                    check,
                    passed,
                    errors,
                    exitCode,
                    output,
                    timeMs: Date.now() - startTime,
                });
            });

            proc.on('error', (err: Error) => {
                resolve({
                    check,
                    passed: false,
                    errors: [err.message],
                    output: err.message,
                    timeMs: Date.now() - startTime,
                });
            });
        });
    }

    /**
     * Extract relevant error messages from tool output.
     */
    private extractErrors(output: string, check: string): string[] {
        const lines = output.split('\n');
        const errors: string[] = [];

        for (const line of lines) {
            // Look for common error patterns
            if (
                line.includes('error') ||
                line.includes('Error') ||
                line.includes('ERROR') ||
                line.includes('✖') ||
                line.includes('✗') ||
                line.includes('FAIL')
            ) {
                errors.push(line.trim());
            }
        }

        // Limit to the most relevant errors
        return errors.slice(0, 10);
    }

    /**
     * Check if a file exists.
     */
    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Summarize verification results for LLM feedback.
     */
    private summarizeResults(results: VerificationResult[]): string {
        const lines: string[] = ['## Verification Results\n'];

        const passed = results.filter(r => r.passed);
        const failed = results.filter(r => !r.passed);

        if (failed.length === 0) {
            lines.push('✅ All checks passed!\n');
        } else {
            lines.push(`❌ ${failed.length} check(s) failed:\n`);

            for (const result of failed) {
                lines.push(`\n### ${result.check} (exit code ${result.exitCode})\n`);

                if (result.errors && result.errors.length > 0) {
                    lines.push('**Errors:**');
                    result.errors.forEach(err => lines.push(`- ${err}`));
                } else {
                    // Show truncated output if no specific errors extracted
                    const truncated = result.output.slice(0, 500);
                    lines.push(`\`\`\`\n${truncated}\n\`\`\``);
                }
            }
        }

        if (passed.length > 0) {
            lines.push(`\n✅ Passed: ${passed.map(r => r.check).join(', ')}`);
        }

        return lines.join('\n');
    }

    /**
     * Create a repair loop that iterates until checks pass or max iterations reached.
     */
    async repairLoop(
        config: VerificationConfig,
        modifiedFiles: string[],
        onRepair: (errors: string) => Promise<{ newCode: string; applied: boolean }>,
        maxIterations: number = 3
    ): Promise<{
        succeeded: boolean;
        iterations: number;
        finalResult: {
            allPassed: boolean;
            results: VerificationResult[];
            summary: string;
        } | null;
        shouldEscalate: boolean;
        escalationReason?: string;
    }> {
        let iterations = 0;
        let lastResult: { allPassed: boolean; results: VerificationResult[]; summary: string } | null = null;
        let lastErrors: string = '';

        while (iterations < maxIterations) {
            iterations++;
            this.logger.info(`Repair loop iteration ${iterations}/${maxIterations}`);

            // Run verification
            const result = await this.verify(config, modifiedFiles);
            lastResult = result;

            if (result.allPassed) {
                // Success!
                return {
                    succeeded: true,
                    iterations,
                    finalResult: result,
                    shouldEscalate: false,
                };
            }

            // Check if we're making progress
            const currentErrors = result.summary;
            if (iterations > 1 && currentErrors === lastErrors) {
                // No progress - same errors
                return {
                    succeeded: false,
                    iterations,
                    finalResult: result,
                    shouldEscalate: true,
                    escalationReason: 'Same errors persist across iterations (no progress)',
                };
            }
            lastErrors = currentErrors;

            // Ask for repair (unless this is the last iteration)
            if (iterations < maxIterations) {
                try {
                    const repairResult = await onRepair(result.summary);
                    if (!repairResult.applied) {
                        // Repair failed to apply
                        return {
                            succeeded: false,
                            iterations,
                            finalResult: result,
                            shouldEscalate: true,
                            escalationReason: 'Failed to apply repair',
                        };
                    }
                } catch (error) {
                    return {
                        succeeded: false,
                        iterations,
                        finalResult: result,
                        shouldEscalate: true,
                        escalationReason: `Repair generation failed: ${error}`,
                    };
                }
            }
        }

        // Max iterations reached without success
        return {
            succeeded: false,
            iterations,
            finalResult: lastResult,
            shouldEscalate: true,
            escalationReason: `Failed after ${maxIterations} repair iterations`,
        };
    }
}
