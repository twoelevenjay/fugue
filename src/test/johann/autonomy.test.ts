import * as assert from 'assert';

// ============================================================================
// Tests for bootstrapContext.ts utility functions and
// orchestrator.ts sanitizeMergeOutput post-filter.
//
// These don't depend on VS Code APIs — they test pure logic.
// ============================================================================

// The sanitizeMergeOutput method is private on Orchestrator. Rather than
// exposing it, we replicate its regex-based filtering here and test the
// patterns independently. If the patterns drift, update these tests.

/** Replicates the sanitizeMergeOutput logic from orchestrator.ts */
function sanitizeMergeOutput(output: string): string {
    let sanitized = output;

    // Remove entire "Next Steps" sections
    sanitized = sanitized.replace(
        /^#{1,4}\s*(Next\s+Steps|Manual\s+Steps|Manual\s+Investigation|What\s+You\s+(Need|Should)\s+to\s+Do|Recommended\s+Next\s+Steps|Recommendations|Action\s+Items|Required\s+Actions)[^\n]*\n[\s\S]*?(?=^#{1,4}\s|\n$)/gim,
        '',
    );

    // Remove individual forbidden phrases
    const forbiddenPatterns = [
        /^[^\n]*\bPlease run\b[^\n]*$/gim,
        /^[^\n]*\bYou should\b[^\n]*$/gim,
        /^[^\n]*\bYou need to\b[^\n]*$/gim,
        /^[^\n]*\bYou'll need to\b[^\n]*$/gim,
        /^[^\n]*\bYou'll want to\b[^\n]*$/gim,
        /^[^\n]*\bYou can then\b[^\n]*$/gim,
        /^[^\n]*\bMake sure to\b[^\n]*$/gim,
        /^[^\n]*\bDon't forget to\b[^\n]*$/gim,
        /^[^\n]*\bWould you like me to\b[^\n]*$/gim,
        /^[^\n]*\bPlease share\b[^\n]*$/gim,
        /^[^\n]*\bAsk the user\b[^\n]*$/gim,
        /^[^\n]*\bTell the user\b[^\n]*$/gim,
        /^[^\n]*\bThe user needs\b[^\n]*$/gim,
        /^[^\n]*\bThe user should\b[^\n]*$/gim,
        /^[^\n]*\bTo fix this,\s*run\b[^\n]*$/gim,
        /^[^\n]*\bTo resolve this\b[^\n]*$/gim,
        /^[^\n]*\bAfter that,\s*you can\b[^\n]*$/gim,
    ];

    for (const pattern of forbiddenPatterns) {
        sanitized = sanitized.replace(pattern, '');
    }

    sanitized = sanitized.replace(/\n{4,}/g, '\n\n');
    return sanitized.trim();
}

// ── truncateFile (from bootstrapContext.ts) ─────────────────────────────
function truncateFile(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
        return content;
    }
    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = Math.floor(maxChars * 0.2);
    const head = content.substring(0, headSize);
    const tail = content.substring(content.length - tailSize);
    const omitted = content.length - headSize - tailSize;
    return head + `\n\n... [${omitted} chars omitted] ...\n\n` + tail;
}

suite('sanitizeMergeOutput', () => {
    test('passes clean output unchanged', () => {
        const clean =
            '### What Was Done\n\nCreated 5 files and ran npm build.\n\n### What Was Created\n\n- src/App.tsx\n- src/index.ts';
        assert.strictEqual(sanitizeMergeOutput(clean), clean);
    });

    test('removes "Next Steps" section', () => {
        const dirty =
            '### What Was Done\n\nCreated files.\n\n### Next Steps\n\n1. Run npm test\n2. Deploy\n\n### Issues Found\n\nNone.';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('Next Steps'), 'Next Steps section should be removed');
        assert.ok(result.includes('What Was Done'), 'What Was Done should remain');
        assert.ok(result.includes('Issues Found'), 'Issues Found should remain');
    });

    test('removes "Manual Investigation" section', () => {
        const dirty =
            '### What Was Done\n\nDone.\n\n## Manual Investigation\n\nCheck the logs.\n\n## Issues Found\n\nNone.';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('Manual Investigation'));
        assert.ok(result.includes('What Was Done'));
    });

    test('removes "What You Need to Do" section', () => {
        const dirty =
            '### What Was Done\n\nDone.\n\n### What You Need to Do\n\n1. Run ddev start\n2. Check URLs';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('What You Need to Do'));
    });

    test('removes individual forbidden phrases', () => {
        const dirty = [
            '### What Was Done',
            '',
            'Created the app.',
            '',
            'Please run `npm test` to verify.',
            'You should check the output.',
            'You need to restart the server.',
            'Make sure to update .env.',
            'Would you like me to help with anything else?',
        ].join('\n');

        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('Please run'), '"Please run" should be removed');
        assert.ok(!result.includes('You should'), '"You should" should be removed');
        assert.ok(!result.includes('You need to'), '"You need to" should be removed');
        assert.ok(!result.includes('Make sure to'), '"Make sure to" should be removed');
        assert.ok(
            !result.includes('Would you like me to'),
            '"Would you like me to" should be removed',
        );
        assert.ok(result.includes('Created the app'), 'Clean content should remain');
    });

    test('removes "You\'ll need to" and "You can then"', () => {
        const dirty = "Files were created.\nYou'll need to run the build.\nYou can then deploy.";
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes("You'll need to"));
        assert.ok(!result.includes('You can then'));
        assert.ok(result.includes('Files were created'));
    });

    test('removes "The user should/needs" phrases', () => {
        const dirty =
            'Task done.\nThe user should restart Docker.\nThe user needs to check permissions.';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('The user should'));
        assert.ok(!result.includes('The user needs'));
    });

    test('removes "To fix this, run" and "To resolve this"', () => {
        const dirty =
            'Build failed.\nTo fix this, run npm install.\nTo resolve this, update the config.';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('To fix this, run'));
        assert.ok(!result.includes('To resolve this'));
    });

    test('cleans up excessive blank lines after removal', () => {
        const dirty = 'Line 1.\n\n\n\n\n\nLine 2.';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('\n\n\n\n'), 'Should not have 4+ consecutive newlines');
    });

    test('handles empty input', () => {
        assert.strictEqual(sanitizeMergeOutput(''), '');
    });

    test('case-insensitive matching', () => {
        const dirty = 'Done.\nPLEASE RUN npm test.\nyou should check.';
        const result = sanitizeMergeOutput(dirty);
        assert.ok(!result.includes('PLEASE RUN'));
        assert.ok(!result.includes('you should'));
    });

    test('preserves "Recommended" in non-section context', () => {
        // "Recommended" alone in prose should NOT be stripped (only section headers)
        const input = 'The recommended approach is to use TypeScript.';
        const result = sanitizeMergeOutput(input);
        assert.ok(result.includes('recommended approach'));
    });
});

suite('truncateFile', () => {
    test('returns short content unchanged', () => {
        const short = 'Hello world';
        assert.strictEqual(truncateFile(short, 100), short);
    });

    test('returns content at exact limit unchanged', () => {
        const exact = 'x'.repeat(100);
        assert.strictEqual(truncateFile(exact, 100), exact);
    });

    test('truncates long content with head + tail', () => {
        const long = 'A'.repeat(500) + 'B'.repeat(500);
        const result = truncateFile(long, 200);
        // Head: 140 chars (70%), Tail: 40 chars (20%)
        assert.ok(result.startsWith('A'.repeat(140)));
        assert.ok(result.endsWith('B'.repeat(40)));
        assert.ok(result.includes('chars omitted'));
    });

    test('includes omission marker', () => {
        const long = 'x'.repeat(1000);
        const result = truncateFile(long, 200);
        assert.ok(result.includes('... ['));
        assert.ok(result.includes('chars omitted] ...'));
    });

    test('total output is within budget plus marker', () => {
        const long = 'x'.repeat(10000);
        const result = truncateFile(long, 2000);
        // Head (1400) + tail (400) + marker (~30 chars) should be < 2000
        assert.ok(result.length < 2100, `Result should be roughly at budget, got ${result.length}`);
    });
});
