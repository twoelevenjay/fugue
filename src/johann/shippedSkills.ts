/**
 * shippedSkills.ts — Built-in skill definitions shipped with the extension
 *
 * These skills are bundled with Fugue and always available.
 * They cannot be modified by users but can be flattened to local-copy.
 * Each skill has strict tool and file scope limits.
 *
 * Shipped skills serve as:
 * 1. Ready-to-use templates for common development tasks
 * 2. Reference examples for the skill schema
 * 3. Safe defaults that enforce good patterns
 *
 * Organized in 6 tiers:
 * - Process skills (scaffold.*, refactor.*, test.*, debug.*, review.*, etc.)
 * - Foundation tier (lang.*) — language-specific conventions
 * - Framework tier (fw.*) — framework-specific patterns
 * - Platform tier (platform.*) — CMS/hosting platform workflows
 * - Database tier (db.*) — database-specific operations
 * - DevOps tier (ops.*) — infrastructure and deployment
 * - Cross-cutting tier (xcut.*) — multi-concern patterns
 */

import { SkillDoc } from './skillTypes';
import { TaskType } from './types';

// ============================================================================
// Helper — compact skill factory to avoid repeated boilerplate
// ============================================================================

function shipped(opts: {
    slug: string;
    title: string;
    description: string;
    tags: string[];
    task_types: TaskType[];
    languages?: string[];
    frameworks?: string[];
    repo_patterns?: string[];
    keywords: string[];
    dependencies?: string[];
    body: string;
    steps?: string[];
    allowed_file_patterns?: string[];
}): SkillDoc {
    return {
        schema_version: 'johann.skill.v1',
        metadata: {
            slug: opts.slug,
            version: '1.0.0',
            title: opts.title,
            description: opts.description,
            tags: opts.tags,
            scope: 'shipped',
            origin: 'shipped',
            created_at: '2025-01-01T00:00:00.000Z',
        },
        applies_to: {
            task_types: opts.task_types,
            languages: opts.languages,
            frameworks: opts.frameworks,
            repo_patterns: opts.repo_patterns,
            keywords: opts.keywords,
            dependencies: opts.dependencies,
        },
        instruction: {
            body: opts.body,
            steps: opts.steps,
        },
        security: {
            allowed_tools: [],
            allowed_file_patterns: opts.allowed_file_patterns || ['**/*'],
            max_instruction_chars: 8000,
        },
        history: {
            total_uses: 0,
            runs_used_in: 0,
            recent_run_ids: [],
            unused_run_streak: 0,
        },
    };
}

// ============================================================================
// Shipped Skill Definitions
// ============================================================================

const scaffoldComponent: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'scaffold.component',
        version: '1.0.0',
        title: 'Scaffold a UI Component',
        description:
            'Generate a new UI component with proper structure, types, styles, and test file following project conventions.',
        tags: ['scaffold', 'component', 'ui', 'generate'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate'],
        languages: ['typescript', 'javascript', 'tsx', 'jsx'],
        frameworks: ['react', 'vue', 'svelte', 'angular', 'solid'],
        keywords: [
            'component',
            'scaffold',
            'create component',
            'new component',
            'ui component',
            'widget',
        ],
    },
    instruction: {
        body: `When scaffolding a UI component, follow these rules:

1. Detect the project's component conventions by examining existing components in the workspace.
2. Match the naming pattern (PascalCase for React/Vue/Angular, kebab-case for file names if that's the convention).
3. Create the component file with proper TypeScript types for all props.
4. Create a co-located test file using the project's test framework.
5. Create a styles file if the project uses CSS modules, styled-components, or similar.
6. Export the component from the nearest index/barrel file if one exists.
7. Include JSDoc comments on the component and its props interface.

Do NOT:
- Add dependencies not already in package.json
- Create deeply nested folder structures unless that matches the project pattern
- Use inline styles unless the project convention is inline styles`,
        steps: [
            'Scan existing components to detect conventions (naming, structure, test pattern)',
            'Create the component file with typed props and proper imports',
            'Create a test file with at least one render test and one interaction test',
            'Create a styles file if the project uses co-located styles',
            'Update the nearest barrel/index file to export the new component',
            'Verify the component compiles without errors',
        ],
        output_format: 'Files created with a summary of the component structure',
        inputs: ['Component name', 'Props description (optional)', 'Target directory (optional)'],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/*.tsx',
            '**/*.jsx',
            '**/*.ts',
            '**/*.js',
            '**/*.css',
            '**/*.scss',
            '**/*.module.*',
            '**/*.test.*',
            '**/*.spec.*',
            '**/index.ts',
            '**/index.js',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const scaffoldCliCommand: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'scaffold.cli.command',
        version: '1.0.0',
        title: 'Scaffold a CLI Command',
        description:
            'Generate a new CLI command with argument parsing, help text, and test file following the project CLI structure.',
        tags: ['scaffold', 'cli', 'command', 'generate'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate'],
        languages: ['typescript', 'javascript', 'python', 'go'],
        keywords: [
            'cli',
            'command',
            'subcommand',
            'scaffold command',
            'new command',
            'create command',
        ],
    },
    instruction: {
        body: `When scaffolding a CLI command:

1. Detect the CLI framework in use (yargs, commander, cobra, click, argparse, etc.).
2. Follow the existing command structure and registration pattern.
3. Include proper argument/flag definitions with types, defaults, and help text.
4. Add validation for required arguments.
5. Create a test file that tests argument parsing and command execution.
6. Register the command in the CLI's command registry or entry point.

The command should follow the project's error handling patterns (exit codes, error output format).`,
        steps: [
            'Identify the CLI framework and existing command patterns',
            'Create the command file with argument definitions',
            'Add input validation and error handling',
            'Create a test file for the command',
            'Register the command in the CLI entry point',
            'Verify the command appears in help output',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/cmd/**',
            '**/commands/**',
            '**/cli/**',
            '**/*.ts',
            '**/*.js',
            '**/*.py',
            '**/*.go',
            '**/*.test.*',
            '**/*.spec.*',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const refactorExtractModule: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'refactor.extract.module',
        version: '1.0.0',
        title: 'Extract Code into a Separate Module',
        description:
            'Refactor by extracting related code from a large file into a dedicated module while preserving all existing behavior.',
        tags: ['refactor', 'extract', 'module', 'separation'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['refactor', 'complex-refactor'],
        keywords: [
            'extract',
            'module',
            'split file',
            'separate',
            'decompose',
            'break apart',
            'too large',
            'too long',
        ],
    },
    instruction: {
        body: `When extracting code into a separate module:

1. Identify the cohesive set of functions/classes/types to extract based on the user's request.
2. Analyze ALL imports and exports of the target symbols to build a complete dependency graph.
3. Create the new module file with the extracted code.
4. Update the original file to import from the new module instead.
5. Update ALL other files that import the moved symbols to point to the new location.
6. If the original file had a barrel/index export, update it to re-export from the new module for backward compatibility.
7. Verify no circular dependencies are introduced.

CRITICAL: Every import reference must be updated. Missing even one causes a build break.`,
        steps: [
            'Map all symbols to extract and their dependents across the codebase',
            'Create the new module with the extracted code and proper exports',
            'Update the original file (remove extracted code, add import from new module)',
            'Update all importing files to point to the new module',
            'Update barrel/index files for backward compatibility',
            'Check for circular dependencies',
            'Verify the project compiles and tests pass',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/*.ts',
            '**/*.js',
            '**/*.tsx',
            '**/*.jsx',
            '**/*.py',
            '**/*.go',
            '**/index.*',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const testGenerateUnit: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'test.generate.unit',
        version: '1.0.0',
        title: 'Generate Unit Tests',
        description:
            'Generate comprehensive unit tests with edge cases, mocks, and assertions following the project test conventions.',
        tags: ['test', 'unit', 'generate', 'testing'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['test', 'generate'],
        keywords: [
            'test',
            'unit test',
            'tests',
            'testing',
            'coverage',
            'spec',
            'write tests',
            'add tests',
        ],
    },
    instruction: {
        body: `When generating unit tests:

1. Detect the test framework (jest, mocha, vitest, pytest, go test, etc.) from project configuration.
2. Follow the project's test file naming convention (*.test.ts, *.spec.ts, *_test.go, test_*.py, etc.).
3. Follow the project's test organization (describe/it blocks, test suites, etc.).
4. Generate tests for:
   - Happy path (normal expected behavior)
   - Edge cases (empty inputs, boundary values, null/undefined)
   - Error conditions (invalid inputs, thrown errors)
   - Type-specific behavior (if TypeScript/typed language)
5. Use the project's existing mocking patterns (jest.mock, sinon, testdouble, etc.).
6. Include meaningful assertion messages.
7. Group related tests logically.

Do NOT:
- Test implementation details (private methods, internal state)
- Create brittle snapshot tests unless specifically asked
- Import test utilities not already in the project`,
        steps: [
            'Read the source file to understand all public APIs',
            'Detect test framework and conventions from existing tests',
            'Generate happy path tests for each public function/method',
            'Generate edge case tests (boundaries, empty inputs, null)',
            'Generate error condition tests',
            'Add proper mocks/stubs as needed',
            'Verify tests compile and pass',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/*.test.*',
            '**/*.spec.*',
            '**/*_test.*',
            '**/test_*.*',
            '**/test/**',
            '**/tests/**',
            '**/__tests__/**',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const debugRootCauseAnalysis: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'debug.root-cause.analysis',
        version: '1.0.0',
        title: 'Root Cause Analysis for Bugs',
        description: 'Systematically diagnose and fix bugs by tracing from symptoms to root cause.',
        tags: ['debug', 'root-cause', 'analysis', 'fix', 'bug'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['debug'],
        keywords: [
            'bug',
            'fix',
            'broken',
            'not working',
            'error',
            'crash',
            'root cause',
            'diagnose',
            'debug',
            'failing',
        ],
    },
    instruction: {
        body: `When performing root cause analysis:

1. REPRODUCE: Understand the symptoms. What is the expected vs. actual behavior?
2. ISOLATE: Narrow down which file/function/line is responsible.
   - Check error messages, stack traces, and logs.
   - Use binary search on recent changes if applicable.
3. TRACE: Follow the data flow from input to the point of failure.
   - What values are unexpected? Where do they come from?
   - Are there race conditions, stale caches, or order-of-operations issues?
4. ROOT CAUSE: Identify the fundamental cause (not just the symptom).
   - Is it a logic error, type mismatch, missing null check, stale data, etc.?
5. FIX: Apply the minimal targeted fix.
   - Do not rewrite unrelated code.
   - Preserve existing behavior for non-buggy paths.
6. VERIFY: Confirm the fix resolves the issue.
   - Add a test case that would have caught this bug.

Report your findings in this structure:
- Symptom: [what the user observed]
- Root Cause: [what actually went wrong]
- Fix: [what was changed and why]
- Prevention: [test or guard added]`,
        steps: [
            'Reproduce or understand the symptom from the bug description',
            'Locate the relevant code paths (errors, stack traces, logs)',
            'Trace the data flow to identify where values diverge from expected',
            'Identify the root cause (not just the symptom)',
            'Apply a minimal, targeted fix',
            'Add a regression test that catches this bug',
            'Verify the fix compiles and existing tests pass',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: ['**/*'],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const reviewCodeRubric: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'review.code.rubric',
        version: '1.0.0',
        title: 'Structured Code Review',
        description:
            'Perform a structured code review against a quality rubric covering correctness, readability, security, and performance.',
        tags: ['review', 'code-review', 'quality', 'rubric'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['review'],
        keywords: [
            'review',
            'code review',
            'quality',
            'feedback',
            'critique',
            'audit',
            'check',
            'inspect',
        ],
    },
    instruction: {
        body: `When reviewing code, evaluate against this rubric:

**Correctness (Critical)**
- Does the code do what it claims?
- Are error paths handled?
- Are edge cases covered?
- Are types correct and exhaustive?

**Readability (Important)**
- Are names descriptive and consistent?
- Is the code self-documenting?
- Are comments helpful (not redundant)?
- Is the structure logical?

**Security (Critical)**
- Is user input validated/sanitized?
- Are there injection risks (SQL, XSS, command)?
- Are secrets hardcoded or logged?
- Are permissions checked properly?

**Performance (Moderate)**
- Are there unnecessary allocations or copies?
- Are there O(n^2) or worse patterns that could be optimized?
- Are resources properly released (connections, handles)?

**Maintainability (Important)**
- Is there test coverage for the changes?
- Are there magic numbers or hardcoded values?
- Is the code DRY without being over-abstracted?

Format output as a structured review with severity levels: CRITICAL, WARNING, SUGGESTION, PRAISE.`,
        steps: [
            'Read and understand the code changes in context',
            'Evaluate correctness: logic, error handling, edge cases',
            'Evaluate readability: naming, structure, documentation',
            'Evaluate security: input validation, injection risks, secrets',
            'Evaluate performance: complexity, resource management',
            'Evaluate maintainability: tests, duplication, abstraction',
            'Format findings with severity and specific line references',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: ['**/*'],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const migrateApiVersion: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'migrate.api.version',
        version: '1.0.0',
        title: 'Migrate API Version',
        description:
            'Systematically migrate code from one API version to another, updating all call sites and handling breaking changes.',
        tags: ['migrate', 'api', 'upgrade', 'version', 'breaking-change'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['refactor', 'complex-refactor'],
        keywords: [
            'migrate',
            'upgrade',
            'api version',
            'breaking change',
            'deprecation',
            'update dependency',
            'version bump',
        ],
    },
    instruction: {
        body: `When migrating an API version:

1. ANALYZE: Understand the migration scope.
   - What API is being upgraded? (library, framework, internal API)
   - What version are we migrating from/to?
   - What are the breaking changes?
2. INVENTORY: Find all call sites.
   - Search the codebase for all usages of the affected APIs.
   - Track import statements, function calls, type references.
3. PLAN: Order the changes to avoid intermediate breakage.
   - Update types/interfaces first.
   - Then update implementations.
   - Then update call sites.
   - Finally update tests.
4. MIGRATE: Apply changes systematically.
   - Handle renamed APIs (find/replace with new names).
   - Handle removed APIs (implement alternatives).
   - Handle changed signatures (update parameters).
   - Handle changed behavior (adjust logic).
5. VERIFY: Ensure nothing was missed.
   - Search for any remaining references to old API names.
   - Verify the project compiles.
   - Run the test suite.`,
        steps: [
            'Identify the API and version change (from → to)',
            'List all breaking changes between versions',
            'Find all affected files and call sites',
            'Update type definitions and interfaces',
            'Update implementations and call sites',
            'Update test code',
            'Build and run tests to verify migration',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/*.ts',
            '**/*.js',
            '**/*.tsx',
            '**/*.jsx',
            '**/*.py',
            '**/*.go',
            '**/package.json',
            '**/go.mod',
            '**/requirements.txt',
            '**/pyproject.toml',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const optimizePerformanceHotspot: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'optimize.performance.hotspot',
        version: '1.0.0',
        title: 'Optimize Performance Hotspot',
        description:
            'Analyze and optimize a performance-critical section of code, focusing on algorithmic improvements and resource efficiency.',
        tags: ['optimize', 'performance', 'hotspot', 'speed', 'memory'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['refactor'],
        keywords: [
            'optimize',
            'performance',
            'slow',
            'speed',
            'fast',
            'hotspot',
            'bottleneck',
            'memory',
            'efficient',
        ],
    },
    instruction: {
        body: `When optimizing a performance hotspot:

1. PROFILE: Understand the current performance characteristics.
   - What is slow? (startup, specific operation, memory usage)
   - What is the current time/space complexity?
   - Are there existing benchmarks or measurements?
2. ANALYZE: Identify optimization opportunities.
   - Unnecessary allocations (object/array creation in loops)
   - Redundant computations (values computed multiple times)
   - Algorithmic improvements (O(n^2) → O(n log n))
   - Data structure improvements (array → set/map for lookups)
   - I/O bottlenecks (sequential → parallel, buffering)
   - Caching opportunities (memoization, LRU cache)
3. OPTIMIZE:
   - Apply the highest-impact optimization first.
   - Preserve identical external behavior (same inputs → same outputs).
   - Add comments explaining WHY the optimization works.
   - Do NOT sacrifice readability for micro-optimizations.
4. MEASURE: Document the expected improvement.
   - Before/after complexity analysis.
   - If benchmarks exist, note expected speedup.

IMPORTANT: Premature optimization is the root of all evil. Only optimize code that is actually slow, not code that might theoretically be slow.`,
        steps: [
            'Understand the performance problem (what is slow and why it matters)',
            'Analyze the current complexity and identify bottlenecks',
            'Identify optimization opportunities (algorithmic, caching, I/O)',
            'Apply optimizations while preserving behavior',
            'Document the optimization rationale in comments',
            'Verify correctness with existing tests',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: ['**/*'],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const docsGenerateReadme: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'docs.generate.readme',
        version: '1.0.0',
        title: 'Generate Project README',
        description:
            'Generate or update a comprehensive README.md with installation, usage, API reference, and contribution guidelines.',
        tags: ['docs', 'readme', 'documentation', 'generate'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate', 'spec'],
        keywords: ['readme', 'documentation', 'docs', 'document', 'write docs', 'generate readme'],
    },
    instruction: {
        body: `When generating or updating a README:

1. Analyze the project structure to understand:
   - What the project does (package.json description, main entry point)
   - How to install it (package manager, build steps)
   - How to use it (CLI commands, API, configuration)
   - How to develop it (dev setup, test commands, build commands)
2. Generate sections in this order:
   - Title and one-line description
   - Badges (if CI/CD is configured)
   - Overview (2-3 paragraphs explaining purpose and key features)
   - Installation
   - Quick Start / Usage
   - API Reference (for libraries) or Commands (for CLIs)
   - Configuration (environment variables, config files)
   - Development (setup, test, build, lint commands)
   - Contributing (if CONTRIBUTING.md exists, link to it)
   - License
3. Use real examples from the codebase, not generic placeholders.
4. If updating an existing README, preserve custom sections the user added.`,
        steps: [
            'Analyze project structure, package.json, and entry points',
            'Identify installation and build requirements',
            'Document key APIs or commands with examples',
            'Document configuration options',
            'Generate or update README.md with all sections',
            'Verify all referenced commands actually work',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/README.md',
            '**/README.*',
            '**/package.json',
            '**/go.mod',
            '**/pyproject.toml',
            '**/Makefile',
            '**/Dockerfile',
            '**/.env.example',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

const releasePrepareVersionBump: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'release.prepare.version.bump',
        version: '1.0.0',
        title: 'Prepare a Version Bump Release',
        description:
            'Prepare a release by bumping version numbers, updating changelogs, and verifying release readiness.',
        tags: ['release', 'version', 'bump', 'changelog', 'prepare'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate', 'refactor'],
        keywords: [
            'release',
            'version',
            'bump',
            'changelog',
            'prepare release',
            'ship',
            'tag',
            'publish',
        ],
    },
    instruction: {
        body: `When preparing a version bump release:

1. Determine the version bump type based on changes since last release:
   - MAJOR: Breaking API changes
   - MINOR: New features, no breaking changes
   - PATCH: Bug fixes only
2. Update version in all relevant files:
   - package.json (and package-lock.json if it exists)
   - Version constants in source code
   - Cargo.toml, pyproject.toml, go module version as applicable
3. Update CHANGELOG.md:
   - Add a new version section with today's date
   - Categorize changes: Added, Changed, Fixed, Removed, Security
   - Include PR/issue references where available
   - Move "Unreleased" contents to the new version section
4. Verify release readiness:
   - All tests pass
   - No uncommitted changes (other than the version bump)
   - README is up to date
   - Breaking changes are documented

Do NOT:
- Create git tags (leave that to the user or CI)
- Push changes (leave that to the user)
- Modify CI/CD configuration`,
        steps: [
            'Analyze commits since last release to determine bump type',
            'Update version numbers in all relevant files',
            'Update CHANGELOG.md with categorized changes',
            'Verify tests pass with the new version',
            'Summarize what was changed and what the user should do next',
        ],
    },
    security: {
        allowed_tools: [],
        allowed_file_patterns: [
            '**/package.json',
            '**/package-lock.json',
            '**/CHANGELOG.md',
            '**/CHANGES.md',
            '**/HISTORY.md',
            '**/version.ts',
            '**/version.py',
            '**/version.go',
            '**/Cargo.toml',
            '**/pyproject.toml',
        ],
        max_instruction_chars: 8000,
    },
    history: {
        total_uses: 0,
        runs_used_in: 0,
        recent_run_ids: [],
        unused_run_streak: 0,
    },
};

// ============================================================================
// TIER 1: FOUNDATION — Language-Specific Skills (lang.*)
// ============================================================================

const langTypescript = shipped({
    slug: 'lang.typescript',
    title: 'TypeScript Conventions',
    description:
        'TypeScript-specific patterns: strict mode, type narrowing, generics, declaration files, module resolution.',
    tags: ['language', 'typescript', 'types'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'tsx'],
    keywords: [
        'typescript',
        'ts',
        'tsx',
        'type',
        'interface',
        'generic',
        'enum',
        'declaration',
        'tsconfig',
    ],
    body: `TypeScript conventions for all generated and refactored code:

1. Always use strict mode (strict: true in tsconfig.json).
2. Prefer interfaces over type aliases for object shapes.
3. Use discriminated unions for state machines and tagged types.
4. Never use \`any\` — use \`unknown\` and narrow with type guards.
5. Use \`readonly\` for properties that should not be mutated.
6. Prefer \`const\` assertions for literal types.
7. Use barrel exports (index.ts) for public API surfaces.
8. Import types with \`import type { ... }\` when only used in type position.
9. Use \`satisfies\` operator for type-safe object literals.
10. Handle nullability explicitly — never use non-null assertions (!).`,
    allowed_file_patterns: ['**/*.ts', '**/*.tsx', '**/tsconfig*.json'],
});

const langJavascript = shipped({
    slug: 'lang.javascript',
    title: 'JavaScript Conventions',
    description:
        'JavaScript-specific patterns: ES modules, async/await, error handling, modern syntax.',
    tags: ['language', 'javascript'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['javascript', 'jsx'],
    keywords: ['javascript', 'js', 'jsx', 'es6', 'esm', 'commonjs', 'node', 'promise', 'async'],
    body: `JavaScript conventions:

1. Use ES modules (import/export) over CommonJS (require) unless the project requires it.
2. Use async/await over raw Promises and callbacks.
3. Use const by default, let when reassignment is needed. Never var.
4. Use optional chaining (?.) and nullish coalescing (??) for safe access.
5. Use template literals over string concatenation.
6. Use destructuring for function parameters and assignments.
7. Use Array methods (map, filter, reduce) over imperative loops when clearer.
8. Always handle Promise rejections — no unhandled promise rejections.
9. Use strict equality (===) over loose equality (==).
10. Use named exports over default exports for better IDE support.`,
    allowed_file_patterns: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
});

const langPython = shipped({
    slug: 'lang.python',
    title: 'Python Conventions',
    description: 'Python-specific patterns: PEP 8, type hints, virtual environments, packaging.',
    tags: ['language', 'python'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['python'],
    keywords: [
        'python',
        'py',
        'pip',
        'venv',
        'django',
        'flask',
        'fastapi',
        'pytest',
        'pep8',
        'type hint',
    ],
    body: `Python conventions:

1. Follow PEP 8 style guide. Use 4-space indentation.
2. Add type hints to all function signatures (PEP 484).
3. Use f-strings over .format() or % formatting.
4. Use pathlib.Path over os.path for file operations.
5. Use dataclasses or Pydantic models for structured data.
6. Use context managers (with statements) for resource management.
7. Use list/dict/set comprehensions when they improve readability.
8. Use virtual environments (venv or conda).
9. Handle exceptions with specific types, never bare except.
10. Use __all__ to define public API in __init__.py.
11. Use pytest for testing. Fixtures over setUp/tearDown.`,
    allowed_file_patterns: [
        '**/*.py',
        '**/requirements*.txt',
        '**/pyproject.toml',
        '**/setup.py',
        '**/setup.cfg',
    ],
});

const langPhp = shipped({
    slug: 'lang.php',
    title: 'PHP Conventions',
    description:
        'PHP-specific patterns: PSR standards, Composer, type declarations, modern PHP syntax.',
    tags: ['language', 'php'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['php'],
    keywords: ['php', 'composer', 'psr', 'laravel', 'symfony', 'wordpress', 'artisan', 'namespace'],
    body: `PHP conventions:

1. Follow PSR-12 coding standard.
2. Use strict types: declare(strict_types=1) at the top of every file.
3. Use type declarations for all parameters, return types, and properties.
4. Use Composer for dependency management. Never commit vendor/.
5. Use namespaces following PSR-4 autoloading.
6. Use null coalescing (??) and null safe (?->) operators.
7. Use match expressions over switch when appropriate.
8. Use named arguments for functions with many parameters.
9. Use enum types (PHP 8.1+) for state values.
10. Use readonly properties and constructor promotion.
11. Never use \`@\` error suppression operator.`,
    allowed_file_patterns: ['**/*.php', '**/composer.json', '**/composer.lock', '**/phpunit.xml*'],
});

const langHtml = shipped({
    slug: 'lang.html',
    title: 'HTML Conventions',
    description:
        'HTML-specific patterns: semantic markup, accessibility, meta tags, structured data.',
    tags: ['language', 'html', 'accessibility'],
    task_types: ['generate', 'refactor', 'review'],
    languages: ['html'],
    keywords: [
        'html',
        'markup',
        'semantic',
        'accessibility',
        'a11y',
        'aria',
        'meta',
        'head',
        'template',
    ],
    body: `HTML conventions:

1. Use semantic elements (header, nav, main, section, article, footer) over generic divs.
2. Always include lang attribute on <html>.
3. All images must have alt attributes (empty for decorative images).
4. Use proper heading hierarchy (h1 → h2 → h3, no skipping).
5. Form inputs must have associated <label> elements.
6. Include viewport meta tag for responsive design.
7. Use ARIA attributes only when semantic HTML is insufficient.
8. Prefer native interactive elements (button, a, input) over div with click handlers.
9. Include proper meta tags (charset, description, open graph).
10. Use loading="lazy" for below-the-fold images.`,
    allowed_file_patterns: [
        '**/*.html',
        '**/*.htm',
        '**/*.twig',
        '**/*.blade.php',
        '**/*.ejs',
        '**/*.hbs',
    ],
});

const langCss = shipped({
    slug: 'lang.css',
    title: 'CSS Conventions',
    description:
        'CSS-specific patterns: custom properties, modern layout, responsive design, naming.',
    tags: ['language', 'css', 'styling'],
    task_types: ['generate', 'refactor', 'review'],
    languages: ['css', 'scss', 'less'],
    keywords: [
        'css',
        'scss',
        'sass',
        'less',
        'tailwind',
        'style',
        'responsive',
        'flexbox',
        'grid',
        'animation',
    ],
    body: `CSS conventions:

1. Use CSS custom properties (--var-name) for theming and reusable values.
2. Use CSS Grid for 2D layouts, Flexbox for 1D alignment.
3. Mobile-first responsive design with min-width media queries.
4. Use logical properties (margin-inline, padding-block) for internationalization.
5. Avoid !important except for utilities.
6. Use BEM naming (.block__element--modifier) unless using CSS Modules/Tailwind.
7. Define a consistent spacing scale.
8. Use clamp() for fluid typography.
9. Prefer transform/opacity animations for performance (GPU-accelerated).
10. Group properties: position, display, box-model, typography, visual, misc.`,
    allowed_file_patterns: [
        '**/*.css',
        '**/*.scss',
        '**/*.less',
        '**/*.module.*',
        '**/tailwind.config.*',
    ],
});

const langJava = shipped({
    slug: 'lang.java',
    title: 'Java Conventions',
    description:
        'Java-specific patterns: modern Java features, Spring patterns, build tools, testing.',
    tags: ['language', 'java'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['java'],
    keywords: ['java', 'spring', 'maven', 'gradle', 'jvm', 'junit', 'bean', 'servlet'],
    body: `Java conventions:

1. Use records for immutable data carriers.
2. Use sealed interfaces/classes for restricted hierarchies.
3. Use var for local variables with obvious types.
4. Use switch expressions with pattern matching.
5. Use Optional instead of null for optional return values.
6. Use try-with-resources for AutoCloseable resources.
7. Use Stream API for collection transformations.
8. Follow Maven/Gradle project structure conventions.
9. Use JUnit 5 with @Nested classes for test organization.
10. Prefer constructor injection over field injection in Spring.`,
    allowed_file_patterns: [
        '**/*.java',
        '**/pom.xml',
        '**/build.gradle*',
        '**/*.properties',
        '**/*.yml',
    ],
});

const langRust = shipped({
    slug: 'lang.rust',
    title: 'Rust Conventions',
    description: 'Rust-specific patterns: ownership, error handling, traits, cargo, unsafe code.',
    tags: ['language', 'rust'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['rust'],
    keywords: [
        'rust',
        'cargo',
        'crate',
        'trait',
        'lifetime',
        'borrow',
        'ownership',
        'unsafe',
        'wasm',
    ],
    body: `Rust conventions:

1. Use Result<T, E> for fallible operations, never panic in library code.
2. Use the ? operator for error propagation.
3. Prefer &str over String for function parameters.
4. Use derive macros for common traits (Debug, Clone, PartialEq, etc.).
5. Use enums for state machines and error types.
6. Minimize use of .unwrap() and .expect() — use proper error handling.
7. Use iterators and functional combinators over imperative loops.
8. Keep unsafe blocks minimal and well-documented.
9. Use cargo clippy for lint checks, cargo fmt for formatting.
10. Document public API with /// doc comments.`,
    allowed_file_patterns: ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock'],
});

const langGo = shipped({
    slug: 'lang.go',
    title: 'Go Conventions',
    description: 'Go-specific patterns: error handling, interfaces, goroutines, modules.',
    tags: ['language', 'go'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['go'],
    keywords: ['go', 'golang', 'goroutine', 'channel', 'interface', 'go mod', 'gofmt'],
    body: `Go conventions:

1. Handle all errors explicitly — never ignore returned errors.
2. Use error wrapping with fmt.Errorf("context: %w", err).
3. Accept interfaces, return structs.
4. Use short variable names in small scopes, descriptive names for exports.
5. Group declarations: imports, constants, types, variables, functions.
6. Use table-driven tests with subtests (t.Run).
7. Use context.Context for request-scoped values and cancellation.
8. Prefer composition over inheritance via embedding.
9. Run gofmt/goimports on all code.
10. Use go vet and staticcheck for analysis.`,
    allowed_file_patterns: ['**/*.go', '**/go.mod', '**/go.sum'],
});

const langSql = shipped({
    slug: 'lang.sql',
    title: 'SQL Conventions',
    description:
        'SQL-specific patterns: query optimization, indexing, migrations, parameterized queries.',
    tags: ['language', 'sql', 'database'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['sql'],
    keywords: [
        'sql',
        'query',
        'migration',
        'index',
        'join',
        'subquery',
        'stored procedure',
        'view',
    ],
    body: `SQL conventions:

1. ALWAYS use parameterized queries — never concatenate user input into SQL strings.
2. Use uppercase for SQL keywords (SELECT, FROM, WHERE, JOIN).
3. Use meaningful table and column names (snake_case).
4. Always specify column names in INSERT statements.
5. Use appropriate indexes for frequently queried columns.
6. Use EXPLAIN/EXPLAIN ANALYZE to verify query plans.
7. Prefer JOINs over subqueries when performance allows.
8. Use database migrations for all schema changes.
9. Always include WHERE clauses on UPDATE/DELETE — never update entire tables accidentally.
10. Use transactions for multi-statement operations.`,
    allowed_file_patterns: ['**/*.sql', '**/migrations/**', '**/seeds/**'],
});

// ============================================================================
// TIER 2: FRAMEWORK — Framework-Specific Skills (fw.*)
// ============================================================================

const fwReact = shipped({
    slug: 'fw.react',
    title: 'React Patterns',
    description:
        'React-specific: hooks, component patterns, state management, performance, React 18+.',
    tags: ['framework', 'react'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    frameworks: ['react'],
    keywords: [
        'react',
        'hook',
        'useState',
        'useEffect',
        'component',
        'jsx',
        'tsx',
        'next',
        'remix',
    ],
    dependencies: ['lang.typescript'],
    body: `React conventions:

1. Use functional components with hooks. No class components unless migrating.
2. Custom hooks for shared stateful logic — prefix with "use" (useAuth, useFetch).
3. Use React.memo() only for measured performance issues.
4. Keep useEffect dependencies accurate — never suppress ESLint warnings.
5. Co-locate state close to where it's used. Lift only when necessary.
6. Use Suspense and lazy() for code splitting.
7. Handle loading, error, and empty states for all async data.
8. Use forwardRef only when the component needs to expose a DOM node.
9. Key prop must be stable and unique — never use array index for dynamic lists.
10. Prefer controlled components for forms.`,
    allowed_file_patterns: [
        '**/*.tsx',
        '**/*.jsx',
        '**/*.ts',
        '**/*.js',
        '**/*.css',
        '**/*.module.*',
    ],
});

const fwVue = shipped({
    slug: 'fw.vue',
    title: 'Vue Patterns',
    description:
        'Vue 3-specific: Composition API, script setup, Pinia, VueRouter, Nuxt conventions.',
    tags: ['framework', 'vue'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'javascript', 'vue'],
    frameworks: ['vue', 'nuxt'],
    keywords: [
        'vue',
        'vuejs',
        'nuxt',
        'pinia',
        'composition api',
        'script setup',
        'v-model',
        'directive',
    ],
    dependencies: ['lang.typescript'],
    body: `Vue 3 conventions:

1. Use <script setup> with Composition API for all new components.
2. Use defineProps, defineEmits, defineExpose for component API.
3. Use Pinia for state management (not Vuex).
4. Use ref() for primitives, reactive() for objects.
5. Use computed() instead of methods for derived state.
6. Use watchEffect() for side effects, watch() for specific values.
7. Use provide/inject for dependency injection across component trees.
8. Follow Single File Component (.vue) structure: template → script → style.
9. Use scoped styles with <style scoped>.
10. Use dynamic imports for route-level code splitting.`,
    allowed_file_patterns: ['**/*.vue', '**/*.ts', '**/*.js', '**/nuxt.config.*'],
});

const fwNextjs = shipped({
    slug: 'fw.nextjs',
    title: 'Next.js Patterns',
    description:
        'Next.js-specific: App Router, Server Components, API routes, SSR/SSG, middleware.',
    tags: ['framework', 'nextjs', 'react'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    frameworks: ['nextjs', 'react'],
    keywords: [
        'nextjs',
        'next.js',
        'app router',
        'server component',
        'api route',
        'ssr',
        'ssg',
        'middleware',
        'rsc',
    ],
    dependencies: ['fw.react'],
    body: `Next.js conventions (App Router):

1. Use Server Components by default. Add 'use client' only when needed (interactivity, hooks, browser APIs).
2. Use the app/ directory structure with layout.tsx, page.tsx, loading.tsx, error.tsx.
3. Use Route Handlers (app/api/) for API endpoints.
4. Use Server Actions for form submissions and mutations.
5. Use generateMetadata() for dynamic SEO metadata.
6. Use next/image for all images (automatic optimization).
7. Use next/link for all internal navigation (prefetching).
8. Implement loading.tsx for Suspense boundaries.
9. Use middleware.ts for auth, redirects, and request rewriting.
10. Use environment variables with NEXT_PUBLIC_ prefix for client-accessible values.`,
    allowed_file_patterns: [
        '**/*.tsx',
        '**/*.ts',
        '**/*.jsx',
        '**/*.js',
        '**/next.config.*',
        '**/middleware.ts',
    ],
});

const fwNuxtjs = shipped({
    slug: 'fw.nuxtjs',
    title: 'Nuxt.js Patterns',
    description: 'Nuxt 3-specific: auto-imports, server routes, useFetch, composables, modules.',
    tags: ['framework', 'nuxtjs', 'vue'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'javascript', 'vue'],
    frameworks: ['nuxt', 'vue'],
    keywords: [
        'nuxt',
        'nuxtjs',
        'nuxt3',
        'useFetch',
        'useAsyncData',
        'server route',
        'nitro',
        'composable',
    ],
    dependencies: ['fw.vue'],
    body: `Nuxt 3 conventions:

1. Leverage auto-imports — don't manually import Vue/Nuxt composables.
2. Use useFetch/useAsyncData for data fetching (automatic SSR/client handling).
3. Use server/ directory for API routes (Nitro server).
4. Use composables/ directory for shared composable functions.
5. Use app.config.ts for runtime configuration, nuxt.config.ts for build config.
6. Use definePageMeta() for page-level middleware and layouts.
7. Use <NuxtLink> for all internal navigation.
8. Use <NuxtPage> and layouts/ for page layouts.
9. Use Nuxt modules for plugin integration.
10. Use useState() for SSR-safe shared state across components.`,
    allowed_file_patterns: ['**/*.vue', '**/*.ts', '**/*.js', '**/nuxt.config.*', '**/server/**'],
});

const fwTailwind = shipped({
    slug: 'fw.tailwind',
    title: 'Tailwind CSS Patterns',
    description:
        'Tailwind CSS-specific: utility classes, custom configuration, component patterns, responsive design.',
    tags: ['framework', 'tailwind', 'css'],
    task_types: ['generate', 'refactor', 'review'],
    languages: ['css', 'html', 'typescript', 'javascript'],
    frameworks: ['tailwind'],
    keywords: [
        'tailwind',
        'tailwindcss',
        'utility class',
        'responsive',
        'dark mode',
        'tw-',
        'className',
    ],
    dependencies: ['lang.css'],
    body: `Tailwind CSS conventions:

1. Use utility classes directly in markup — avoid custom CSS when Tailwind provides utilities.
2. Use @apply in component CSS only for highly-repeated patterns.
3. Configure design tokens in tailwind.config.js (colors, spacing, fonts).
4. Use responsive prefixes mobile-first: sm:, md:, lg:, xl:, 2xl:.
5. Use dark: prefix for dark mode support.
6. Group related utilities logically: layout → spacing → sizing → typography → colors → effects.
7. Use arbitrary values [value] sparingly — extend the config instead.
8. Use @tailwindcss/typography for prose content.
9. Use ring utilities for focus indicators (accessibility).
10. Purge unused styles in production via content configuration.`,
    allowed_file_patterns: [
        '**/*.tsx',
        '**/*.jsx',
        '**/*.vue',
        '**/*.html',
        '**/tailwind.config.*',
        '**/*.css',
    ],
});

const fwGsap = shipped({
    slug: 'fw.gsap',
    title: 'GSAP Animation Patterns',
    description: 'GSAP-specific: timelines, ScrollTrigger, tweens, performance, accessibility.',
    tags: ['framework', 'gsap', 'animation'],
    task_types: ['generate', 'refactor', 'debug'],
    languages: ['typescript', 'javascript'],
    frameworks: ['gsap'],
    keywords: [
        'gsap',
        'animation',
        'timeline',
        'scrolltrigger',
        'tween',
        'stagger',
        'motion',
        'scroll animation',
    ],
    dependencies: ['lang.javascript'],
    body: `GSAP animation conventions:

1. Register plugins explicitly: gsap.registerPlugin(ScrollTrigger).
2. Use timelines (gsap.timeline()) for sequenced animations.
3. Use ScrollTrigger for scroll-based animations with proper cleanup.
4. Set will-change or translateZ(0) for GPU acceleration on animated elements.
5. Clean up all animations and ScrollTriggers in component unmount/cleanup.
6. Use fromTo() for predictable start/end states, from() for entrance animations.
7. Respect prefers-reduced-motion — disable or simplify animations.
8. Use stagger for animating lists/groups of elements.
9. Keep animation durations under 1s for UI interactions, longer for page transitions.
10. Use gsap.context() for scoped cleanup in React/Vue components.`,
    allowed_file_patterns: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.vue'],
});

const fwElectron = shipped({
    slug: 'fw.electron',
    title: 'Electron Patterns',
    description: 'Electron-specific: main/renderer process, IPC, security, packaging, auto-update.',
    tags: ['framework', 'electron', 'desktop'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'javascript'],
    frameworks: ['electron'],
    keywords: [
        'electron',
        'desktop',
        'main process',
        'renderer',
        'ipc',
        'browserwindow',
        'preload',
    ],
    dependencies: ['lang.typescript'],
    body: `Electron conventions:

1. Enable contextIsolation and disable nodeIntegration in BrowserWindow.
2. Use preload scripts with contextBridge for safe main→renderer communication.
3. Use ipcMain/ipcRenderer for inter-process communication.
4. Validate all IPC inputs in the main process — treat renderer as untrusted.
5. Use electron-builder or electron-forge for packaging.
6. Never load remote URLs without proper CSP and URL validation.
7. Use app.getPath() for platform-specific paths (userData, temp, etc.).
8. Handle app lifecycle events (ready, window-all-closed, activate).
9. Use protocol.registerFileProtocol for custom protocols.
10. Implement auto-update with electron-updater.`,
    allowed_file_patterns: [
        '**/*.ts',
        '**/*.js',
        '**/*.html',
        '**/electron-builder.*',
        '**/forge.config.*',
    ],
});

const fwGatsby = shipped({
    slug: 'fw.gatsby',
    title: 'Gatsby Patterns',
    description:
        'Gatsby-specific: GraphQL data layer, plugins, static generation, image optimization.',
    tags: ['framework', 'gatsby', 'react'],
    task_types: ['generate', 'refactor', 'debug'],
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    frameworks: ['gatsby', 'react'],
    keywords: [
        'gatsby',
        'graphql',
        'static site',
        'gatsby-node',
        'gatsby-config',
        'plugin',
        'createPages',
    ],
    dependencies: ['fw.react'],
    body: `Gatsby conventions:

1. Use GraphQL for all data queries — no direct file system reads in components.
2. Use gatsby-node.js for dynamic page creation with createPages.
3. Use gatsby-image/gatsby-plugin-image for optimized images.
4. Configure plugins in gatsby-config.js with clear comments.
5. Use page queries for page components, static queries (useStaticQuery) for non-page components.
6. Use Gatsby Head API for SEO metadata (not react-helmet in Gatsby 4+).
7. Use gatsby-browser.js and gatsby-ssr.js for client/server customization.
8. Structure source data in content/ or data/ directories.
9. Use TypeScript for type-safe GraphQL queries with codegen.
10. Leverage incremental builds for large sites.`,
    allowed_file_patterns: [
        '**/*.tsx',
        '**/*.jsx',
        '**/*.ts',
        '**/*.js',
        '**/gatsby-*.js',
        '**/gatsby-*.ts',
    ],
});

const fwExpress = shipped({
    slug: 'fw.express',
    title: 'Express.js Patterns',
    description: 'Express-specific: middleware, routing, error handling, security, API design.',
    tags: ['framework', 'express', 'api'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['typescript', 'javascript'],
    frameworks: ['express'],
    keywords: ['express', 'middleware', 'router', 'api', 'rest', 'endpoint', 'server', 'http'],
    dependencies: ['lang.typescript'],
    body: `Express.js conventions:

1. Use Router() for modular route organization.
2. Apply middleware in order: logging → parsing → auth → routes → error handler.
3. Always have a final error-handling middleware (4 parameters: err, req, res, next).
4. Validate request body/params/query with a validation library (joi, zod, express-validator).
5. Use helmet for security headers, cors for CORS configuration.
6. Use async/await with try/catch or express-async-errors.
7. Return proper HTTP status codes (201 for created, 404 for not found, etc.).
8. Rate-limit authentication and sensitive endpoints.
9. Never expose stack traces in production error responses.
10. Use structured JSON responses with consistent shape: { data, error, meta }.`,
    allowed_file_patterns: [
        '**/*.ts',
        '**/*.js',
        '**/routes/**',
        '**/middleware/**',
        '**/controllers/**',
    ],
});

// ============================================================================
// TIER 3: PLATFORM — CMS/Hosting Platform Skills (platform.*)
// ============================================================================

const platformWordpress = shipped({
    slug: 'platform.wordpress',
    title: 'WordPress Development',
    description:
        'WordPress-specific: theme/plugin development, hooks, custom post types, WP-CLI, Gutenberg.',
    tags: ['platform', 'wordpress', 'cms', 'php'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['php', 'javascript', 'css'],
    frameworks: ['wordpress'],
    repo_patterns: ['**/wp-content/**', '**/wp-config.php', '**/.ddev/**'],
    keywords: [
        'wordpress',
        'wp',
        'theme',
        'plugin',
        'hook',
        'action',
        'filter',
        'gutenberg',
        'woocommerce',
        'ddev',
        'wp-cli',
    ],
    dependencies: ['lang.php', 'lang.html', 'lang.css'],
    body: `WordPress conventions:

1. Use actions and filters (hooks) — never modify core files.
2. Prefix all functions, classes, and constants with a unique namespace.
3. Use wp_enqueue_script/wp_enqueue_style for asset loading. Never hardcode URLs.
4. Use WP-CLI (or ddev wp) for database operations, plugin management, and content tasks.
5. Sanitize all input (sanitize_text_field, etc.), escape all output (esc_html, esc_attr, esc_url).
6. Use nonces for form security (wp_nonce_field, wp_verify_nonce).
7. Use register_post_type/register_taxonomy for custom content types.
8. Use the Settings API for admin configuration pages.
9. Use Gutenberg block development with @wordpress/scripts for modern editor blocks.
10. Use transients for cached data, options API for persistent settings.
11. In DDEV environments, use ddev exec, ddev wp, ddev mysql for all commands.`,
    allowed_file_patterns: [
        '**/*.php',
        '**/*.js',
        '**/*.css',
        '**/*.scss',
        '**/functions.php',
        '**/style.css',
    ],
});

const platformDrupal = shipped({
    slug: 'platform.drupal',
    title: 'Drupal Development',
    description:
        'Drupal-specific: module development, hooks, Twig templates, Drush, configuration management.',
    tags: ['platform', 'drupal', 'cms', 'php'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['php', 'twig', 'yaml'],
    frameworks: ['drupal'],
    repo_patterns: ['**/modules/custom/**', '**/themes/custom/**', '**/sites/default/**'],
    keywords: [
        'drupal',
        'drush',
        'module',
        'twig',
        'config sync',
        'entity',
        'field',
        'paragraph',
        'block',
    ],
    dependencies: ['lang.php', 'lang.html'],
    body: `Drupal conventions:

1. Use custom modules in modules/custom/ and themes in themes/custom/.
2. Follow Drupal coding standards and naming conventions (module_name.module).
3. Use dependency injection and services over global functions.
4. Use hook_theme and Twig templates for rendering.
5. Use Configuration Management (config sync) for all configuration changes.
6. Use Drush for database operations, cache clearing, and module management.
7. Use Entity API for custom content types and field definitions.
8. Use Form API for form creation and validation.
9. Use the Plugin API for extensible components (blocks, field formatters, etc.).
10. Sanitize user input and use the database abstraction layer — never raw SQL.`,
    allowed_file_patterns: [
        '**/*.module',
        '**/*.php',
        '**/*.twig',
        '**/*.yml',
        '**/*.info.yml',
        '**/*.routing.yml',
    ],
});

const platformSalesforce = shipped({
    slug: 'platform.salesforce',
    title: 'Salesforce Development',
    description:
        'Salesforce-specific: Apex, Lightning Web Components, SOQL, metadata, deployments.',
    tags: ['platform', 'salesforce', 'crm'],
    task_types: ['generate', 'refactor', 'debug', 'review'],
    languages: ['apex', 'javascript', 'html'],
    frameworks: ['salesforce', 'lwc'],
    keywords: [
        'salesforce',
        'apex',
        'soql',
        'lightning',
        'lwc',
        'trigger',
        'sobject',
        'visualforce',
        'sfdx',
    ],
    body: `Salesforce conventions:

1. Use Lightning Web Components (LWC) for UI. Aura only for legacy.
2. Follow one-trigger-per-object pattern with handler classes.
3. Bulkify all Apex code — never use SOQL/DML inside loops.
4. Use custom metadata types over custom settings for configuration.
5. Use @AuraEnabled(cacheable=true) for read-only wire methods.
6. Write test classes with @isTest annotation, minimum 75% coverage.
7. Use SOQL parameterized queries — never concatenate user input.
8. Handle governor limits explicitly (100 SOQL, 150 DML per transaction).
9. Use SFDX/sf CLI for deployment and metadata management.
10. Separate business logic from trigger/controller logic.`,
    allowed_file_patterns: [
        '**/*.cls',
        '**/*.trigger',
        '**/*.js',
        '**/*.html',
        '**/*.xml',
        '**/force-app/**',
    ],
});

const platformLamp = shipped({
    slug: 'platform.lamp',
    title: 'LAMP Stack Patterns',
    description:
        'LAMP-specific: Apache config, PHP-FPM, MySQL optimization, server administration.',
    tags: ['platform', 'lamp', 'server'],
    task_types: ['generate', 'debug', 'review'],
    languages: ['php', 'sql'],
    repo_patterns: ['**/.htaccess', '**/apache2/**', '**/httpd/**'],
    keywords: [
        'lamp',
        'apache',
        'htaccess',
        'php-fpm',
        'virtual host',
        'mod_rewrite',
        'cpanel',
        'server',
    ],
    dependencies: ['lang.php', 'lang.sql'],
    body: `LAMP stack conventions:

1. Use .htaccess for URL rewriting (mod_rewrite) with proper RewriteBase.
2. Configure PHP-FPM with appropriate pool settings per site.
3. Set proper file permissions: directories 755, files 644, sensitive configs 600.
4. Use prepared statements for all database queries — never interpolate user input.
5. Configure separate virtual hosts per site with DocumentRoot and ServerName.
6. Enable mod_security and mod_headers for security headers.
7. Use SSL certificates (Let's Encrypt) for all production sites.
8. Configure error logging to files, not display_errors in production.
9. Use opcache for PHP bytecode caching.
10. Regularly back up databases with mysqldump before schema changes.`,
    allowed_file_patterns: ['**/.htaccess', '**/*.conf', '**/*.php', '**/*.sql', '**/*.ini'],
});

const platformCpanel = shipped({
    slug: 'platform.cpanel',
    title: 'cPanel & Linux Server Patterns',
    description: 'cPanel-specific: account management, DNS, email, file management, SSH.',
    tags: ['platform', 'cpanel', 'linux', 'hosting'],
    task_types: ['generate', 'debug'],
    keywords: [
        'cpanel',
        'whm',
        'linux',
        'ssh',
        'dns',
        'email',
        'hosting',
        'server admin',
        'ssl',
        'cron',
    ],
    dependencies: ['platform.lamp'],
    body: `cPanel/Linux server conventions:

1. Use cPanel API (UAPI/API2) for scripted account management.
2. Configure DNS records via WHM/cPanel Zone Editor — verify propagation.
3. Use cron jobs for scheduled tasks — log output to files.
4. Set up email accounts and SPF/DKIM/DMARC for deliverability.
5. Use SSH key authentication — disable password auth in production.
6. Monitor disk usage and inode counts in /home accounts.
7. Use AutoSSL or Let's Encrypt for SSL certificate management.
8. Configure backup schedules and test restoration procedures.
9. Use .htaccess for per-directory access control and redirects.
10. Keep all packages updated via yum/apt and monitor security advisories.`,
    allowed_file_patterns: ['**/*.conf', '**/*.sh', '**/.htaccess', '**/crontab'],
});

const platformLightspeed = shipped({
    slug: 'platform.lightspeed',
    title: 'Lightspeed POS/eCommerce Patterns',
    description:
        'Lightspeed-specific: API integration, product syncing, inventory management, webhooks.',
    tags: ['platform', 'lightspeed', 'ecommerce', 'pos'],
    task_types: ['generate', 'debug'],
    languages: ['php', 'javascript', 'python'],
    keywords: [
        'lightspeed',
        'pos',
        'ecommerce',
        'inventory',
        'product sync',
        'webhook',
        'retail',
        'api integration',
    ],
    body: `Lightspeed API conventions:

1. Use OAuth 2.0 authentication with proper token refresh flow.
2. Handle API rate limits with exponential backoff.
3. Use webhooks for real-time event notifications (order created, product updated).
4. Paginate large result sets — never assume all data fits in one response.
5. Validate webhook signatures for security.
6. Map product data carefully between Lightspeed and other systems.
7. Handle inventory adjustments atomically to prevent stock discrepancies.
8. Store API credentials securely (environment variables, not source code).
9. Log all API interactions for debugging and audit purposes.
10. Test integration with sandbox/test accounts before production.`,
    allowed_file_patterns: ['**/*.php', '**/*.ts', '**/*.js', '**/*.py', '**/*.env*'],
});

// ============================================================================
// TIER 4: DATABASE — Database-Specific Skills (db.*)
// ============================================================================

const dbMysql = shipped({
    slug: 'db.mysql',
    title: 'MySQL / MariaDB Patterns',
    description:
        'MySQL/MariaDB-specific: query optimization, indexing, InnoDB, replication, migrations.',
    tags: ['database', 'mysql', 'mariadb'],
    task_types: ['generate', 'debug', 'review', 'refactor'],
    languages: ['sql'],
    keywords: [
        'mysql',
        'mariadb',
        'innodb',
        'index',
        'slow query',
        'replication',
        'migration',
        'trigger',
        'stored procedure',
    ],
    dependencies: ['lang.sql'],
    body: `MySQL/MariaDB conventions:

1. Use InnoDB engine for all transactional tables.
2. Define appropriate indexes for WHERE, JOIN, and ORDER BY columns.
3. Use EXPLAIN to analyze slow queries before optimizing.
4. Use prepared statements — never concatenate user input into queries.
5. Use utf8mb4 character set for full Unicode support.
6. Prefer BIGINT UNSIGNED for auto-increment primary keys.
7. Use foreign keys for referential integrity.
8. Use database migrations (version-controlled DDL changes).
9. Avoid SELECT * — always specify needed columns.
10. Use connection pooling in application code.
11. In DDEV environments, use ddev mysql for database access.`,
    allowed_file_patterns: ['**/*.sql', '**/migrations/**', '**/*.cnf', '**/*.my.cnf'],
});

// ============================================================================
// TIER 5: DEVOPS — Infrastructure & Deployment Skills (ops.*)
// ============================================================================

const opsDocker = shipped({
    slug: 'ops.docker',
    title: 'Docker Patterns',
    description: 'Docker-specific: Dockerfile optimization, multi-stage builds, compose, security.',
    tags: ['devops', 'docker', 'container'],
    task_types: ['generate', 'debug', 'review'],
    repo_patterns: ['**/Dockerfile*', '**/docker-compose*', '**/.dockerignore'],
    keywords: [
        'docker',
        'dockerfile',
        'container',
        'docker-compose',
        'image',
        'volume',
        'network',
        'multi-stage',
    ],
    body: `Docker conventions:

1. Use multi-stage builds to minimize final image size.
2. Use specific base image tags — never use :latest in production.
3. Order Dockerfile instructions from least-changed to most-changed for cache optimization.
4. Use .dockerignore to exclude unnecessary files (node_modules, .git, etc.).
5. Run as non-root user in production containers.
6. Use COPY over ADD unless extracting archives.
7. One process per container — use docker-compose for multi-service setups.
8. Use health checks (HEALTHCHECK instruction) for service readiness.
9. Use named volumes for persistent data, bind mounts for development.
10. Scan images for vulnerabilities (docker scout, trivy).`,
    allowed_file_patterns: [
        '**/Dockerfile*',
        '**/docker-compose*',
        '**/.dockerignore',
        '**/*.yml',
        '**/*.yaml',
    ],
});

const opsDdev = shipped({
    slug: 'ops.ddev',
    title: 'DDEV Local Development',
    description:
        'DDEV-specific: project configuration, services, custom commands, database access.',
    tags: ['devops', 'ddev', 'local-dev'],
    task_types: ['generate', 'debug'],
    repo_patterns: ['**/.ddev/config.yaml', '**/.ddev/**'],
    keywords: ['ddev', 'ddev start', 'ddev exec', 'ddev wp', 'ddev mysql', 'local development'],
    dependencies: ['ops.docker'],
    body: `DDEV conventions:

1. Use ddev config to initialize projects — configure PHP version, docroot, project type.
2. Use ddev exec <command> to run commands inside the web container.
3. Use ddev wp for WP-CLI commands in WordPress projects.
4. Use ddev mysql for database access (no separate MySQL client needed).
5. Use ddev describe to check project status and URLs.
6. Add custom DDEV commands in .ddev/commands/web/ or .ddev/commands/host/.
7. Use .ddev/docker-compose.*.yaml for additional services.
8. Use ddev export-db/import-db for database snapshots.
9. Configure .ddev/config.yaml for per-project settings.
10. Run npm/composer commands via ddev exec (ddev exec npm install).`,
    allowed_file_patterns: ['**/.ddev/**', '**/*.yaml', '**/*.yml'],
});

const opsGit = shipped({
    slug: 'ops.git',
    title: 'Git Workflow Patterns',
    description:
        'Git-specific: branching strategies, commit conventions, merge/rebase, conflict resolution.',
    tags: ['devops', 'git', 'version-control'],
    task_types: ['spec', 'debug'],
    keywords: [
        'git',
        'branch',
        'commit',
        'merge',
        'rebase',
        'conflict',
        'pull request',
        'cherry-pick',
        'stash',
    ],
    body: `Git conventions:

1. Write conventional commits: type(scope): description (fix, feat, chore, docs, refactor, test).
2. Keep commits atomic — each commit should be a single logical change.
3. Use feature branches: feature/, fix/, chore/ prefixes.
4. Rebase feature branches onto main for clean history.
5. Use interactive rebase (git rebase -i) to clean up commits before merging.
6. Never force-push to shared branches (main, develop).
7. Use .gitignore to exclude build artifacts, environment files, IDE folders.
8. Tag releases with semantic versioning: git tag v1.2.3.
9. Resolve merge conflicts by understanding both sides — never blindly accept one.
10. Use git stash for temporary work-in-progress saves.`,
    allowed_file_patterns: ['**/.gitignore', '**/.gitattributes', '**/.github/**'],
});

const opsCicd = shipped({
    slug: 'ops.cicd',
    title: 'CI/CD Pipeline Patterns',
    description:
        'CI/CD-specific: GitHub Actions, automated testing, deployment, secrets management.',
    tags: ['devops', 'cicd', 'automation'],
    task_types: ['generate', 'debug', 'review'],
    repo_patterns: ['**/.github/workflows/**', '**/.gitlab-ci.yml', '**/Jenkinsfile'],
    keywords: [
        'ci',
        'cd',
        'github actions',
        'workflow',
        'pipeline',
        'deploy',
        'automation',
        'jenkins',
    ],
    body: `CI/CD conventions:

1. Run tests, lint, and type-check on every PR.
2. Use matrix builds for multiple OS/Node/Python versions.
3. Cache dependencies (node_modules, pip cache) for faster builds.
4. Use secrets for API keys, tokens, and credentials — never hardcode.
5. Separate build, test, and deploy stages.
6. Use environment protection rules for production deployments.
7. Pin action versions to SHA hashes (not tags) for supply-chain security.
8. Fail fast — run cheapest checks (lint, types) before expensive ones (tests).
9. Use artifacts to pass build outputs between stages.
10. Implement rollback mechanisms for failed deployments.`,
    allowed_file_patterns: [
        '**/.github/workflows/**',
        '**/.gitlab-ci.yml',
        '**/Jenkinsfile',
        '**/*.yml',
        '**/*.yaml',
    ],
});

const opsLinux = shipped({
    slug: 'ops.linux',
    title: 'Linux System Administration',
    description:
        'Linux-specific: shell scripting, service management, permissions, networking, monitoring.',
    tags: ['devops', 'linux', 'sysadmin'],
    task_types: ['generate', 'debug'],
    keywords: [
        'linux',
        'bash',
        'shell',
        'systemd',
        'cron',
        'ssh',
        'firewall',
        'permissions',
        'nginx',
        'systemctl',
    ],
    body: `Linux administration conventions:

1. Use systemd for service management (systemctl start/stop/enable/status).
2. Use proper file permissions: never chmod 777.
3. Use SSH keys over password authentication.
4. Configure firewall rules (ufw/iptables) — deny by default, allow specific ports.
5. Use cron for scheduled tasks with proper logging (>> /var/log/cron.log 2>&1).
6. Monitor logs with journalctl and /var/log/.
7. Use environment variables in /etc/environment or systemd unit files.
8. Keep packages updated: apt update && apt upgrade (Debian/Ubuntu).
9. Use logrotate for log file management.
10. Create non-root service accounts with minimal privileges.`,
    allowed_file_patterns: ['**/*.sh', '**/*.conf', '**/*.service', '**/*.timer', '**/crontab'],
});

// ============================================================================
// TIER 6: CROSS-CUTTING — Multi-Concern Skills (xcut.*)
// ============================================================================

const xcutSecurity = shipped({
    slug: 'xcut.security',
    title: 'Application Security Patterns',
    description:
        'Security-specific: OWASP Top 10, input validation, authentication, secrets management.',
    tags: ['security', 'owasp', 'cross-cutting'],
    task_types: ['review', 'debug', 'generate'],
    keywords: [
        'security',
        'owasp',
        'xss',
        'csrf',
        'injection',
        'authentication',
        'authorization',
        'secrets',
        'vulnerability',
    ],
    body: `Application security conventions (OWASP Top 10):

1. INJECTION: Always use parameterized queries. Never concatenate user input into SQL, commands, or templates.
2. BROKEN AUTH: Use industry-standard auth libraries. Implement rate limiting on login. Use MFA.
3. XSS: Escape all user-generated content on output. Use Content-Security-Policy headers.
4. IDOR: Validate resource ownership on every request — never trust client-provided IDs alone.
5. MISCONFIGURATION: Disable debug mode in production. Remove default credentials. Set security headers.
6. COMPONENTS: Keep dependencies updated. Audit with npm audit/pip-audit/cargo audit.
7. CSRF: Use anti-CSRF tokens for state-changing requests. SameSite cookies.
8. SECRETS: Never commit secrets. Use environment variables or secret managers.
9. LOGGING: Log security events (failed logins, permission denials). Never log passwords or tokens.
10. SSRF: Validate and whitelist URLs for server-side requests. Block internal network access.`,
    allowed_file_patterns: ['**/*'],
});

const xcutAccessibility = shipped({
    slug: 'xcut.accessibility',
    title: 'Web Accessibility (a11y)',
    description:
        'Accessibility-specific: WCAG 2.1 compliance, ARIA, keyboard navigation, screen readers.',
    tags: ['accessibility', 'a11y', 'cross-cutting'],
    task_types: ['review', 'generate', 'refactor'],
    languages: ['html', 'tsx', 'jsx', 'vue'],
    keywords: [
        'accessibility',
        'a11y',
        'wcag',
        'aria',
        'screen reader',
        'keyboard',
        'focus',
        'contrast',
    ],
    dependencies: ['lang.html'],
    body: `Web accessibility conventions (WCAG 2.1 AA):

1. All interactive elements must be keyboard accessible (Tab, Enter, Escape, Arrow keys).
2. Maintain visible focus indicators — never outline: none without replacement.
3. Color contrast minimum: 4.5:1 for normal text, 3:1 for large text.
4. All images have descriptive alt text (empty alt="" for decorative images).
5. Form inputs have associated labels. Error messages are programmatically linked.
6. Use semantic HTML elements before ARIA roles.
7. Announce dynamic content changes with aria-live regions.
8. Support reduced motion (prefers-reduced-motion media query).
9. Pages have proper heading hierarchy and landmark regions.
10. Test with screen readers (VoiceOver, NVDA) and automated tools (axe, Lighthouse).`,
    allowed_file_patterns: [
        '**/*.html',
        '**/*.tsx',
        '**/*.jsx',
        '**/*.vue',
        '**/*.css',
        '**/*.scss',
    ],
});

const xcutApi = shipped({
    slug: 'xcut.api',
    title: 'REST API Design Patterns',
    description:
        'API-specific: RESTful design, versioning, error responses, pagination, rate limiting.',
    tags: ['api', 'rest', 'cross-cutting'],
    task_types: ['generate', 'review', 'design'],
    keywords: [
        'api',
        'rest',
        'restful',
        'endpoint',
        'versioning',
        'pagination',
        'webhook',
        'openapi',
        'swagger',
    ],
    body: `REST API design conventions:

1. Use nouns for resources (/users, /orders), HTTP verbs for actions (GET, POST, PUT, DELETE).
2. Return appropriate HTTP status codes (200, 201, 204, 400, 401, 403, 404, 409, 500).
3. Use consistent response shape: { data, meta, errors }.
4. Version APIs in the URL (/v1/users) or Accept header.
5. Implement cursor-based or offset pagination for collections.
6. Use HATEOAS links for discoverability when appropriate.
7. Validate all inputs early and return descriptive error messages.
8. Rate-limit endpoints and return 429 with Retry-After header.
9. Use OpenAPI/Swagger for API documentation.
10. Handle CORS with specific origins — never Access-Control-Allow-Origin: * in production.`,
    allowed_file_patterns: ['**/*.ts', '**/*.js', '**/*.py', '**/*.go', '**/*.yaml', '**/*.json'],
});

const xcutTesting = shipped({
    slug: 'xcut.testing',
    title: 'Testing Strategy Patterns',
    description:
        'Testing-specific: test pyramid, integration tests, E2E, mocking strategies, CI testing.',
    tags: ['testing', 'cross-cutting'],
    task_types: ['test', 'generate', 'review'],
    keywords: [
        'test',
        'e2e',
        'integration',
        'mock',
        'stub',
        'fixture',
        'coverage',
        'playwright',
        'cypress',
    ],
    body: `Testing strategy conventions:

1. Follow the test pyramid: many unit tests, fewer integration tests, minimal E2E tests.
2. Unit tests should be fast, isolated, and deterministic.
3. Integration tests verify modules work together (API routes, database queries).
4. E2E tests cover critical user flows only (login, checkout, core workflows).
5. Use fixtures for test data setup — avoid relying on production data.
6. Mock external services (APIs, email, payment) — never call real services in tests.
7. Test behavior, not implementation — focus on inputs/outputs, not internal state.
8. Use snapshot testing sparingly — only for stable output (generated types, configs).
9. Run tests in CI on every PR — block merge on failure.
10. Aim for meaningful coverage, not 100% — cover edge cases and error paths.`,
    allowed_file_patterns: [
        '**/*.test.*',
        '**/*.spec.*',
        '**/*_test.*',
        '**/test/**',
        '**/tests/**',
        '**/__tests__/**',
    ],
});

const xcutPerformance = shipped({
    slug: 'xcut.performance',
    title: 'Web Performance Patterns',
    description:
        'Performance-specific: Core Web Vitals, bundle optimization, caching, lazy loading.',
    tags: ['performance', 'cross-cutting'],
    task_types: ['refactor', 'review', 'debug'],
    keywords: [
        'performance',
        'core web vitals',
        'lighthouse',
        'bundle',
        'lazy load',
        'cache',
        'cdn',
        'ttfb',
        'cls',
        'fcp',
    ],
    body: `Web performance conventions:

1. Measure before optimizing — use Lighthouse, WebPageTest, Chrome DevTools.
2. Code-split by route — lazy-load non-critical JavaScript.
3. Optimize images: use modern formats (WebP/AVIF), responsive srcset, lazy loading.
4. Minimize Largest Contentful Paint (LCP): preload hero images, inline critical CSS.
5. Minimize Cumulative Layout Shift (CLS): set explicit dimensions on images/videos/ads.
6. Minimize Interaction to Next Paint (INP): avoid long tasks, use requestIdleCallback.
7. Use HTTP caching: Cache-Control headers, versioned assets with content hashes.
8. Serve assets from a CDN.
9. Minimize third-party script impact — defer non-critical scripts.
10. Tree-shake unused code — monitor bundle size in CI.`,
    allowed_file_patterns: ['**/*'],
});

// ============================================================================
// Public API
// ============================================================================

/**
 * All shipped skill definitions.
 * These are loaded once at startup and never modified.
 */
export const SHIPPED_SKILLS: readonly SkillDoc[] = Object.freeze([
    // Process skills (original 10)
    scaffoldComponent,
    scaffoldCliCommand,
    refactorExtractModule,
    testGenerateUnit,
    debugRootCauseAnalysis,
    reviewCodeRubric,
    migrateApiVersion,
    optimizePerformanceHotspot,
    docsGenerateReadme,
    releasePrepareVersionBump,
    // Tier 1: Foundation — Language skills
    langTypescript,
    langJavascript,
    langPython,
    langPhp,
    langHtml,
    langCss,
    langJava,
    langRust,
    langGo,
    langSql,
    // Tier 2: Framework skills
    fwReact,
    fwVue,
    fwNextjs,
    fwNuxtjs,
    fwTailwind,
    fwGsap,
    fwElectron,
    fwGatsby,
    fwExpress,
    // Tier 3: Platform skills
    platformWordpress,
    platformDrupal,
    platformSalesforce,
    platformLamp,
    platformCpanel,
    platformLightspeed,
    // Tier 4: Database skills
    dbMysql,
    // Tier 5: DevOps skills
    opsDocker,
    opsDdev,
    opsGit,
    opsCicd,
    opsLinux,
    // Tier 6: Cross-cutting skills
    xcutSecurity,
    xcutAccessibility,
    xcutApi,
    xcutTesting,
    xcutPerformance,
]);

/**
 * Look up a shipped skill by slug.
 */
export function getShippedSkill(slug: string): SkillDoc | undefined {
    return SHIPPED_SKILLS.find((s) => s.metadata.slug === slug);
}

/**
 * Get all shipped skill slugs.
 */
export function getShippedSlugs(): string[] {
    return SHIPPED_SKILLS.map((s) => s.metadata.slug);
}
