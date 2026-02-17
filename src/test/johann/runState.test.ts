import * as assert from 'assert';
import { RunStateManager } from '../../johann/runState';

// ============================================================================
// RunStateManager tests
//
// Note: RunStateManager is a singleton, so we must reset it between tests.
// Disk persistence is tested indirectly — it fires but we don't verify the
// file system here (that would require vscode.workspace.fs mocks).
// ============================================================================

suite('RunStateManager', () => {
    let manager: RunStateManager;

    setup(() => {
        // Get a fresh instance — dispose resets the singleton
        const existing = RunStateManager.getInstance();
        existing.dispose();
        manager = RunStateManager.getInstance();
    });

    teardown(() => {
        manager.dispose();
    });

    // ════════════════════════════════════════════════════════════════
    // Lifecycle
    // ════════════════════════════════════════════════════════════════

    test('starts idle (no state)', () => {
        assert.strictEqual(manager.getState(), null);
        assert.strictEqual(manager.isRunning(), false);
    });

    test('startRun creates running state', async () => {
        const state = await manager.startRun('run-1', 'Build an API');
        assert.strictEqual(state.runId, 'run-1');
        assert.strictEqual(state.status, 'running');
        assert.strictEqual(state.originalRequest, 'Build an API');
        assert.strictEqual(state.tasks.length, 0);
        assert.strictEqual(state.subagents.length, 0);
        assert.strictEqual(state.userQueue.length, 0);
    });

    test('isRunning returns true while running', async () => {
        await manager.startRun('run-2', 'test');
        assert.strictEqual(manager.isRunning(), true);
    });

    test('completeRun sets status to completed', async () => {
        await manager.startRun('run-3', 'test');
        await manager.completeRun();
        const state = manager.getState();
        assert.strictEqual(state?.status, 'completed');
        assert.strictEqual(manager.isRunning(), false);
    });

    test('failRun sets status to failed', async () => {
        await manager.startRun('run-4', 'test');
        await manager.failRun('Something broke');
        const state = manager.getState();
        assert.strictEqual(state?.status, 'failed');
        assert.strictEqual(manager.isRunning(), false);
    });

    test('cancelRun sets status to cancelling', async () => {
        await manager.startRun('run-5', 'test');
        await manager.cancelRun();
        const state = manager.getState();
        assert.strictEqual(state?.status, 'cancelling');
        // cancelling is still considered "running"
        assert.strictEqual(manager.isRunning(), true);
    });

    test('clear resets state to null', async () => {
        await manager.startRun('run-6', 'test');
        manager.clear();
        assert.strictEqual(manager.getState(), null);
    });

    // ════════════════════════════════════════════════════════════════
    // Task management
    // ════════════════════════════════════════════════════════════════

    test('registerTasks adds tasks in queued state', async () => {
        await manager.startRun('run-t1', 'test');
        await manager.registerTasks([
            { id: 'st-1', title: 'Build models' },
            { id: 'st-2', title: 'Write tests', phase: 'verification' },
        ]);

        const state = manager.getState()!;
        assert.strictEqual(state.tasks.length, 2);
        assert.strictEqual(state.tasks[0].status, 'queued');
        assert.strictEqual(state.tasks[1].phase, 'verification');
        assert.strictEqual(state.counters.queued, 2);
    });

    test('registerTasks is idempotent', async () => {
        await manager.startRun('run-t2', 'test');
        await manager.registerTasks([{ id: 'st-1', title: 'Build models' }]);
        await manager.registerTasks([{ id: 'st-1', title: 'Build models' }]); // duplicate
        assert.strictEqual(manager.getState()!.tasks.length, 1);
    });

    test('updateTask transitions status and sets timestamps', async () => {
        await manager.startRun('run-t3', 'test');
        await manager.registerTasks([{ id: 'st-1', title: 'Build models' }]);

        await manager.updateTask('st-1', { status: 'running', model: 'gpt-4o' });
        let task = manager.getState()!.tasks[0];
        assert.strictEqual(task.status, 'running');
        assert.strictEqual(task.model, 'gpt-4o');
        assert.ok(task.startedAt);
        assert.strictEqual(manager.getState()!.counters.running, 1);

        await manager.updateTask('st-1', { status: 'done' });
        task = manager.getState()!.tasks[0];
        assert.strictEqual(task.status, 'done');
        assert.ok(task.completedAt);
        assert.strictEqual(manager.getState()!.counters.done, 1);
        assert.strictEqual(manager.getState()!.counters.running, 0);
    });

    test('updateTask with progress message', async () => {
        await manager.startRun('run-t4', 'test');
        await manager.registerTasks([{ id: 'st-1', title: 'Build models' }]);
        await manager.updateTask('st-1', { progressMessage: 'Round 3 of 15' });
        assert.strictEqual(manager.getState()!.tasks[0].progressMessage, 'Round 3 of 15');
    });

    test('updateTask on nonexistent task is no-op', async () => {
        await manager.startRun('run-t5', 'test');
        await manager.updateTask('nonexistent', { status: 'running' });
        assert.strictEqual(manager.getState()!.tasks.length, 0);
    });

    // ════════════════════════════════════════════════════════════════
    // Subagent management
    // ════════════════════════════════════════════════════════════════

    test('registerSubagent adds subagent', async () => {
        await manager.startRun('run-s1', 'test');
        await manager.registerSubagent({
            id: 'sa-1',
            title: 'Code review agent',
            status: 'running',
            summary: 'Reviewing src/index.ts',
            taskId: 'st-1',
        });

        const state = manager.getState()!;
        assert.strictEqual(state.subagents.length, 1);
        assert.strictEqual(state.subagents[0].title, 'Code review agent');
        assert.ok(state.subagents[0].createdAt);
    });

    test('updateSubagent changes status and summary', async () => {
        await manager.startRun('run-s2', 'test');
        await manager.registerSubagent({
            id: 'sa-1',
            title: 'Agent',
            status: 'running',
            summary: 'Starting...',
        });

        await manager.updateSubagent('sa-1', {
            status: 'done',
            summary: 'Completed review',
            result: 'Found 3 issues',
        });

        const sa = manager.getState()!.subagents[0];
        assert.strictEqual(sa.status, 'done');
        assert.strictEqual(sa.summary, 'Completed review');
        assert.strictEqual(sa.result, 'Found 3 issues');
        assert.ok(sa.completedAt);
    });

    // ════════════════════════════════════════════════════════════════
    // User queue
    // ════════════════════════════════════════════════════════════════

    test('enqueueUserMessage adds to queue', async () => {
        await manager.startRun('run-q1', 'test');
        const pos = await manager.enqueueUserMessage('Also fix the tests');
        assert.strictEqual(pos, 1);

        const pending = manager.getPendingUserMessages();
        assert.strictEqual(pending.length, 1);
        assert.strictEqual(pending[0].message, 'Also fix the tests');
        assert.strictEqual(pending[0].integrated, false);
    });

    test('enqueueUserMessage returns sequential positions', async () => {
        await manager.startRun('run-q2', 'test');
        const pos1 = await manager.enqueueUserMessage('First');
        const pos2 = await manager.enqueueUserMessage('Second');
        assert.strictEqual(pos1, 1);
        assert.strictEqual(pos2, 2);
    });

    test('markUserMessageIntegrated removes from pending', async () => {
        await manager.startRun('run-q3', 'test');
        await manager.enqueueUserMessage('Fix bugs');

        const pending = manager.getPendingUserMessages();
        assert.strictEqual(pending.length, 1);

        await manager.markUserMessageIntegrated(pending[0].id);
        assert.strictEqual(manager.getPendingUserMessages().length, 0);
    });

    test('enqueueUserMessage throws when no active run', async () => {
        try {
            await manager.enqueueUserMessage('test');
            assert.fail('Should have thrown');
        } catch (e) {
            assert.ok(e instanceof Error);
        }
    });

    // ════════════════════════════════════════════════════════════════
    // Snapshot throttle
    // ════════════════════════════════════════════════════════════════

    test('canSnapshot returns true initially', async () => {
        await manager.startRun('run-snap1', 'test');
        assert.strictEqual(manager.canSnapshot(), true);
    });

    test('canSnapshot returns false immediately after recordSnapshot', async () => {
        await manager.startRun('run-snap2', 'test');
        await manager.recordSnapshot();
        assert.strictEqual(manager.canSnapshot(60_000), false);
    });

    test('canSnapshot with very short interval returns true', async () => {
        await manager.startRun('run-snap3', 'test');
        await manager.recordSnapshot();
        // 0ms interval — should always pass
        assert.strictEqual(manager.canSnapshot(0), true);
    });

    // ════════════════════════════════════════════════════════════════
    // State change events
    // ════════════════════════════════════════════════════════════════

    test('onStateChange fires on startRun', async () => {
        let fired = false;
        const sub = manager.onStateChange(() => {
            fired = true;
        });
        await manager.startRun('run-evt1', 'test');
        assert.strictEqual(fired, true);
        sub.dispose();
    });

    test('onStateChange fires on updateTask', async () => {
        await manager.startRun('run-evt2', 'test');
        await manager.registerTasks([{ id: 'st-1', title: 'Task' }]);

        let fireCount = 0;
        const sub = manager.onStateChange(() => {
            fireCount++;
        });
        await manager.updateTask('st-1', { status: 'running' });
        assert.ok(fireCount >= 1);
        sub.dispose();
    });

    // ════════════════════════════════════════════════════════════════
    // Elapsed time
    // ════════════════════════════════════════════════════════════════

    test('getState computes elapsedMs', async () => {
        await manager.startRun('run-el1', 'test');
        const state = manager.getState()!;
        assert.ok(state.elapsedMs !== undefined);
        assert.ok(state.elapsedMs >= 0);
    });

    // ════════════════════════════════════════════════════════════════
    // Plan summary
    // ════════════════════════════════════════════════════════════════

    test('setPlanSummary stores plan summary', async () => {
        await manager.startRun('run-ps1', 'test');
        await manager.setPlanSummary('Build REST API with 3 endpoints');
        assert.strictEqual(manager.getState()!.planSummary, 'Build REST API with 3 endpoints');
    });
});
