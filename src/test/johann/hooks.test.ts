import * as assert from 'assert';
import { HookRunner, HookName, HookContext, HookHandler } from '../../johann/hooks';

suite('hooks', () => {
    let runner: HookRunner;

    setup(() => {
        runner = new HookRunner();
    });

    // ================================================================
    // Registration & basic execution
    // ================================================================

    test('runs registered handler', async () => {
        let called = false;
        runner.register('on_session_start', {
            name: 'test-hook',
            priority: 0,
            handler: async () => { called = true; },
        });

        await runner.run('on_session_start', {});
        assert.strictEqual(called, true);
    });

    test('does nothing for unregistered hook', async () => {
        // Should not throw
        await runner.run('on_session_end', {});
    });

    test('passes context to handler', async () => {
        let receivedRequest: string | undefined;
        runner.register('before_planning', {
            name: 'ctx-test',
            priority: 0,
            handler: async (ctx) => { receivedRequest = ctx.request; },
        });

        await runner.run('before_planning', { request: 'build an API' });
        assert.strictEqual(receivedRequest, 'build an API');
    });

    // ================================================================
    // Priority ordering
    // ================================================================

    test('runs handlers in priority order (higher first)', async () => {
        const order: string[] = [];

        runner.register('before_subtask', {
            name: 'low',
            priority: 0,
            handler: async () => { order.push('low'); },
        });

        runner.register('before_subtask', {
            name: 'high',
            priority: 100,
            handler: async () => { order.push('high'); },
        });

        runner.register('before_subtask', {
            name: 'medium',
            priority: 50,
            handler: async () => { order.push('medium'); },
        });

        await runner.run('before_subtask', {});
        assert.deepStrictEqual(order, ['high', 'medium', 'low']);
    });

    // ================================================================
    // Error isolation
    // ================================================================

    test('continues running after handler failure', async () => {
        let secondCalled = false;

        runner.register('on_error', {
            name: 'failing-handler',
            priority: 10,
            handler: async () => { throw new Error('boom'); },
        });

        runner.register('on_error', {
            name: 'surviving-handler',
            priority: 0,
            handler: async () => { secondCalled = true; },
        });

        // Should not throw
        await runner.run('on_error', {});
        assert.strictEqual(secondCalled, true);
    });

    // ================================================================
    // Unregistration
    // ================================================================

    test('unregister removes handler', async () => {
        let called = false;
        runner.register('after_merge', {
            name: 'removable',
            priority: 0,
            handler: async () => { called = true; },
        });

        runner.unregister('after_merge', 'removable');
        await runner.run('after_merge', {});
        assert.strictEqual(called, false);
    });

    test('unregister is safe for non-existent handler', () => {
        // Should not throw
        runner.unregister('after_merge', 'nonexistent');
    });

    // ================================================================
    // Utility methods
    // ================================================================

    test('hasHandlers returns correct status', () => {
        assert.strictEqual(runner.hasHandlers('on_session_start'), false);

        runner.register('on_session_start', {
            name: 'test',
            priority: 0,
            handler: async () => {},
        });

        assert.strictEqual(runner.hasHandlers('on_session_start'), true);
    });

    test('getHandlerNames lists registered handlers', () => {
        runner.register('before_merge', {
            name: 'alpha',
            priority: 10,
            handler: async () => {},
        });
        runner.register('before_merge', {
            name: 'beta',
            priority: 0,
            handler: async () => {},
        });

        const names = runner.getHandlerNames('before_merge');
        assert.deepStrictEqual(names, ['alpha', 'beta']);
    });

    test('clear removes all handlers', async () => {
        runner.register('on_session_start', {
            name: 'hook1',
            priority: 0,
            handler: async () => {},
        });
        runner.register('on_session_end', {
            name: 'hook2',
            priority: 0,
            handler: async () => {},
        });

        runner.clear();
        assert.strictEqual(runner.hasHandlers('on_session_start'), false);
        assert.strictEqual(runner.hasHandlers('on_session_end'), false);
    });

    // ================================================================
    // Multiple handlers per hook
    // ================================================================

    test('all handlers fire for the same hook', async () => {
        let count = 0;
        for (let i = 0; i < 5; i++) {
            runner.register('after_subtask', {
                name: `handler-${i}`,
                priority: i,
                handler: async () => { count++; },
            });
        }

        await runner.run('after_subtask', {});
        assert.strictEqual(count, 5);
    });

    // ================================================================
    // Hook isolation (different hooks don't interfere)
    // ================================================================

    test('handlers for different hooks are isolated', async () => {
        let beforeCalled = false;
        let afterCalled = false;

        runner.register('before_planning', {
            name: 'before',
            priority: 0,
            handler: async () => { beforeCalled = true; },
        });

        runner.register('after_planning', {
            name: 'after',
            priority: 0,
            handler: async () => { afterCalled = true; },
        });

        await runner.run('before_planning', {});
        assert.strictEqual(beforeCalled, true);
        assert.strictEqual(afterCalled, false);
    });
});
