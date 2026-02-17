import * as assert from 'assert';
import { getExecutionWaves, getDownstreamTasks, validateGraph } from '../../johann/graphManager';
import { OrchestrationPlan, Subtask } from '../../johann/types';

/**
 * Build a minimal OrchestrationPlan from compact subtask definitions.
 */
function makePlan(defs: Array<{ id: string; deps?: string[] }>): OrchestrationPlan {
    const subtasks: Subtask[] = defs.map((d) => ({
        id: d.id,
        title: `Task ${d.id}`,
        description: '',
        dependsOn: d.deps ?? [],
        complexity: 'simple' as const,
        successCriteria: [],
        status: 'pending' as const,
        attempts: 0,
        maxAttempts: 2,
    }));

    return {
        subtasks,
        summary: 'test plan',
        strategy: 'parallel',
        overallComplexity: 'simple',
        successCriteria: [],
    };
}

suite('graphManager', () => {
    // ================================================================
    // getExecutionWaves
    // ================================================================

    suite('getExecutionWaves', () => {
        test('empty plan produces no waves', () => {
            const waves = getExecutionWaves(makePlan([]));
            assert.strictEqual(waves.length, 0);
        });

        test('single task produces one wave', () => {
            const waves = getExecutionWaves(makePlan([{ id: 'a' }]));
            assert.strictEqual(waves.length, 1);
            assert.deepStrictEqual(waves[0].taskIds, ['a']);
            assert.strictEqual(waves[0].level, 0);
        });

        test('two independent tasks share wave 0', () => {
            const waves = getExecutionWaves(makePlan([{ id: 'a' }, { id: 'b' }]));
            assert.strictEqual(waves.length, 1);
            assert.strictEqual(waves[0].taskIds.length, 2);
            assert.ok(waves[0].taskIds.includes('a'));
            assert.ok(waves[0].taskIds.includes('b'));
        });

        test('linear chain produces sequential waves', () => {
            const waves = getExecutionWaves(
                makePlan([{ id: 'a' }, { id: 'b', deps: ['a'] }, { id: 'c', deps: ['b'] }]),
            );
            assert.strictEqual(waves.length, 3);
            assert.deepStrictEqual(waves[0].taskIds, ['a']);
            assert.deepStrictEqual(waves[1].taskIds, ['b']);
            assert.deepStrictEqual(waves[2].taskIds, ['c']);
        });

        test('diamond pattern produces correct waves', () => {
            // a → b, a → c, b → d, c → d
            const waves = getExecutionWaves(
                makePlan([
                    { id: 'a' },
                    { id: 'b', deps: ['a'] },
                    { id: 'c', deps: ['a'] },
                    { id: 'd', deps: ['b', 'c'] },
                ]),
            );
            assert.strictEqual(waves.length, 3);
            assert.deepStrictEqual(waves[0].taskIds, ['a']);
            assert.strictEqual(waves[1].taskIds.length, 2);
            assert.ok(waves[1].taskIds.includes('b'));
            assert.ok(waves[1].taskIds.includes('c'));
            assert.deepStrictEqual(waves[2].taskIds, ['d']);
        });

        test('complex DAG with mixed parallelism', () => {
            // a, b → c; a → d; c, d → e
            const waves = getExecutionWaves(
                makePlan([
                    { id: 'a' },
                    { id: 'b' },
                    { id: 'c', deps: ['a', 'b'] },
                    { id: 'd', deps: ['a'] },
                    { id: 'e', deps: ['c', 'd'] },
                ]),
            );
            assert.strictEqual(waves.length, 3);
            // Wave 0: a, b (both roots)
            assert.strictEqual(waves[0].taskIds.length, 2);
            // Wave 1: c, d (both have wave-0 deps only)
            assert.strictEqual(waves[1].taskIds.length, 2);
            // Wave 2: e
            assert.deepStrictEqual(waves[2].taskIds, ['e']);
        });

        test('throws on cycle', () => {
            assert.throws(
                () =>
                    getExecutionWaves(
                        makePlan([
                            { id: 'a', deps: ['b'] },
                            { id: 'b', deps: ['a'] },
                        ]),
                    ),
                /[Cc]ycle/,
            );
        });
    });

    // ================================================================
    // getDownstreamTasks
    // ================================================================

    suite('getDownstreamTasks', () => {
        test('leaf task has no downstream', () => {
            const plan = makePlan([{ id: 'a' }, { id: 'b', deps: ['a'] }]);
            const downstream = getDownstreamTasks(plan, 'b');
            assert.strictEqual(downstream.length, 0);
        });

        test('root task cascades to all dependents', () => {
            const plan = makePlan([
                { id: 'a' },
                { id: 'b', deps: ['a'] },
                { id: 'c', deps: ['a'] },
                { id: 'd', deps: ['b'] },
            ]);
            const downstream = getDownstreamTasks(plan, 'a');
            assert.strictEqual(downstream.length, 3);
            assert.ok(downstream.includes('b'));
            assert.ok(downstream.includes('c'));
            assert.ok(downstream.includes('d'));
        });

        test('mid-chain task cascades only to its dependents', () => {
            const plan = makePlan([
                { id: 'a' },
                { id: 'b', deps: ['a'] },
                { id: 'c', deps: ['b'] },
            ]);
            const downstream = getDownstreamTasks(plan, 'b');
            assert.deepStrictEqual(downstream, ['c']);
        });

        test('unknown task returns empty', () => {
            const plan = makePlan([{ id: 'a' }]);
            const downstream = getDownstreamTasks(plan, 'z');
            assert.strictEqual(downstream.length, 0);
        });
    });

    // ================================================================
    // validateGraph
    // ================================================================

    suite('validateGraph', () => {
        test('valid DAG passes', () => {
            const result = validateGraph(
                makePlan([
                    { id: 'a' },
                    { id: 'b', deps: ['a'] },
                    { id: 'c', deps: ['a'] },
                    { id: 'd', deps: ['b', 'c'] },
                ]),
            );
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.cycles.length, 0);
            assert.strictEqual(result.missingDeps.length, 0);
            assert.strictEqual(result.orphans.length, 0);
        });

        test('empty plan is valid', () => {
            const result = validateGraph(makePlan([]));
            assert.strictEqual(result.valid, true);
        });

        test('detects missing dependency', () => {
            const result = validateGraph(
                makePlan([{ id: 'a' }, { id: 'b', deps: ['nonexistent'] }]),
            );
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.missingDeps.length, 1);
            assert.strictEqual(result.missingDeps[0].taskId, 'b');
            assert.strictEqual(result.missingDeps[0].missingDep, 'nonexistent');
        });

        test('detects cycle', () => {
            const result = validateGraph(
                makePlan([
                    { id: 'a', deps: ['c'] },
                    { id: 'b', deps: ['a'] },
                    { id: 'c', deps: ['b'] },
                ]),
            );
            assert.strictEqual(result.valid, false);
            assert.ok(result.cycles.length > 0);
        });

        test('all independent tasks are valid (no orphans)', () => {
            const result = validateGraph(makePlan([{ id: 'a' }, { id: 'b' }, { id: 'c' }]));
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.orphans.length, 0);
        });
    });
});
