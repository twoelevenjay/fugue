import * as assert from 'assert';
import { parseHiveSignals } from '../../johann/messageBus';

suite('messageBus', () => {
    // ================================================================
    // parseHiveSignals
    // ================================================================

    suite('parseHiveSignals', () => {
        test('parses broadcast signal', () => {
            const text = 'Some output <!--HIVE_SIGNAL:broadcast:Created package.json--> more text';
            const signals = parseHiveSignals(text);
            assert.strictEqual(signals.length, 1);
            assert.strictEqual(signals[0].type, 'broadcast');
            assert.strictEqual(signals[0].content, 'Created package.json');
        });

        test('parses conflict signal', () => {
            const text = '<!--HIVE_SIGNAL:conflict:I am also modifying src/index.ts-->';
            const signals = parseHiveSignals(text);
            assert.strictEqual(signals.length, 1);
            assert.strictEqual(signals[0].type, 'conflict');
            assert.strictEqual(signals[0].content, 'I am also modifying src/index.ts');
        });

        test('parses request signal', () => {
            const text = '<!--HIVE_SIGNAL:request:Should I use Express or Fastify?-->';
            const signals = parseHiveSignals(text);
            assert.strictEqual(signals.length, 1);
            assert.strictEqual(signals[0].type, 'request');
        });

        test('parses info signal', () => {
            const text = '<!--HIVE_SIGNAL:info:Database schema uses UUID primary keys-->';
            const signals = parseHiveSignals(text);
            assert.strictEqual(signals.length, 1);
            assert.strictEqual(signals[0].type, 'info');
        });

        test('parses multiple signals', () => {
            const text = [
                'Starting work...',
                '<!--HIVE_SIGNAL:broadcast:Created db.ts-->',
                'Some code output',
                '<!--HIVE_SIGNAL:info:Using SQLite-->',
                '<!--HIVE_SIGNAL:broadcast:Created routes.ts-->',
                'Done.',
            ].join('\n');

            const signals = parseHiveSignals(text);
            assert.strictEqual(signals.length, 3);
            assert.strictEqual(signals[0].type, 'broadcast');
            assert.strictEqual(signals[0].content, 'Created db.ts');
            assert.strictEqual(signals[1].type, 'info');
            assert.strictEqual(signals[2].type, 'broadcast');
        });

        test('returns empty array for no signals', () => {
            const signals = parseHiveSignals('Just regular output with no signals');
            assert.strictEqual(signals.length, 0);
        });

        test('returns empty array for empty string', () => {
            const signals = parseHiveSignals('');
            assert.strictEqual(signals.length, 0);
        });

        test('ignores malformed signals', () => {
            const text = [
                '<!--HIVE_SIGNAL:unknown:bad type-->',
                '<!--HIVE_SIGNAL:broadcast:-->', // empty content
                '<!-- HIVE_SIGNAL:broadcast:wrong format -->',
                '<!--HIVE_SIGNAL:broadcast:valid one-->',
            ].join('\n');

            const signals = parseHiveSignals(text);
            // Only the valid one should parse — "unknown" type won't match the enum
            // Empty content won't match because content needs .+
            assert.ok(signals.some((s) => s.content === 'valid one'));
        });

        test('trims whitespace from content', () => {
            const text = '<!--HIVE_SIGNAL:broadcast:  spaces around  -->';
            const signals = parseHiveSignals(text);
            assert.strictEqual(signals.length, 1);
            assert.strictEqual(signals[0].content, 'spaces around');
        });
    });
});
