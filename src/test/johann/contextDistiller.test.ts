import * as assert from 'assert';
import {
    extractSummary,
    distillContext,
    gatherDependencyContext,
    StructuredSummary,
} from '../../johann/contextDistiller';
import { OrchestrationPlan, Subtask, SubtaskResult } from '../../johann/types';

suite('contextDistiller', () => {
    // ================================================================
    // extractSummary
    // ================================================================

    suite('extractSummary', () => {
        test('parses well-formed summary block', () => {
            const output = `I created the files.\n\n\`\`\`summary
COMPLETED: Created user model and routes
FILES_MODIFIED: src/models/user.ts, src/routes/users.ts
KEY_EXPORTS: User, UserRouter
DEPENDENCIES_INSTALLED: express, better-sqlite3
COMMANDS_RUN: npm install express
NOTES: Uses UUID for primary key
\`\`\``;

            const summary = extractSummary(output);
            assert.strictEqual(summary.completed, 'Created user model and routes');
            assert.deepStrictEqual(summary.filesModified, [
                'src/models/user.ts',
                'src/routes/users.ts',
            ]);
            assert.deepStrictEqual(summary.keyExports, ['User', 'UserRouter']);
            assert.deepStrictEqual(summary.dependenciesInstalled, ['express', 'better-sqlite3']);
            assert.deepStrictEqual(summary.commandsRun, ['npm install express']);
            assert.strictEqual(summary.notes, 'Uses UUID for primary key');
            assert.ok(summary.raw.length > 0);
        });

        test('handles "none" fields correctly', () => {
            const output = `Done.\n\n\`\`\`summary
COMPLETED: Updated config
FILES_MODIFIED: config.json
KEY_EXPORTS: none
DEPENDENCIES_INSTALLED: none
COMMANDS_RUN: none
NOTES: none
\`\`\``;

            const summary = extractSummary(output);
            assert.strictEqual(summary.completed, 'Updated config');
            assert.deepStrictEqual(summary.filesModified, ['config.json']);
            assert.deepStrictEqual(summary.keyExports, []);
            assert.deepStrictEqual(summary.dependenciesInstalled, []);
            assert.deepStrictEqual(summary.commandsRun, []);
            assert.strictEqual(summary.notes, '');
        });

        test('falls back gracefully when no summary block', () => {
            const output =
                'I created the file src/app.ts and modified src/index.ts. Everything works.';
            const summary = extractSummary(output);
            assert.ok(summary.completed.length > 0);
            // Fallback should extract file paths heuristically
            assert.ok(summary.raw === output);
        });

        test('handles empty input', () => {
            const summary = extractSummary('');
            assert.ok(summary.completed.length > 0);
            assert.strictEqual(summary.raw, '');
        });
    });

    // ================================================================
    // distillContext
    // ================================================================

    suite('distillContext', () => {
        test('produces compact output from summary', () => {
            const summary: StructuredSummary = {
                completed: 'Built the API layer',
                filesModified: ['src/api.ts', 'src/routes.ts'],
                keyExports: ['ApiRouter'],
                dependenciesInstalled: ['express'],
                commandsRun: [],
                notes: 'Listens on port 3000',
                raw: 'very long raw output...',
            };

            const distilled = distillContext(summary);
            assert.ok(distilled.includes('Built the API layer'));
            assert.ok(distilled.includes('src/api.ts'));
            assert.ok(distilled.includes('ApiRouter'));
            assert.ok(distilled.includes('express'));
            assert.ok(distilled.includes('port 3000'));
            // Should NOT include raw output
            assert.ok(!distilled.includes('very long raw output'));
        });

        test('respects character budget', () => {
            const summary: StructuredSummary = {
                completed: 'A'.repeat(300),
                filesModified: Array.from({ length: 50 }, (_, i) => `file${i}.ts`),
                keyExports: [],
                dependenciesInstalled: [],
                commandsRun: [],
                notes: 'B'.repeat(300),
                raw: '',
            };

            const distilled = distillContext(summary, 200);
            assert.ok(distilled.length <= 200);
            assert.ok(distilled.endsWith('...'));
        });

        test('omits empty sections', () => {
            const summary: StructuredSummary = {
                completed: 'Did the thing',
                filesModified: [],
                keyExports: [],
                dependenciesInstalled: [],
                commandsRun: [],
                notes: '',
                raw: '',
            };

            const distilled = distillContext(summary);
            assert.ok(!distilled.includes('Files:'));
            assert.ok(!distilled.includes('Exports:'));
            assert.ok(!distilled.includes('Dependencies'));
            assert.ok(!distilled.includes('Notes:'));
        });
    });

    // ================================================================
    // gatherDependencyContext
    // ================================================================

    suite('gatherDependencyContext', () => {
        function makePlan(subtasks: Subtask[]): OrchestrationPlan {
            return {
                subtasks,
                summary: 'test',
                strategy: 'parallel',
                overallComplexity: 'simple',
                successCriteria: [],
            };
        }

        function makeSubtask(id: string, deps: string[] = []): Subtask {
            return {
                id,
                title: `Task ${id}`,
                description: '',
                dependsOn: deps,
                complexity: 'simple',
                successCriteria: [],
                status: 'pending',
                attempts: 0,
                maxAttempts: 2,
            };
        }

        function makeResult(output: string, success = true): SubtaskResult {
            return {
                success,
                modelUsed: 'test-model',
                output,
                reviewNotes: '',
                durationMs: 100,
                timestamp: new Date().toISOString(),
            };
        }

        test('returns empty for task with no dependencies', () => {
            const plan = makePlan([makeSubtask('a')]);
            const results = new Map<string, SubtaskResult>();
            const ctx = gatherDependencyContext('a', plan, results);
            assert.strictEqual(ctx, '');
        });

        test('includes distilled context from completed dependency', () => {
            const plan = makePlan([makeSubtask('a'), makeSubtask('b', ['a'])]);

            const results = new Map<string, SubtaskResult>();
            results.set(
                'a',
                makeResult(
                    'Created files.\n\n```summary\nCOMPLETED: Built DB layer\nFILES_MODIFIED: db.ts\nKEY_EXPORTS: Database\nDEPENDENCIES_INSTALLED: none\nCOMMANDS_RUN: none\nNOTES: Uses SQLite\n```',
                ),
            );

            const ctx = gatherDependencyContext('b', plan, results);
            assert.ok(ctx.includes('DEPENDENCY CONTEXT'));
            assert.ok(ctx.includes('Built DB layer'));
            assert.ok(ctx.includes('db.ts'));
        });

        test('skips failed dependencies', () => {
            const plan = makePlan([makeSubtask('a'), makeSubtask('b', ['a'])]);

            const results = new Map<string, SubtaskResult>();
            results.set('a', makeResult('error', false));

            const ctx = gatherDependencyContext('b', plan, results);
            assert.strictEqual(ctx, '');
        });

        test('returns empty for unknown task', () => {
            const plan = makePlan([makeSubtask('a')]);
            const results = new Map<string, SubtaskResult>();
            const ctx = gatherDependencyContext('z', plan, results);
            assert.strictEqual(ctx, '');
        });
    });
});
