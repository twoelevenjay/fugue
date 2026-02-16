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
 */

import { SkillDoc } from './skillTypes';

// ============================================================================
// Shipped Skill Definitions
// ============================================================================

const scaffoldComponent: SkillDoc = {
    schema_version: 'johann.skill.v1',
    metadata: {
        slug: 'scaffold.component',
        version: '1.0.0',
        title: 'Scaffold a UI Component',
        description: 'Generate a new UI component with proper structure, types, styles, and test file following project conventions.',
        tags: ['scaffold', 'component', 'ui', 'generate'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate'],
        languages: ['typescript', 'javascript', 'tsx', 'jsx'],
        frameworks: ['react', 'vue', 'svelte', 'angular', 'solid'],
        keywords: ['component', 'scaffold', 'create component', 'new component', 'ui component', 'widget'],
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
        allowed_file_patterns: ['**/*.tsx', '**/*.jsx', '**/*.ts', '**/*.js', '**/*.css', '**/*.scss', '**/*.module.*', '**/*.test.*', '**/*.spec.*', '**/index.ts', '**/index.js'],
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
        description: 'Generate a new CLI command with argument parsing, help text, and test file following the project CLI structure.',
        tags: ['scaffold', 'cli', 'command', 'generate'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate'],
        languages: ['typescript', 'javascript', 'python', 'go'],
        keywords: ['cli', 'command', 'subcommand', 'scaffold command', 'new command', 'create command'],
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
        allowed_file_patterns: ['**/cmd/**', '**/commands/**', '**/cli/**', '**/*.ts', '**/*.js', '**/*.py', '**/*.go', '**/*.test.*', '**/*.spec.*'],
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
        description: 'Refactor by extracting related code from a large file into a dedicated module while preserving all existing behavior.',
        tags: ['refactor', 'extract', 'module', 'separation'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['refactor', 'complex-refactor'],
        keywords: ['extract', 'module', 'split file', 'separate', 'decompose', 'break apart', 'too large', 'too long'],
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
        allowed_file_patterns: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.go', '**/index.*'],
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
        description: 'Generate comprehensive unit tests with edge cases, mocks, and assertions following the project test conventions.',
        tags: ['test', 'unit', 'generate', 'testing'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['test', 'generate'],
        keywords: ['test', 'unit test', 'tests', 'testing', 'coverage', 'spec', 'write tests', 'add tests'],
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
        allowed_file_patterns: ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.*', '**/test/**', '**/tests/**', '**/__tests__/**'],
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
        keywords: ['bug', 'fix', 'broken', 'not working', 'error', 'crash', 'root cause', 'diagnose', 'debug', 'failing'],
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
        description: 'Perform a structured code review against a quality rubric covering correctness, readability, security, and performance.',
        tags: ['review', 'code-review', 'quality', 'rubric'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['review'],
        keywords: ['review', 'code review', 'quality', 'feedback', 'critique', 'audit', 'check', 'inspect'],
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
        description: 'Systematically migrate code from one API version to another, updating all call sites and handling breaking changes.',
        tags: ['migrate', 'api', 'upgrade', 'version', 'breaking-change'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['refactor', 'complex-refactor'],
        keywords: ['migrate', 'upgrade', 'api version', 'breaking change', 'deprecation', 'update dependency', 'version bump'],
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
        allowed_file_patterns: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py', '**/*.go', '**/package.json', '**/go.mod', '**/requirements.txt', '**/pyproject.toml'],
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
        description: 'Analyze and optimize a performance-critical section of code, focusing on algorithmic improvements and resource efficiency.',
        tags: ['optimize', 'performance', 'hotspot', 'speed', 'memory'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['refactor'],
        keywords: ['optimize', 'performance', 'slow', 'speed', 'fast', 'hotspot', 'bottleneck', 'memory', 'efficient'],
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
        description: 'Generate or update a comprehensive README.md with installation, usage, API reference, and contribution guidelines.',
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
        allowed_file_patterns: ['**/README.md', '**/README.*', '**/package.json', '**/go.mod', '**/pyproject.toml', '**/Makefile', '**/Dockerfile', '**/.env.example'],
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
        description: 'Prepare a release by bumping version numbers, updating changelogs, and verifying release readiness.',
        tags: ['release', 'version', 'bump', 'changelog', 'prepare'],
        scope: 'shipped',
        origin: 'shipped',
        created_at: '2025-01-01T00:00:00.000Z',
    },
    applies_to: {
        task_types: ['generate', 'refactor'],
        keywords: ['release', 'version', 'bump', 'changelog', 'prepare release', 'ship', 'tag', 'publish'],
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
        allowed_file_patterns: ['**/package.json', '**/package-lock.json', '**/CHANGELOG.md', '**/CHANGES.md', '**/HISTORY.md', '**/version.ts', '**/version.py', '**/version.go', '**/Cargo.toml', '**/pyproject.toml'],
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
// Public API
// ============================================================================

/**
 * All shipped skill definitions.
 * These are loaded once at startup and never modified.
 */
export const SHIPPED_SKILLS: readonly SkillDoc[] = Object.freeze([
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
]);

/**
 * Look up a shipped skill by slug.
 */
export function getShippedSkill(slug: string): SkillDoc | undefined {
    return SHIPPED_SKILLS.find(s => s.metadata.slug === slug);
}

/**
 * Get all shipped skill slugs.
 */
export function getShippedSlugs(): string[] {
    return SHIPPED_SKILLS.map(s => s.metadata.slug);
}
