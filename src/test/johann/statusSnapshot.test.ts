import * as assert from 'assert';
import {
    RunStateData,
    RunTask,
} from '../../johann/runState';
import {
    generateSnapshot,
    generateDetailedSnapshot,
} from '../../johann/statusSnapshot';

// ============================================================================
// Status Snapshot tests
//
// Tests the markdown + Mermaid generation from RunStateData.
// ============================================================================

/**
 * Helper: build a minimal RunStateData for testing.
 */
function makeState(overrides?: Partial<RunStateData>): RunStateData {
    return {
        runId: 'test-run-1',
        startedAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago
        lastUpdatedAt: new Date().toISOString(),
        status: 'running',
        tasks: [],
        subagents: [],
        counters: { queued: 0, running: 0, done: 0, failed: 0 },
        userQueue: [],
        originalRequest: 'Build a REST API',
        ...overrides,
    };
}

function makeTask(overrides?: Partial<RunTask>): RunTask {
    return {
        id: 'st-1',
        title: 'Build models',
        status: 'queued',
        artifacts: [],
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

suite('StatusSnapshot', () => {
    // ════════════════════════════════════════════════════════════════
    // Basic generation
    // ════════════════════════════════════════════════════════════════

    test('generates snapshot from minimal state', () => {
        const state = makeState();
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.timestamp);
        assert.ok(snapshot.header.includes('Johann Run Status'));
        assert.ok(snapshot.header.includes('test-run-1'));
        assert.ok(snapshot.mermaidCompact.includes('flowchart TD'));
        assert.ok(snapshot.markdown.length > 0);
    });

    test('snapshot header includes counters', () => {
        const state = makeState({
            counters: { queued: 2, running: 1, done: 5, failed: 1 },
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.header.includes('2'));
        assert.ok(snapshot.header.includes('5'));
    });

    test('snapshot includes plan summary when set', () => {
        const state = makeState({ planSummary: 'Build REST API with endpoints' });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.header.includes('Build REST API with endpoints'));
    });

    // ════════════════════════════════════════════════════════════════
    // Active items
    // ════════════════════════════════════════════════════════════════

    test('shows running tasks in active items', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Building models', status: 'running', model: 'claude-sonnet' }),
                makeTask({ id: 'st-2', title: 'Write tests', status: 'queued' }),
            ],
            counters: { queued: 1, running: 1, done: 0, failed: 0 },
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.activeItems.includes('Building models'));
        assert.ok(snapshot.activeItems.includes('Running'));
    });

    test('shows queued tasks in next up', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Queued task', status: 'queued' }),
            ],
            counters: { queued: 1, running: 0, done: 0, failed: 0 },
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.activeItems.includes('Queued task'));
        assert.ok(snapshot.activeItems.includes('Next up'));
    });

    test('empty active items when no running or queued', () => {
        const state = makeState({
            tasks: [
                makeTask({ status: 'done' }),
            ],
            counters: { queued: 0, running: 0, done: 1, failed: 0 },
        });
        const snapshot = generateSnapshot(state);

        assert.strictEqual(snapshot.activeItems, '');
    });

    // ════════════════════════════════════════════════════════════════
    // User queue
    // ════════════════════════════════════════════════════════════════

    test('shows pending user queue messages', () => {
        const state = makeState({
            userQueue: [
                {
                    id: 'uq-1',
                    message: 'Also fix the tests please',
                    enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
                    position: 1,
                    integrated: false,
                },
            ],
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.queueInfo.includes('Also fix the tests'));
        assert.ok(snapshot.queueInfo.includes('Queued User Requests'));
    });

    test('no queue info when all messages integrated', () => {
        const state = makeState({
            userQueue: [
                {
                    id: 'uq-1',
                    message: 'Done message',
                    enqueuedAt: new Date().toISOString(),
                    position: 1,
                    integrated: true,
                },
            ],
        });
        const snapshot = generateSnapshot(state);

        assert.strictEqual(snapshot.queueInfo, '');
    });

    // ════════════════════════════════════════════════════════════════
    // Mermaid diagrams
    // ════════════════════════════════════════════════════════════════

    test('compact Mermaid uses phase-level flowchart', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Analyze codebase', status: 'done', phase: 'discovery' }),
                makeTask({ id: 'st-2', title: 'Build API', status: 'running', phase: 'implementation' }),
                makeTask({ id: 'st-3', title: 'Run tests', status: 'queued', phase: 'verification' }),
            ],
            counters: { queued: 1, running: 1, done: 1, failed: 0 },
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.mermaidCompact.includes('flowchart TD'));
        assert.ok(snapshot.mermaidCompact.includes('Discovery'));
        assert.ok(snapshot.mermaidCompact.includes('Implementation'));
        assert.ok(snapshot.mermaidCompact.includes('Verification'));
    });

    test('flat Mermaid when no phases assigned', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Do something', status: 'running' }),
            ],
            counters: { queued: 0, running: 1, done: 0, failed: 0 },
            planSummary: 'Test plan',
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.mermaidCompact.includes('flowchart TD'));
        assert.ok(snapshot.mermaidCompact.includes('PLAN'));
    });

    test('detailed Mermaid shows per-task nodes', () => {
        const tasks: RunTask[] = [];
        for (let i = 1; i <= 5; i++) {
            tasks.push(makeTask({
                id: `st-${i}`,
                title: `Task ${i}`,
                status: i <= 2 ? 'done' : i === 3 ? 'running' : 'queued',
            }));
        }
        const state = makeState({
            tasks,
            counters: { queued: 2, running: 1, done: 2, failed: 0 },
        });

        const snapshot = generateSnapshot(state);
        assert.ok(snapshot.mermaidDetailed.includes('flowchart TD'));
        assert.ok(snapshot.mermaidDetailed.includes('Task 1'));
        assert.ok(snapshot.mermaidDetailed.includes('Task 5'));
    });

    test('detailed Mermaid empty when >30 tasks', () => {
        const tasks: RunTask[] = [];
        for (let i = 1; i <= 35; i++) {
            tasks.push(makeTask({
                id: `st-${i}`,
                title: `Task ${i}`,
                status: 'queued',
            }));
        }
        const state = makeState({ tasks });
        const snapshot = generateSnapshot(state);

        assert.strictEqual(snapshot.mermaidDetailed, '');
    });

    // ════════════════════════════════════════════════════════════════
    // Text table
    // ════════════════════════════════════════════════════════════════

    test('text table shows tasks', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Build', status: 'done', artifacts: ['src/a.ts'] }),
                makeTask({ id: 'st-2', title: 'Test', status: 'running' }),
            ],
        });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.textTable.includes('Task'));
        assert.ok(snapshot.textTable.includes('st-1'));
        assert.ok(snapshot.textTable.includes('st-2'));
    });

    test('text table shows "no tasks" when empty', () => {
        const state = makeState();
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.textTable.includes('No tasks'));
    });

    // ════════════════════════════════════════════════════════════════
    // Actions
    // ════════════════════════════════════════════════════════════════

    test('actions shown while running', () => {
        const state = makeState({ status: 'running' });
        const snapshot = generateSnapshot(state);

        assert.ok(snapshot.actions.includes('status'));
        assert.ok(snapshot.actions.includes('Stop'));
    });

    test('no actions when completed', () => {
        const state = makeState({ status: 'completed' });
        const snapshot = generateSnapshot(state);

        assert.strictEqual(snapshot.actions, '');
    });

    // ════════════════════════════════════════════════════════════════
    // Detailed snapshot
    // ════════════════════════════════════════════════════════════════

    test('detailed snapshot includes task-level diagram', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Build', status: 'done' }),
                makeTask({ id: 'st-2', title: 'Test', status: 'running' }),
            ],
            counters: { queued: 0, running: 1, done: 1, failed: 0 },
        });

        const snapshot = generateDetailedSnapshot(state);
        assert.ok(snapshot.markdown.includes('Detailed Task Graph'));
    });

    // ════════════════════════════════════════════════════════════════
    // Full markdown assembly
    // ════════════════════════════════════════════════════════════════

    test('markdown includes all sections', () => {
        const state = makeState({
            status: 'running',
            planSummary: 'Build API',
            tasks: [
                makeTask({ id: 'st-1', title: 'Build', status: 'running', model: 'gpt-4o' }),
                makeTask({ id: 'st-2', title: 'Test', status: 'queued' }),
            ],
            counters: { queued: 1, running: 1, done: 0, failed: 0 },
            userQueue: [
                {
                    id: 'uq-1',
                    message: 'Also deploy',
                    enqueuedAt: new Date().toISOString(),
                    position: 1,
                    integrated: false,
                },
            ],
        });

        const snapshot = generateSnapshot(state);

        // Should contain all major sections
        assert.ok(snapshot.markdown.includes('Johann Run Status'));
        assert.ok(snapshot.markdown.includes('Active Items'));
        assert.ok(snapshot.markdown.includes('Queued User Requests'));
        assert.ok(snapshot.markdown.includes('Workflow Status'));
        assert.ok(snapshot.markdown.includes('mermaid'));
        assert.ok(snapshot.markdown.includes('Text fallback'));
        assert.ok(snapshot.markdown.includes('Actions'));
    });

    // ════════════════════════════════════════════════════════════════
    // Phase inference
    // ════════════════════════════════════════════════════════════════

    test('phase inference from task titles', () => {
        const state = makeState({
            tasks: [
                makeTask({ id: 'st-1', title: 'Scan repository structure', status: 'done' }),
                makeTask({ id: 'st-2', title: 'Design API schema', status: 'done' }),
                makeTask({ id: 'st-3', title: 'Implement user endpoints', status: 'running' }),
                makeTask({ id: 'st-4', title: 'Validate integration tests', status: 'queued' }),
                makeTask({ id: 'st-5', title: 'Deploy to staging', status: 'queued' }),
            ],
            counters: { queued: 2, running: 1, done: 2, failed: 0 },
        });

        const snapshot = generateSnapshot(state);

        // "Scan" → discovery, "Design" → planning, "Implement" → implementation,
        // "Validate" → verification, "Deploy" → packaging
        // The compact Mermaid should include at least some of these phases
        assert.ok(snapshot.mermaidCompact.includes('Discovery') || snapshot.mermaidCompact.includes('discovery'));
    });
});
