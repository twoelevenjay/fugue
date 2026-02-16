import * as assert from 'assert';
import {
    DelegationGuard,
    DEFAULT_DELEGATION_POLICY,
    buildDelegationConstraintBlock,
} from '../../johann/delegationPolicy';

// ============================================================================
// DELEGATION POLICY TESTS
//
// Tests for:
//   1. DelegationGuard — recursion blocking, parallelism caps, runaway freeze
//   2. Mode enforcement — johann-only, allow-model, no-delegation
//   3. buildDelegationConstraintBlock — prompt injection
//   4. Edge cases — frozen state, waitForSlot, stats
// ============================================================================

suite('DelegationPolicy', () => {
    // ================================================================
    // DEFAULT POLICY
    // ================================================================

    suite('DEFAULT_DELEGATION_POLICY', () => {
        test('has correct defaults', () => {
            assert.strictEqual(DEFAULT_DELEGATION_POLICY.mode, 'johann-only');
            assert.strictEqual(DEFAULT_DELEGATION_POLICY.maxDepth, 1);
            assert.strictEqual(DEFAULT_DELEGATION_POLICY.maxParallel, 3);
            assert.strictEqual(DEFAULT_DELEGATION_POLICY.runawayThreshold, 5);
        });
    });

    // ================================================================
    // DELEGATION GUARD — johann-only mode
    // ================================================================

    suite('DelegationGuard — johann-only', () => {
        let guard: DelegationGuard;

        setup(() => {
            guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 5,
            });
        });

        test('allows delegation at depth 0', () => {
            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, true);
        });

        test('blocks delegation at depth >= maxDepth', () => {
            const result = guard.requestDelegation(1);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes('Depth'));
        });

        test('blocks delegation at depth 2 (well beyond maxDepth=1)', () => {
            const result = guard.requestDelegation(2);
            assert.strictEqual(result.allowed, false);
        });

        test('increments totalSpawned on allowed delegation', () => {
            guard.requestDelegation(0);
            guard.requestDelegation(0);
            const stats = guard.getStats();
            assert.strictEqual(stats.totalSpawned, 2);
        });

        test('increments activeCount on allowed delegation', () => {
            guard.requestDelegation(0);
            assert.strictEqual(guard.activeCount, 1);
            guard.requestDelegation(0);
            assert.strictEqual(guard.activeCount, 2);
        });

        test('blocks when parallel cap is reached', () => {
            guard.requestDelegation(0); // 1
            guard.requestDelegation(0); // 2
            guard.requestDelegation(0); // 3 = cap
            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes('parallel cap'));
        });

        test('releaseDelegation decrements activeCount', () => {
            guard.requestDelegation(0);
            guard.requestDelegation(0);
            assert.strictEqual(guard.activeCount, 2);
            guard.releaseDelegation();
            assert.strictEqual(guard.activeCount, 1);
        });

        test('releaseDelegation allows new delegation after freeing slot', () => {
            guard.requestDelegation(0);
            guard.requestDelegation(0);
            guard.requestDelegation(0); // at cap
            const blocked = guard.requestDelegation(0);
            assert.strictEqual(blocked.allowed, false);

            guard.releaseDelegation(); // free one slot
            const allowed = guard.requestDelegation(0);
            assert.strictEqual(allowed.allowed, true);
        });

        test('releaseDelegation does not go below 0', () => {
            guard.releaseDelegation();
            guard.releaseDelegation();
            assert.strictEqual(guard.activeCount, 0);
        });

        test('tracks maxDepthReached correctly', () => {
            guard.requestDelegation(0); // depth 0 → reached depth 1
            const stats = guard.getStats();
            assert.strictEqual(stats.maxDepthReached, 1);
        });

        test('blocks when total budget exceeded', () => {
            // Budget = runawayThreshold * maxParallel = 5 * 3 = 15
            for (let i = 0; i < 15; i++) {
                guard.requestDelegation(0);
                guard.releaseDelegation();
            }
            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes('session budget'));
        });
    });

    // ================================================================
    // DELEGATION GUARD — no-delegation mode
    // ================================================================

    suite('DelegationGuard — no-delegation', () => {
        let guard: DelegationGuard;

        setup(() => {
            guard = new DelegationGuard({
                mode: 'no-delegation',
                maxDepth: 0,
                maxParallel: 0,
                runawayThreshold: 5,
            });
        });

        test('blocks all delegation', () => {
            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, false);
            assert.ok(result.reason?.includes('no-delegation'));
        });

        test('isNoDelegation returns true', () => {
            assert.strictEqual(guard.isNoDelegation, true);
        });

        test('mode returns no-delegation', () => {
            assert.strictEqual(guard.mode, 'no-delegation');
        });
    });

    // ================================================================
    // DELEGATION GUARD — allow-model mode
    // ================================================================

    suite('DelegationGuard — allow-model', () => {
        let guard: DelegationGuard;

        setup(() => {
            guard = new DelegationGuard({
                mode: 'allow-model',
                maxDepth: 2,
                maxParallel: 4,
                runawayThreshold: 5,
            });
        });

        test('allows delegation at depth 0', () => {
            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, true);
        });

        test('allows delegation at depth 1 (sub-subagent)', () => {
            const result = guard.requestDelegation(1);
            assert.strictEqual(result.allowed, true);
        });

        test('blocks delegation at depth 2 (beyond maxDepth)', () => {
            const result = guard.requestDelegation(2);
            assert.strictEqual(result.allowed, false);
        });

        test('higher parallel cap (4)', () => {
            guard.requestDelegation(0);
            guard.requestDelegation(0);
            guard.requestDelegation(0);
            const result = guard.requestDelegation(0); // 4th = at cap
            assert.strictEqual(result.allowed, true);

            const blocked = guard.requestDelegation(0); // 5th = over cap
            assert.strictEqual(blocked.allowed, false);
        });

        test('runaway detection is skipped in allow-model mode', () => {
            // In allow-model mode, the model is expected to delegate
            for (let i = 0; i < 10; i++) {
                guard.checkForRunaway('I will spawn a subagent to handle this');
            }
            assert.strictEqual(guard.isFrozen, false);
        });
    });

    // ================================================================
    // RUNAWAY DETECTION
    // ================================================================

    suite('DelegationGuard — runaway detection', () => {
        let guard: DelegationGuard;

        setup(() => {
            guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 3,
            });
        });

        test('detects "spawn subagent" phrase', () => {
            guard.checkForRunaway('I will spawn a subagent to handle this task');
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 1);
        });

        test('detects "delegate task" phrase', () => {
            guard.checkForRunaway('Let me delegate this task to another agent');
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 1);
        });

        test('detects "create a new agent" phrase', () => {
            guard.checkForRunaway('I should create a new agent for this');
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 1);
        });

        test('detects "I will orchestrate" phrase', () => {
            guard.checkForRunaway("I'll orchestrate the entire workflow");
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 1);
        });

        test('detects "I will decompose this" phrase', () => {
            guard.checkForRunaway("I'll decompose this into subtasks");
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 1);
        });

        test('freezes after threshold exceeded', () => {
            guard.checkForRunaway('spawn a subagent please');
            guard.checkForRunaway('delegate task to specialist');
            assert.strictEqual(guard.isFrozen, false);
            guard.checkForRunaway('create a new agent for parsing');
            assert.strictEqual(guard.isFrozen, true);
        });

        test('frozen guard blocks all further delegation', () => {
            // Freeze it
            guard.checkForRunaway('spawn subagent');
            guard.checkForRunaway('delegate task');
            guard.checkForRunaway('create agent');

            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, false);
            assert.strictEqual(result.frozen, true);
        });

        test('does not increment for normal text', () => {
            guard.checkForRunaway('I will create the TypeScript file now');
            guard.checkForRunaway('Let me implement the function');
            guard.checkForRunaway('Running npm install to add dependencies');
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 0);
        });

        test('only counts one signal per text chunk', () => {
            // Even if multiple patterns match, only one signal per call
            guard.checkForRunaway('I will spawn a subagent and delegate task');
            const stats = guard.getStats();
            assert.strictEqual(stats.runawaySignals, 1);
        });
    });

    // ================================================================
    // MANUAL FREEZE
    // ================================================================

    suite('DelegationGuard — manual freeze', () => {
        test('freeze blocks all further delegation', () => {
            const guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 5,
            });

            guard.requestDelegation(0); // allowed
            guard.freeze('safety check failed');

            const result = guard.requestDelegation(0);
            assert.strictEqual(result.allowed, false);
            assert.strictEqual(result.frozen, true);
        });

        test('freeze records reason in block log', () => {
            const guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 5,
            });

            guard.freeze('external safety violation');
            const stats = guard.getStats();
            assert.strictEqual(stats.blockLog.length, 1);
            assert.ok(stats.blockLog[0].reason.includes('MANUAL FREEZE'));
            assert.ok(stats.blockLog[0].reason.includes('external safety violation'));
        });
    });

    // ================================================================
    // STATS & ACCESSORS
    // ================================================================

    suite('DelegationGuard — stats', () => {
        test('getStats returns complete snapshot', () => {
            const guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 5,
            });

            guard.requestDelegation(0);
            guard.requestDelegation(0);
            guard.requestDelegation(0); // at cap
            guard.requestDelegation(0); // blocked

            const stats = guard.getStats();
            assert.strictEqual(stats.mode, 'johann-only');
            assert.strictEqual(stats.totalSpawned, 3);
            assert.strictEqual(stats.activeCount, 3);
            assert.strictEqual(stats.delegationsBlocked, 1);
            assert.strictEqual(stats.frozen, false);
            assert.strictEqual(stats.blockLog.length, 1);
        });

        test('getPolicy returns readonly policy', () => {
            const guard = new DelegationGuard({
                mode: 'allow-model',
                maxDepth: 2,
                maxParallel: 4,
                runawayThreshold: 10,
            });

            const policy = guard.getPolicy();
            assert.strictEqual(policy.mode, 'allow-model');
            assert.strictEqual(policy.maxDepth, 2);
            assert.strictEqual(policy.maxParallel, 4);
            assert.strictEqual(policy.runawayThreshold, 10);
        });

        test('blockLog has timestamps', () => {
            const guard = new DelegationGuard({
                mode: 'no-delegation',
                maxDepth: 0,
                maxParallel: 0,
                runawayThreshold: 5,
            });

            guard.requestDelegation(0); // blocked
            const stats = guard.getStats();
            assert.strictEqual(stats.blockLog.length, 1);
            assert.ok(stats.blockLog[0].timestamp.length > 0);
            // Should be a valid ISO timestamp
            assert.ok(!isNaN(Date.parse(stats.blockLog[0].timestamp)));
        });
    });

    // ================================================================
    // buildDelegationConstraintBlock
    // ================================================================

    suite('buildDelegationConstraintBlock', () => {
        test('johann-only block contains strict warnings', () => {
            const block = buildDelegationConstraintBlock({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 5,
            });
            assert.ok(block.includes('JOHANN-ONLY'));
            assert.ok(block.includes('LEAF EXECUTOR'));
            assert.ok(block.includes('MUST NOT'));
        });

        test('allow-model block mentions bounded delegation', () => {
            const block = buildDelegationConstraintBlock({
                mode: 'allow-model',
                maxDepth: 2,
                maxParallel: 4,
                runawayThreshold: 5,
            });
            assert.ok(block.includes('MODEL-MANAGED'));
            assert.ok(block.includes('BOUNDED'));
            assert.ok(block.includes('2'));
            assert.ok(block.includes('4'));
        });

        test('no-delegation block is shortest and most restrictive', () => {
            const block = buildDelegationConstraintBlock({
                mode: 'no-delegation',
                maxDepth: 0,
                maxParallel: 0,
                runawayThreshold: 5,
            });
            assert.ok(block.includes('NONE'));
            assert.ok(block.includes('sole executor'));
        });
    });

    // ================================================================
    // EDGE CASES
    // ================================================================

    suite('DelegationGuard — edge cases', () => {
        test('maxParallel=1 allows only one at a time', () => {
            const guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 1,
                runawayThreshold: 5,
            });

            const first = guard.requestDelegation(0);
            assert.strictEqual(first.allowed, true);

            const second = guard.requestDelegation(0);
            assert.strictEqual(second.allowed, false);

            guard.releaseDelegation();
            const third = guard.requestDelegation(0);
            assert.strictEqual(third.allowed, true);
        });

        test('handles rapid delegation/release cycles', () => {
            const guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 2,
                runawayThreshold: 100,
            });

            for (let i = 0; i < 50; i++) {
                const r = guard.requestDelegation(0);
                assert.strictEqual(r.allowed, true, `Cycle ${i} should be allowed`);
                guard.releaseDelegation();
            }

            const stats = guard.getStats();
            assert.strictEqual(stats.totalSpawned, 50);
            assert.strictEqual(stats.activeCount, 0);
        });

        test('empty text does not trigger runaway detection', () => {
            const guard = new DelegationGuard({
                mode: 'johann-only',
                maxDepth: 1,
                maxParallel: 3,
                runawayThreshold: 1,
            });

            guard.checkForRunaway('');
            assert.strictEqual(guard.isFrozen, false);
        });

        test('default constructor uses getDelegationPolicy()', () => {
            // This will use VS Code workspace config defaults
            // Just verify it doesn't throw
            const guard = new DelegationGuard();
            assert.ok(guard.mode);
            assert.ok(typeof guard.maxParallel === 'number');
        });
    });
});
