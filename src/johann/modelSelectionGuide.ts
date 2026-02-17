// ============================================================================
// MODEL SELECTION GUIDE — Pretraining for intelligent model routing
//
// This guide encodes expert knowledge about which models should be used
// for which tasks, prioritizing free (0×) models whenever appropriate
// and reserving premium models for tasks that truly need them.
//
// Source: Feb 2026 GitHub Copilot model roster and cost analysis
// ============================================================================

/**
 * Comprehensive guidance for model selection based on task type.
 * This serves as "pretraining" for the model picker - deterministic
 * rules that prevent expensive model usage when cheaper alternatives suffice.
 */
export const MODEL_SELECTION_GUIDE = `
=== FREE (0×) MODELS — USE THESE BY DEFAULT ===

GPT-5 mini (0×) — Primary workhorse for most coding tasks
Use for:
• Boilerplate and scaffolding (controllers, routes, DTOs, migrations, CLI)
• Mechanical refactors (rename, move files, pattern conversion, extract helpers)
• Test generation when provided examples/expected behavior
• Script writing (one-off scripts, data cleanup, build tooling)
• Documentation generation (READMEs, usage docs, inline comments, changelogs)
• Large diff summarization and "what changed" analysis
Rule: If you can describe the task as "do X in these files following these patterns with these examples," use GPT-5 mini.

GPT-4.1 (0×) — Debugging and correctness
Use for:
• Debugging from stack traces, logs, or failing tests
• Code review for correctness, edge cases, security issues, concurrency
• Small-to-mid design decisions within existing architecture
• Writing tests with tricky edge cases
• Security audits and vulnerability analysis
Rule: Use for analysis and review, then delegate implementation back to GPT-5 mini.

GPT-4o (0×) — Communication and specification
Use for:
• Converting rough requests into tickets, acceptance criteria, checklists
• Writing PR descriptions and review comments
• User-facing documentation and "explain to teammate" writeups
• Translating between product language and engineering requirements
• Planning and coordination documents
Rule: Use for anything where the output is prose, not code.

Raptor mini (0×) — Micro-iterations
Use for:
• Small "finish this function" tasks
• Repetitive edits across a few files
• Quick suggestions while user is actively coding
Rule: Ultra low-latency tasks only.

=== WHEN FREE MODELS ARE SUFFICIENT ===

If the task matches these patterns, stay on 0× models:
✓ Well-defined structure (clear input → clear output transformation)
✓ Repository context provides all needed information
✓ Task follows established patterns in the codebase
✓ Examples or tests demonstrate expected behavior
✓ Mechanical/procedural work without novel reasoning

=== PREMIUM MODELS (0.25× - 1×) — ESCALATE WHEN NEEDED ===

Tier 1 "Cheap Premium" (0.25× - 0.33×)
Use when 0× models fail on:
• Larger refactors requiring cross-file reasoning
• Tricky code generation where patterns aren't obvious
• Tasks needing lightweight but accurate reasoning

Models:
- Claude Haiku 4.5 (0.33×) → Quick edits, lightweight reasoning
- Gemini 3 Flash (0.33×) → Fast summaries, small transformations
- GPT-5.1-Codex-Mini (0.33×) → Coding-first mid-tier for bigger refactors

Tier 2 "Standard Premium" (1×)
Use when task requires:
• Multi-file changes with complex interdependencies
• Hard bugs requiring deep reasoning
• Agentic coding (multi-step implementation, test+fix loops)
• Architecture within bounded scope

Models:
- GPT-5.3-Codex (1×) → Best for agentic coding reliability
- Claude Sonnet 4/4.5 (1×) → Strong all-around coding + reasoning
- Gemini 2.5 Pro (1×) → Tough reasoning + cross-file understanding
- GPT-5.1/5.2 (1×) → Deeper reasoning for hard bugs/design

=== OPUS (3× - 10×) — EMERGENCY ONLY ===

Only use when:
• User explicitly enables Opus escalation
• Multiple 1× models have failed
• Task is genuinely novel/frontier-level difficulty
• Cost is understood and accepted

Models:
- Claude Opus 4.5/4.6 (3×) → Frontier reasoning when all else fails

NEVER use Opus for:
× Routine code generation
× Simple refactors
× Test writing
× Documentation
× Any task a 0× or 1× model can handle

=== ROUTING DECISION TREE ===

1. Classify task type:
   - Generate/Refactor/Test → Try GPT-5 mini first
   - Debug/Review → Try GPT-4.1 first
   - Spec/Plan/Doc → Try GPT-4o first
   - Tiny edit → Try Raptor mini first

2. If 0× model fails:
   - Analyze failure reason
   - If "needs more context" → provide better context, retry
   - If "task too complex" → escalate to 0.33× tier
   - If still failing → escalate to 1× tier

3. Track failures:
   - After 2 failures at same tier → escalate
   - After 3 models tried → consider task decomposition
   - Never auto-escalate to Opus (manual only)

=== COST-AWARE PRINCIPLES ===

• Default to 0× (free) for >80% of tasks
• Use 0.33× sparingly (only when 0× demonstrably fails)
• Use 1× for <10% of tasks (legitimate complexity)
• Use 3×+ for <1% of tasks (emergency/manual)
• Always prefer the cheapest model that can succeed
• Track cost per session and warn at thresholds
`;

/**
 * Task-to-model routing rules for deterministic selection.
 * Maps task types to preferred model families and cost tiers.
 */
export const TASK_TO_MODEL_ROUTING = {
    generate: {
        primary: 'gpt-5-mini',
        preferredCost: 0,
        escalateTo: ['gpt-5.1-codex-mini', 'gpt-5.3-codex'],
        description: 'Code generation, boilerplate, scaffolding',
    },
    refactor: {
        primary: 'gpt-5-mini',
        preferredCost: 0,
        escalateTo: ['gpt-5.1-codex-mini', 'gpt-5.3-codex'],
        description: 'Mechanical refactors, renames, pattern changes',
    },
    test: {
        primary: 'gpt-5-mini',
        preferredCost: 0,
        escalateTo: ['gpt-4.1', 'gpt-5.3-codex'],
        description: 'Test generation and test writing',
    },
    debug: {
        primary: 'gpt-4.1',
        preferredCost: 0,
        escalateTo: ['gpt-5.1', 'claude-sonnet'],
        description: 'Debugging, error analysis, fixing failures',
    },
    review: {
        primary: 'gpt-4.1',
        preferredCost: 0,
        escalateTo: ['claude-sonnet', 'gpt-5.1'],
        description: 'Code review, security, edge case analysis',
    },
    spec: {
        primary: 'gpt-4o',
        preferredCost: 0,
        escalateTo: ['claude-sonnet'],
        description: 'Planning, specs, documentation, communication',
    },
    edit: {
        primary: 'raptor-mini',
        preferredCost: 0,
        escalateTo: ['gpt-5-mini'],
        description: 'Small edits, formatting, single functions',
    },
    design: {
        primary: 'gpt-4.1',
        preferredCost: 0,
        escalateTo: ['claude-sonnet', 'gpt-5.1', 'gemini-2.5-pro'],
        description: 'Architecture decisions, system design',
    },
    'complex-refactor': {
        primary: 'gpt-5.1-codex-mini',
        preferredCost: 0.33,
        escalateTo: ['gpt-5.3-codex', 'claude-sonnet'],
        description: 'Large-scale refactors with deep reasoning',
    },
} as const;

/**
 * Patterns for detecting task type from subtask description.
 * Used for automatic task classification.
 */
export const TASK_TYPE_PATTERNS = {
    generate: [
        /generat/i,
        /creat.*file/i,
        /scaffold/i,
        /boilerplate/i,
        /implement.*function/i,
        /write.*class/i,
        /add.*route/i,
        /build.*component/i,
        /migration/i,
        /dto/i,
        /controller/i,
    ],
    refactor: [
        /refactor/i,
        /rename/i,
        /move.*file/i,
        /extract/i,
        /reorganiz/i,
        /convert.*to/i,
        /change.*pattern/i,
        /split/i,
        /merge/i,
        /consolidat/i,
    ],
    test: [
        /test/i,
        /spec/i,
        /assertion/i,
        /expect/i,
        /mock/i,
        /fixture/i,
        /coverage/i,
        /unit.*test/i,
        /integration.*test/i,
    ],
    debug: [
        /debug/i,
        /fix.*bug/i,
        /error/i,
        /fail/i,
        /crash/i,
        /stack.*trace/i,
        /exception/i,
        /broken/i,
        /issue/i,
    ],
    review: [
        /review/i,
        /audit/i,
        /security/i,
        /vulnerability/i,
        /edge.*case/i,
        /correctness/i,
        /validate/i,
        /check.*for/i,
    ],
    spec: [
        /document/i,
        /doc/i,
        /readme/i,
        /explain/i,
        /describe/i,
        /spec/i,
        /plan/i,
        /design.*doc/i,
        /pr.*desc/i,
        /comment/i,
    ],
    edit: [
        /small.*edit/i,
        /quick.*fix/i,
        /format/i,
        /finish.*function/i,
        /complete.*line/i,
        /add.*import/i,
        /tweak/i,
    ],
    design: [
        /design/i,
        /architect/i,
        /structure/i,
        /organize/i,
        /approach/i,
        /strategy/i,
        /pattern.*for/i,
    ],
    'complex-refactor': [
        /large.*refactor/i,
        /major.*rewrite/i,
        /restructure/i,
        /multi.?file.*chang/i,
        /cross.?file/i,
        /major.*chang/i,
    ],
} as const;
