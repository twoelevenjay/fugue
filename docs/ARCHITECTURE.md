# Architecture

> High-level architecture of Fugue for GitHub Copilot.

## System Overview

Fugue is a VS Code extension that adds two chat participants to GitHub Copilot Chat:

```
User Input
    │
    ├─→ @ramble ─→ Prompt compilation (analysis, context, clarification)
    │                   │
    │                   └─→ Compiled prompt (copy or forward to @johann)
    │
    └─→ @johann ─→ Multi-step orchestration
                        │
                        ├─ Plan (task decomposition)
                        ├─ Execute (subagent dispatch)
                        ├─ Review (merge + validate)
                        └─ Remember (persistent memory)
```

### Extension Entry Point

[src/extension.ts](src/extension.ts) — Registers both chat participants, manages workspace context gathering, implements the `@ramble` prompt compiler with chunking support.

### Johann Subsystem

All Johann code lives in `src/johann/`. The subsystem is organized into these layers:

## Layer 1: Chat Interface

| File | Purpose |
|------|---------|
| `participant.ts` | `@johann` chat participant registration, request routing, workspace trust gate |
| `directives.ts` | Slash command handling (`/help`, `/status`, `/memory`, `/config`, `/yolo`) |
| `systemPrompt.ts` | Multi-section system prompt assembly from SOUL.md, skills, and context |
| `bootstrap.ts` | First-run workspace setup (creates `.vscode/johann/` directory structure) |
| `templates.ts` | Bootstrap file templates (SOUL.md, memory seeds) |

## Layer 2: Orchestration

| File | Purpose |
|------|---------|
| `orchestrator.ts` | Core 4-phase pipeline: Plan → Execute → Merge → Memory |
| `taskDecomposer.ts` | LLM-powered task decomposition to JSON execution plan |
| `subagentManager.ts` | Agentic tool-calling loop (30 rounds max) with review |
| `subagentRegistry.ts` | Tracks active/completed subagents |
| `announceFlow.ts` | Subagent completion notifications |
| `flowCorrection.ts` | Mid-execution plan adjustment |
| `graphManager.ts` | Dependency graph for parallel execution |

## Layer 3: Model Selection

| File | Purpose |
|------|---------|
| `modelPicker.ts` | 5-tier model selection with cost-aware routing |
| `modelSelectionGuide.ts` | Model capability descriptions for prompt enrichment |
| `rateLimitGuard.ts` | Token bucket rate limiting across model calls |
| `retry.ts` | Exponential backoff retry with jitter |

## Layer 4: Skills System

| File | Purpose |
|------|---------|
| `skillSystem.ts` | Main entry point — unified skill management |
| `skillStore.ts` | File-based skill storage (SKILL.md files) |
| `skillValidator.ts` | Security validation with injection blocklist |
| `skillSchema.ts` | YAML frontmatter schema and parsing |
| `skillSelector.ts` | Task-to-skill matching |
| `skillLifecycle.ts` | Skill lifecycle management (install, update, remove) |
| `skillLedger.ts` | Usage tracking and statistics |
| `skillPromotion.ts` | Session → global skill promotion |
| `skillFlattener.ts` | Context-window flattening (inline vs. reference) |
| `skillCaps.ts` | Size/count limits and enforcement |
| `shippedSkills.ts` | Built-in skill definitions |
| `skillTypes.ts` | Type definitions for the skill system |

## Layer 5: Persistence

| File | Purpose |
|------|---------|
| `memory.ts` | File-based persistent memory (facts, decisions, learnings) |
| `memorySearch.ts` | Keyword search across memory entries |
| `dailyNotes.ts` | Append-only daily log files |
| `sessionTranscript.ts` | JSONL conversation recording |
| `sessionPersistence.ts` | Session state save/restore for crash recovery |
| `executionLedger.ts` | Real-time coordination ledger (hive mind) |
| `safeIO.ts` | Mutex + atomic write for all `.vscode/johann/` file I/O |

## Layer 6: Infrastructure

| File | Purpose |
|------|---------|
| `worktreeManager.ts` | Git worktree isolation for parallel subtasks |
| `toolVerifier.ts` | Pre-flight tool availability checks (`which`) |
| `config.ts` | VS Code settings-based configuration |
| `logger.ts` | Structured logging |
| `heartbeat.ts` | Periodic self-check timer |
| `messageBus.ts` | Internal event bus |
| `hooks.ts` | Lifecycle hook system |
| `contextDistiller.ts` | Context window optimization |
| `types.ts` | Core type definitions |
| `index.ts` | Public exports |

## Layer 7: Progress Reporting

| File | Purpose |
|------|---------|
| `chatProgressReporter.ts` | Chat-integrated progress display |
| `backgroundProgressReporter.ts` | VS Code notification-area progress |
| `backgroundTaskManager.ts` | Background task lifecycle |
| `progressEvents.ts` | Progress event types |

## Multi-Pass Execution (Designed, Not Yet Wired)

| File | Purpose |
|------|---------|
| `multiPassExecutor.ts` | Multi-pass execution engine |
| `multiPassStrategies.ts` | Strategy definitions (iterative refinement, breadth-first) |

## Storage Layout

All persistent state is stored under `.vscode/johann/` in the workspace:

```
.vscode/johann/
├── SOUL.md              # Johann's personality and instructions
├── memory/              # Long-term memory entries
├── daily/               # Daily log files
├── transcripts/         # JSONL conversation logs
├── ledger/              # Execution ledger files
├── skills/
│   ├── session/         # Temporary session skills
│   └── global/          # Promoted persistent skills
├── skill-ledger.json    # Skill usage statistics
└── session-state.json   # Crash recovery checkpoint
```

## Data Flow: A Typical @johann Request

```
1. User sends "@johann implement feature X"
2. participant.ts receives the request
   ├── Checks workspace trust (refuses if untrusted)
   ├── Assembles system prompt (systemPrompt.ts)
   └── Calls orchestrator.ts
3. orchestrator.ts runs the 4-phase pipeline:
   a. PLAN: taskDecomposer.ts → JSON plan with subtasks
   b. EXECUTE: For each subtask:
      ├── modelPicker.ts selects the best model
      ├── subagentManager.ts runs the tool-calling loop
      ├── executionLedger.ts records progress in real-time
      └── worktreeManager.ts isolates file changes (if needed)
   c. MERGE: Collect results, resolve conflicts
   d. MEMORY: Persist decisions and learnings
4. Results streamed back to Copilot Chat
```

## Security Boundaries

See [SECURITY.md](SECURITY.md) for the full security model. Key boundaries:

- **No network access** — Extension cannot make HTTP requests
- **No shell execution** — Only `execFile('git', ...)` and `execFile('which', ...)`
- **Subagent isolation** — Subagents never see Johann's system prompt or memory
- **Path validation** — All `fs.rm()` calls are guarded by `assertSafePath()`
- **Workspace trust** — Extension refuses to operate in Restricted Mode
