import typescriptEslint from 'typescript-eslint';

export default [
    // ── Base config ────────────────────────────────────────────────────
    {
        files: ['src/**/*.ts'],
        ignores: ['out/**', 'node_modules/**', '.vscode-test/**'],
    },

    // ── TypeScript rules ───────────────────────────────────────────────
    {
        files: ['src/**/*.ts'],
        plugins: {
            '@typescript-eslint': typescriptEslint.plugin,
        },

        languageOptions: {
            parser: typescriptEslint.parser,
            ecmaVersion: 2022,
            sourceType: 'module',
        },

        rules: {
            // ── Style ──────────────────────────────────────────────────
            '@typescript-eslint/naming-convention': [
                'warn',
                {
                    selector: 'import',
                    format: ['camelCase', 'PascalCase'],
                },
            ],
            curly: 'warn',
            eqeqeq: 'warn',
            semi: 'warn',

            // ── Safety ─────────────────────────────────────────────────
            'no-throw-literal': 'warn',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-restricted-globals': [
                'error',
                {
                    name: 'fetch',
                    message: 'Network calls are prohibited. Use vscode.lm APIs.',
                },
            ],
            'no-restricted-imports': [
                'error',
                {
                    paths: [
                        {
                            name: 'http',
                            message: 'Direct HTTP is prohibited. Use vscode.lm APIs.',
                        },
                        {
                            name: 'https',
                            message: 'Direct HTTPS is prohibited. Use vscode.lm APIs.',
                        },
                        {
                            name: 'axios',
                            message: 'Network calls are prohibited. Use vscode.lm APIs.',
                        },
                        {
                            name: 'node-fetch',
                            message: 'Network calls are prohibited. Use vscode.lm APIs.',
                        },
                    ],
                },
            ],

            // ── Quality ────────────────────────────────────────────────
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            'no-debugger': 'error',
            'no-var': 'error',
            'prefer-const': 'warn',
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
            ],
        },
    },

    // ── Relaxed rules for test files ───────────────────────────────────
    {
        files: ['src/test/**/*.ts'],
        rules: {
            'no-console': 'off',
        },
    },
];
