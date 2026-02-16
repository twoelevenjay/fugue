# Johann Enhancement Game Plan

**Date:** 2026-02-16  
**Goal:** Transform Johann from a basic multi-agent orchestrator into a production-grade hive-mind system capable of deploying swarms of agentic workflows—matching or exceeding the architectural capabilities of Gas Town, OpenClaw, and the CLI System.

---

## Executive Summary

Johann already has strong foundations: task decomposition, parallel execution with git worktree isolation, 5-tier model selection, session persistence, and a file-based execution ledger (hive mind). But three reference systems reveal critical gaps:

1. **CLI System** — DAG-based wave execution with proper topological sort, structured summary extraction for context propagation between tasks, and skill-aware worker specialization
2. **Gas Town** — GUPP (never idle) discipline, mail-based messaging, formula-driven workflow templates, checkpoint recovery, stateless coordination, and the Discover-Don't-Track principle
3. **OpenClaw** — Lazy skill loading, pre-compaction memory flush, hook-based lifecycle, and the insight that **context assembly quality matters more than agent loop complexity**

The plan is structured as **6 phases**, ordered by foundation-first dependency. Each phase builds on the previous and can be tested independently.

---

## Current State Assessment

### What Works Well ✅
- 4-phase pipeline (Plan → Execute → Merge → Memory)
- Parallel execution via `Promise.all` with dependency graph
- Git worktree isolation for parallel subtasks
- 5-tier model selection with cost-aware escalation
- Execution ledger with mid-round hive mind refresh
- Session persistence with resume capability
- Safe IO (atomic writes + per-file mutex)
- Output corruption detection
- Identity isolation (subagents don't know they're Johann)

### What's Broken/Stale 🔧
- `extension.ts` lost detailed Ramble prompt content (preserved in `.bak`)  
- `extension.ts.bak` is stale — should be restored then removed
- Multi-pass executor is complete code but NOT wired into orchestrator
- `sessionTranscript.ts` has a data race (no safeIO)
- `subagentRegistry.ts` uses fire-and-forget saves (out-of-order writes)
- `backgroundTaskManager.ts` uses raw writes without mutex
- Zero test coverage
- `OPENCLAW-FEATURES.md` has stale status indicators

### Critical Gaps vs Reference Systems ❌
1. **No DAG wave execution** — Tasks run with dependency respect but don't group into parallel waves
2. **No structured output extraction** — Subagent outputs are free-form text, not parseable summaries
3. **No context distillation** — Downstream tasks get raw text instead of compact dependency context
4. **No skill inference** — Tasks don't auto-match to skill specializations
5. **No mail/messaging** — Subagents can't communicate with each other mid-execution
6. **No GUPP discipline** — No enforcement that agents always have work or die
7. **No lifecycle hooks** — No extensibility points for intercepting agent behavior
8. **No pre-compaction memory flush** — Context resets lose accumulated knowledge
9. **No lazy skill loading** — Skills are either pre-loaded or not used
10. **Multi-pass is dead code** — 750 lines of strategies sitting unused

---

## Phase 0: Cleanup & Stabilization (30 min)

**Rationale:** Fix known bugs before adding new features. A broken foundation makes every subsequent phase harder.

### Tasks

#### 0.1 Restore Ramble prompt from `.bak`
The detailed STT-aware Ramble prompt was stripped during the overnight hallucination run. Restore it from `extension.ts.bak` and delete the `.bak` file.

#### 0.2 Fix `sessionTranscript.ts` data race
Replace raw `readFile → push → writeFile` with `safeAppend()` from `safeIO.ts`. One-line fix.

#### 0.3 Fix `subagentRegistry.ts` write ordering
Replace fire-and-forget `save().catch(() => {})` with a debounced/queued save to prevent out-of-order disk writes.

#### 0.4 Fix `backgroundTaskManager.ts` mutex
Add `safeWrite()` wrapper around `vscode.workspace.fs.writeFile` calls.

#### 0.5 Wire multi-pass executor
In `orchestrator.ts`, find the `// TODO: Multi-pass integration point` and wire it up:
- Check `subtask.useMultiPass` flag
- Route to `MultiPassExecutor.execute()` when enabled
- Fall through to standard single-pass when not
- Teach `taskDecomposer.ts` to set `useMultiPass=true` for appropriate task types (code review, documentation, debugging)

#### 0.6 Verify compilation
`npm run compile` must pass with zero errors.

### Exit Criteria
- All bugs fixed, extension compiles, `.bak` removed
- Multi-pass system is callable (even if no tasks auto-trigger it yet)

---

## Phase 1: DAG Wave Execution Engine (1-2 hours)

**Rationale:** The CLI System's biggest contribution is proper wave-based DAG execution. This is foundational — every subsequent phase benefits from tasks running in optimally parallel waves.

### What We're Building
A `GraphManager` that converts the flat `dependsOn` arrays into topologically sorted waves, enabling maximum concurrency.

### Architecture

```
TaskDecomposer produces:
  tasks: [{id: "1", dependsOn: []}, {id: "2", dependsOn: ["1"]}, {id: "3", dependsOn: ["1"]}, {id: "4", dependsOn: ["2","3"]}]

GraphManager.getExecutionWaves() produces:
  Wave 0: [task-1]           ← no dependencies
  Wave 1: [task-2, task-3]   ← both depend only on wave-0 tasks
  Wave 2: [task-4]           ← depends on wave-1 tasks
```

### Implementation

#### 1.1 Create `src/johann/graphManager.ts`

```typescript
// Key functions:
getExecutionWaves(plan: OrchestrationPlan): Wave[]
getDownstreamTasks(taskId: string): string[]  // BFS for cascading failure
validateGraph(plan: OrchestrationPlan): ValidationResult  // cycle detection, orphan detection
```

- **Topological sort** using Kahn's algorithm (proven in both Gas Town and CLI System)
- **Cycle detection** via DFS with stack tracking
- **Orphan detection** via BFS from root tasks
- **`Wave`** type: `{ level: number; taskIds: string[] }`

#### 1.2 Refactor `executePlan()` in `orchestrator.ts`

Replace the current `while (completed.size < plan.subtasks.length)` loop with wave-based execution:

```typescript
const waves = graphManager.getExecutionWaves(plan);
for (const wave of waves) {
    // All tasks in a wave are independent — run them in parallel
    const promises = wave.taskIds.map(id => executeSubtask(id, ...));
    await Promise.all(promises);
    // Wave complete — downstream tasks are now unblocked
}
```

#### 1.3 Add error propagation

When a task fails, use `getDownstreamTasks()` to cancel all transitively dependent tasks immediately. Don't waste compute on tasks that can't succeed.

### Exit Criteria
- Tasks execute in proper wave order with maximum parallelism
- Failed tasks cancel their downstream dependents
- Cycle detection prevents infinite loops

---

## Phase 2: Structured Output & Context Distillation (1-2 hours)

**Rationale:** The CLI System's second key insight: force every subagent to produce structured summaries, then distill them for downstream injection. This prevents the exponential token growth problem and gives downstream agents precise context about what upstream agents did.

### What We're Building
A structured output format that every subagent must produce, plus a distillation pipeline that compresses completed task outputs for downstream injection.

### Architecture

```
SubagentManager.executeSubtask() → raw output
     ↓
extractSummary(output) → StructuredSummary
     ↓
distillContext(summary, maxTokens=500) → compact context string
     ↓
Injected into downstream tasks' pre-prompts
```

### Implementation

#### 2.1 Define structured summary format

Add to the subagent's system prompt instructions requiring this output block:

````
```summary
COMPLETED: <what was done, 1-2 sentences>
FILES_MODIFIED: <comma-separated relative paths>
KEY_EXPORTS: <exported identifiers created/modified>
DEPENDENCIES_INSTALLED: <any packages added>
COMMANDS_RUN: <key terminal commands>
NOTES: <anything downstream tasks need to know>
```
````

#### 2.2 Create `src/johann/contextDistiller.ts`

```typescript
interface StructuredSummary {
    completed: string;
    filesModified: string[];
    keyExports: string[];
    dependenciesInstalled: string[];
    commandsRun: string[];
    notes: string;
    raw: string;  // full output as fallback
}

extractSummary(rawOutput: string): StructuredSummary
distillContext(summary: StructuredSummary, maxTokens?: number): string
gatherDependencyContext(taskId: string, plan: OrchestrationPlan, results: Map<string, SubtaskResult>): string
```

#### 2.3 Integrate into execution pipeline

- After each subtask completes, run `extractSummary()` on its output
- Before each subtask starts, call `gatherDependencyContext()` to collect distilled context from all completed dependencies
- Inject the dependency context into the subagent's prompt between the task description and the workspace context

#### 2.4 Update hive mind integration

Modify `executionLedger.ts` to store structured summaries instead of raw `accomplishmentSummary` strings. The mid-round refresh already shows completed tasks — now it'll show precise file manifests and key exports from structured data.

### Exit Criteria
- Every subagent output is parsed for structured summary
- Downstream tasks receive distilled context from their dependencies
- Token growth is linear (O(n)), not exponential (O(2^n))

---

## Phase 3: Skill System Enhancement (1-2 hours)

**Rationale:** OpenClaw and the CLI System both show that **skill-aware routing** dramatically improves output quality. The right skill instructions, loaded at the right time, turn a generic model into a specialist.

### What We're Building
An enhanced skill system that:
1. Auto-infers which skill applies to each task
2. Loads skill instructions lazily (only when needed)
3. Lists available skills in the system prompt without loading full content

### Architecture

```
System Prompt includes:
  <available_skills>
    <skill name="api" description="Express/REST specialist" />
    <skill name="database" description="SQL/Prisma specialist" />
    <skill name="frontend" description="React/CSS specialist" />
    ...
  </available_skills>

TaskDecomposer infers: task "Build user API endpoints" → skill: "api"
SubagentManager loads: .vscode/johann/skills/api/SKILL.md → full instructions
SubagentManager injects: skill instructions into subagent prompt
```

### Implementation

#### 3.1 Enhance `src/johann/skills.ts`

```typescript
// Add YAML frontmatter parsing
interface SkillDefinition {
    name: string;
    description: string;
    keywords: string[];          // for inference
    requires?: {
        anyBins?: string[];      // at least one must exist
        filePatterns?: string[]; // workspace must contain matching files
    };
    fullContent: string;         // loaded on demand
}

// Keyword-based inference (from CLI System)
inferSkillFromDescription(description: string): string | undefined

// Lazy loading: list names/descriptions without loading full content
getSkillListing(): Array<{ name: string; description: string }>

// Load full content only when needed
loadSkillContent(name: string): Promise<string | undefined>
```

#### 3.2 Create default skills

Create skill files in Fugue's bundled assets that get copied to `.vscode/johann/skills/` on bootstrap:

| Skill | Description | Keywords |
|-------|-------------|----------|
| `api` | REST/GraphQL endpoint specialist | endpoint, route, api, http, middleware |
| `database` | Schema design, migrations, queries | database, schema, model, query, migration |
| `frontend` | UI components, styling, layout | component, page, ui, css, html, react, vue |
| `testing` | Test writing, coverage, assertions | test, spec, coverage, assert, mock |
| `devops` | Docker, CI/CD, deployment | docker, deploy, ci, pipeline, kubernetes |
| `refactor` | Code organization, cleanup, patterns | refactor, clean, organize, extract, rename |

#### 3.3 Wire into TaskDecomposer

After decomposing tasks, auto-infer skills:
```typescript
for (const task of plan.subtasks) {
    if (!task.skillHint) {
        task.skillHint = skillLoader.inferSkillFromDescription(task.description);
    }
}
```

#### 3.4 Wire into SubagentManager

When building the subagent prompt, if a skill is assigned:
```typescript
if (subtask.skillHint) {
    const skillContent = await skillLoader.loadSkillContent(subtask.skillHint);
    if (skillContent) {
        prompt = `${skillContent}\n\n---\n\n${prompt}`;
    }
}
```

#### 3.5 Add skill listing to system prompt

In `systemPrompt.ts`, include the compact skill listing so the planning LLM knows what specialists are available.

### Exit Criteria
- Skills auto-inferred from task descriptions
- Skill instructions loaded lazily (not pre-loaded into context)
- System prompt includes skill listing for planning awareness
- Workspace and user-defined skills override bundled defaults

---

## Phase 4: Inter-Agent Communication (1-2 hours)

**Rationale:** Gas Town's mail system and the CLI System's `inject_context` are both solutions to the same problem: agents need to share information during execution, not just at handoff boundaries. The current hive mind is read-only for subagents — they see what others did, but can't send messages.

### What We're Building
A lightweight message bus that allows subagents to:
1. **Broadcast** discoveries (e.g., "I installed `ddev` globally, everyone can use it now")
2. **Signal** conflicts (e.g., "I'm modifying `package.json`, hold off")
3. **Request help** from the orchestrator (e.g., "I need a decision on database choice")

This is NOT a full mail system — it's a shared message board that agents check during their hive mind refresh.

### Architecture

```
.vscode/johann/sessions/<sessionId>/
  ├── ledger.json          ← existing: global state
  ├── messages/            ← NEW: inter-agent message board
  │   ├── broadcast.jsonl  ← global announcements
  │   └── <subtaskId>.jsonl ← direct messages to a specific subtask
  └── journal/             ← existing: per-subtask logs
```

### Implementation

#### 4.1 Create `src/johann/messageBus.ts`

```typescript
interface AgentMessage {
    id: string;
    from: string;       // subtask ID
    to: string;         // subtask ID or '*' for broadcast
    type: 'broadcast' | 'conflict' | 'request' | 'info';
    subject: string;
    body: string;
    timestamp: string;
    read: boolean;
}

class MessageBus {
    // Write a message (subagent → board)
    async send(msg: Omit<AgentMessage, 'id' | 'timestamp'>): Promise<void>
    
    // Read unread messages for a subtask (includes broadcasts)
    async getUnread(subtaskId: string): Promise<AgentMessage[]>
    
    // Mark messages as read
    async markRead(messageIds: string[]): Promise<void>
    
    // Get all messages (for orchestrator monitoring)
    async getAll(): Promise<AgentMessage[]>
}
```

#### 4.2 Integrate into hive mind refresh

During `buildMidRoundRefresh()`, include unread messages:

```
=== 🐝 HIVE MIND UPDATE (round 5) ===

**Messages from other agents:**
  📢 [task-2] BROADCAST: "Installed ddev globally — all tasks can use `ddev` CLI"
  ⚠️ [task-3] CONFLICT: "Currently modifying package.json — wait before editing"

**Completed by other agents:**
  ✅ Set up database schema → models/user.ts, models/post.ts
...
```

#### 4.3 Teach subagents to send messages

Add a lightweight tool or prompt instruction that lets subagents emit signals. Since we can't add real MCP tools (VS Code extension model), we use a **structured output pattern**:

The subagent's system prompt includes:
```
When you make a discovery, install something globally, or encounter a conflict,
emit a HIVE_SIGNAL in your output:

<!--HIVE_SIGNAL:broadcast:I installed ddev globally-->
<!--HIVE_SIGNAL:conflict:Modifying package.json-->
```

The tool-loop in `subagentManager.ts` parses these signals from the model's text output between tool rounds and writes them to the message bus.

#### 4.4 Orchestrator monitoring

The orchestrator checks the message bus between waves. If a `request` type message is found, it can:
- Inject the answer into the requesting subtask's next refresh
- Escalate to the user if needed

### Exit Criteria
- Subagents can emit broadcast/conflict/info signals via structured output
- Hive mind refresh includes messages from other agents
- Orchestrator monitors and can respond to help requests
- Messages are persisted to disk (survive crashes)

---

## Phase 5: Lifecycle Hooks & Pre-Compaction Flush (1 hour)

**Rationale:** OpenClaw's hook system and pre-compaction memory flush are surgical improvements that compound over time. Hooks enable extensibility without modifying core code. The memory flush prevents catastrophic context loss.

### What We're Building
1. A typed hook system for the agent lifecycle
2. A pre-compaction memory flush that persists knowledge before context resets

### Implementation

#### 5.1 Create `src/johann/hooks.ts`

```typescript
type HookName =
    | 'before_planning'
    | 'after_planning'  
    | 'before_subtask'
    | 'after_subtask'
    | 'before_merge'
    | 'after_merge'
    | 'before_memory_write'
    | 'on_error'
    | 'on_context_limit'    // pre-compaction trigger
    | 'on_session_start'
    | 'on_session_end';

interface HookHandler {
    name: string;
    priority: number;      // higher = runs first
    handler: (context: HookContext) => Promise<void>;
}

class HookRunner {
    register(hook: HookName, handler: HookHandler): void
    run(hook: HookName, context: HookContext): Promise<void>
}
```

#### 5.2 Wire hooks into orchestrator

Add hook calls at each lifecycle point in `orchestrator.ts`:
```typescript
await hookRunner.run('before_planning', { request, session });
const plan = await taskDecomposer.decompose(...);
await hookRunner.run('after_planning', { request, session, plan });
```

#### 5.3 Implement pre-compaction memory flush

Register a handler for `on_context_limit`:

```typescript
hookRunner.register('on_context_limit', {
    name: 'memory-flush',
    priority: 100,
    handler: async (ctx) => {
        // Inject a hidden prompt asking the model to summarize
        // what it's learned so far and write it to memory
        const summary = await this.runSilentFlush(ctx);
        await memory.recordLearning('pre-compaction-flush', summary, ['automatic']);
    }
});
```

This mirrors OpenClaw's `compaction.memoryFlush` — before any context window compaction, the agent gets a chance to persist valuable observations.

#### 5.4 Detect context limit approaching

Monitor token usage during the agentic loop in `subagentManager.ts`. When estimated usage approaches the model's context window:
```typescript
if (estimatedTokens > contextLimit * 0.85) {
    await hookRunner.run('on_context_limit', { subtaskId, round, ledger });
}
```

### Exit Criteria
- Hook system is functional with typed hook names
- At least 3 lifecycle points wired (before_subtask, after_subtask, on_context_limit)
- Pre-compaction flush writes to memory before context resets

---

## Phase 6: Testing & Validation (1 hour)

### 6.1 Unit Tests

Create `src/test/johann/` with tests for:
- `graphManager.test.ts` — wave generation, cycle detection, error propagation
- `contextDistiller.test.ts` — summary extraction, distillation, token limiting
- `skills.test.ts` — skill inference, lazy loading, precedence
- `messageBus.test.ts` — send/receive, broadcast, persistence

### 6.2 Lightweight Integration Test Prompt

Instead of the full WordPress+DDEV prototype prompt (which runs for hours), use this **5-minute validation prompt**:

```
Build a simple Express.js API with:
1. A /healthcheck endpoint
2. A /users endpoint with GET (list) and POST (create)
3. A basic SQLite database using better-sqlite3
4. Input validation middleware
5. Error handling middleware
6. Unit tests for each endpoint
7. A README.md documenting the API

Structure the project properly with separate files for routes, middleware, database, and tests.
```

**Why this works as a proxy:**
- Requires 4-6 subtasks with dependencies (DB before routes, routes before tests)
- Tests the DAG wave engine (DB + middleware in wave 0, routes in wave 1, tests in wave 2)
- Tests context distillation (routes need to know DB schema)
- Tests skill inference (database skill, api skill, testing skill)
- Tests hive mind (parallel tasks need to know about shared `package.json`)
- Produces verifiable output (tests can be run, API can be curled)
- Completes in ~5 minutes instead of hours

### 6.3 End-to-End Validation Checklist

After running the test prompt, verify:
- [ ] Plan has proper DAG structure (not flat serial)
- [ ] Waves execute in correct order with maximum parallelism
- [ ] Downstream tasks reference upstream outputs (context distillation)
- [ ] Skills auto-inferred for each task type
- [ ] Hive mind refresh shows inter-agent awareness
- [ ] Messages exchanged between agents (if applicable)
- [ ] Session recoverable from disk if interrupted mid-execution
- [ ] Memory records the task completion with structured summaries
- [ ] No duplicate files or malformed directory structure

---

## Implementation Order & Time Budget

| Phase | Duration | Cumulative | Dependencies |
|-------|----------|------------|-------------|
| **Phase 0: Cleanup** | 30 min | 0:30 | None |
| **Phase 1: DAG Waves** | 1.5 hr | 2:00 | Phase 0 |
| **Phase 2: Structured Output** | 1.5 hr | 3:30 | Phase 0 |
| **Phase 3: Skills** | 1.5 hr | 5:00 | Phase 0 |
| **Phase 4: Messaging** | 1.5 hr | 6:30 | Phase 1, 2 |
| **Phase 5: Hooks** | 1 hr | 7:30 | Phase 0 |
| **Phase 6: Testing** | 1 hr | 8:30 | All |

**Phases 1, 2, 3, and 5 are independent** and can be developed in any order after Phase 0.
**Phase 4** depends on Phases 1 and 2 (needs waves and structured output to be meaningful).
**Phase 6** validates everything.

Total estimated time: **8-9 hours** for a human working at high velocity with full context. With AI assistance doing the implementation, this is achievable in a focused day session.

---

## Key Design Decisions

### Why Not Full ACP?
ACP (Agent Client Protocol) requires spawning actual `copilot --acp --stdio` subprocesses. This works for the CLI System because it runs in a terminal. In a VS Code extension, we can't spawn Copilot CLI as a subprocess — we use `vscode.lm` APIs instead. We replicate ACP's **value** (structured sub-agent communication with context propagation) without its **mechanism** (stdio subprocess pipes).

### Why Not Full Gas Town Mail?
Gas Town's mail system is built for cross-process communication (agents in separate tmux sessions). Johann's subagents run as in-process LLM calls via `vscode.lm.sendRequest()`. They share memory space. A lightweight message bus (file-based shared board) gives us the coordination benefits without the complexity of a full message routing system with queues, channels, and claims.

### Why Not OpenClaw's Gateway?
OpenClaw runs a persistent WebSocket server because it serves multiple clients (macOS app, CLI, web, IDE bridges). Fugue IS the client. The VS Code extension host is our "gateway." We replicate the gateway's **principles** (centralized agent loop, thin UI rendering) but not its **architecture** (separate server process).

### What Makes This Different From Just "More Code"?
The individual features (waves, skills, messaging) are table stakes. The compounding effect comes from their interaction:
- **Waves + Skills** = the right specialist runs at the right time, with maximum parallelism
- **Waves + Structured Output** = downstream tasks get precise context, not noise
- **Messaging + Hive Mind** = agents coordinate in real-time, not just at handoff boundaries
- **Hooks + Memory Flush** = the system never loses knowledge, even on crashes
- **All Together** = a self-aware orchestrator that can explain its own architecture, recover from failures, and improve over time

This is the difference between "a tool that runs multiple LLM calls" and "a system that orchestrates intelligent work."
