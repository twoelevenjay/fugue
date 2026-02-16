# Johann — Orchestration Agent Architecture

> Comprehensive documentation of Johann's orchestrator functionality, its layered relationship with GitHub Copilot, and internal communication mechanisms.

---

## Table of Contents

1. [Overview](#overview)
2. [Layered Orchestration Model](#layered-orchestration-model)
3. [Architecture Diagram](#architecture-diagram)
4. [Core Components](#core-components)
5. [Orchestration Flow](#orchestration-flow)
6. [Memory & Internal Communication](#memory--internal-communication)
7. [Model Selection & Escalation](#model-selection--escalation)
8. [Subagent System](#subagent-system)
9. [Bootstrap & Self-Evolution](#bootstrap--self-evolution)
10. [Skills System](#skills-system)
11. [Session Transcripts](#session-transcripts)
12. [Heartbeat System](#heartbeat-system)
13. [Directives (Slash Commands)](#directives-slash-commands)
14. [Configuration Reference](#configuration-reference)
15. [YOLO Mode](#yolo-mode)
16. [Handling Large Inputs](#handling-large-inputs)
17. [OpenClaw Inspirations](#openclaw-inspirations)

---

## Overview

**Johann** is an orchestration agent that runs inside VS Code as a GitHub Copilot Chat participant (`@johann`). It transforms complex, multi-step tasks into structured execution plans, delegates subtasks to specialized subagents (each powered by an LLM), reviews their outputs, escalates between models when needed, and merges everything into a coherent response.

Johann is designed around a key insight: **Copilot itself is an orchestrator**, and Johann operates as a **meta-orchestrator on top of Copilot**, creating a layered orchestration system. This means:

- **Layer 1 — GitHub Copilot:** Provides access to language models, tool use, and the VS Code integration surface. Copilot manages its own internal orchestration (model routing, tool calls, context window management).
- **Layer 2 — Johann:** Sits on top of Copilot as a chat participant. Johann decomposes tasks, selects models, spawns subagents (each a separate LLM invocation), reviews results, handles escalation, and maintains persistent memory across sessions.

This layered design means Johann doesn't replace Copilot — it enhances it by adding task decomposition, multi-model orchestration, persistent memory, and self-evolving identity.

---

## Layered Orchestration Model

```
┌─────────────────────────────────────────────────────────┐
│                    User (VS Code)                        │
│                                                         │
│  ┌─────────────┐    ┌──────────────────────────────┐   │
│  │  @ramble     │───▶│  Compile prompt              │   │
│  │  (prompt     │    │  ──────▶ @johann followup    │   │
│  │   compiler)  │    └──────────────────────────────┘   │
│  └─────────────┘                                        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │                @johann (Layer 2)                  │   │
│  │                                                    │  │
│  │  ┌────────────┐  ┌─────────┐  ┌──────────────┐   │  │
│  │  │ Task       │  │ Model   │  │ Subagent     │   │  │
│  │  │ Decomposer │  │ Picker  │  │ Manager      │   │  │
│  │  └─────┬──────┘  └────┬────┘  └──────┬───────┘   │  │
│  │        │              │              │            │  │
│  │  ┌─────▼──────────────▼──────────────▼───────┐    │  │
│  │  │           Orchestrator Core                │    │  │
│  │  │  plan → execute → review → escalate → merge│    │  │
│  │  └───────────────────┬───────────────────────┘    │  │
│  │                      │                            │  │
│  │  ┌──────────┐  ┌─────▼──────┐  ┌────────────┐    │  │
│  │  │ Memory   │  │ Session    │  │ Subagent   │    │  │
│  │  │ System   │  │ Transcript │  │ Registry   │    │  │
│  │  └──────────┘  └────────────┘  └────────────┘    │  │
│  └──────────────────────────────────────────────────┘   │
│                           │                              │
│  ┌────────────────────────▼─────────────────────────┐   │
│  │          GitHub Copilot (Layer 1)                 │   │
│  │                                                    │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐    │  │
│  │  │ GPT-4o   │  │ Claude   │  │ Gemini       │    │  │
│  │  │          │  │ Sonnet   │  │ Flash/Pro    │    │  │
│  │  └──────────┘  └──────────┘  └──────────────┘    │  │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Key Insight: Meta-Orchestration

Johann doesn't directly call OpenAI or Anthropic APIs. Instead, it uses VS Code's `vscode.lm.selectChatModels()` API to discover whatever models Copilot makes available, then orchestrates across them. This means:

1. **Johann** doesn't need API keys — Copilot handles all authentication.
2. **Johann** automatically benefits from new models Copilot adds.
3. **Johann** can leverage Copilot's own internal optimizations (caching, routing).
4. The user's **Copilot subscription** determines which models are available.

---

## Core Components

### Orchestrator (`orchestrator.ts`)
The top-level controller. Coordinates the full lifecycle:
1. Receives user request via `@johann` chat participant
2. Creates a `JohannSession` with unique ID
3. Delegates planning to `TaskDecomposer`
4. Delegates execution to `SubagentManager` (with model selection from `ModelPicker`)
5. Reviews and escalates results
6. Merges outputs into final response
7. Persists to `MemorySystem`

### Task Decomposer (`taskDecomposer.ts`)
Analyzes user requests and produces an `OrchestrationPlan`:
- Determines if the task needs single or multi-agent execution
- Breaks complex tasks into subtasks with dependencies
- Assigns complexity ratings (`trivial` → `expert`) to each subtask
- Defines success criteria per subtask
- Chooses execution strategy: `serial`, `parallel`, or `mixed`

### Model Picker (`modelPicker.ts`)
Intelligent model selection and escalation:
- Discovers all available models via `vscode.lm.selectChatModels()`
- Classifies models into 5 capability tiers
- Maps task complexity to ideal model tier
- Supports **non-linear escalation** — can go UP (task too hard) or DOWN (model overthinking)
- One try per model — if review fails, try next candidate

**Tier System:**
| Tier | Category | Example Models |
|------|----------|---------------|
| 5 | Frontier | Opus, O1-Pro, GPT-5 |
| 4 | Advanced | Sonnet, GPT-4o, O3, Gemini Pro |
| 3 | Capable | GPT-4, O1-Preview, O3-Mini, Gemini Flash |
| 2 | Standard | GPT-4o-Mini, O1-Mini, Haiku |
| 1 | Basic | GPT-3 variants |

### Subagent Manager (`subagentManager.ts`)
Spawns and manages individual subagent executions:
- Each subagent is a single LLM invocation with its own model
- Builds self-contained prompts including dependency context
- Streams output live to the chat response
- Reviews output against success criteria using a separate LLM call
- Produces `SubtaskResult` objects for the orchestrator

### Memory System (`memory.ts`)
Persistent memory stored in `.vscode/johann/`:
- Timestamped markdown files organized by category
- Categories: `task`, `decision`, `learning`, `context`, `error`
- Records task completions, decisions, learnings, and errors
- Provides recent memory context for prompt injection
- Survives VS Code restarts and session boundaries

---

## Orchestration Flow

```
User sends request to @johann
        │
        ▼
┌─── PHASE 1: PLANNING ───┐
│ TaskDecomposer analyzes   │
│ request with workspace    │
│ context + memory context  │
│                           │
│ Produces:                 │
│  - OrchestrationPlan      │
│  - Subtask[]              │
│  - Strategy               │
│  - Success criteria       │
└───────────┬───────────────┘
            │
            ▼
┌─── PHASE 2: EXECUTION ──┐
│ For each ready subtask:  │
│                          │
│  1. ModelPicker selects   │
│     best model for       │
│     complexity level     │
│                          │
│  2. SubagentManager      │
│     executes subtask     │
│     with selected model  │
│                          │
│  3. Review output        │
│     against criteria     │
│                          │
│  4. If review fails:     │
│     escalate to new      │
│     model and retry      │
│                          │
│  Respects dependencies:  │
│  task-2 waits for task-1 │
│  if task-2 depends on it │
└───────────┬──────────────┘
            │
            ▼
┌─── PHASE 3: SYNTHESIS ──┐
│ Merge all subtask        │
│ results into unified     │
│ response using LLM       │
│                          │
│ Single subtask → direct  │
│ Multiple → LLM merge     │
└───────────┬──────────────┘
            │
            ▼
┌─── PHASE 4: MEMORY ─────┐
│ Record task completion   │
│ Record escalation        │
│ patterns as learnings    │
│ Record errors if any     │
│ Update daily notes       │
│ Close session transcript │
└──────────────────────────┘
```

---

## Memory & Internal Communication

### The File-Based Communication Model

Johann documents its actions in text files to enable **internal communication and programming awareness among agents**. This is a critical design principle:

1. **Files as Shared State:** The `.vscode/johann/` directory acts as a shared filesystem between the main agent and all subagents. Any agent can read these files to understand what has happened.

2. **Daily Notes (`memory/YYYY-MM-DD.md`):** Raw working memory. Events, observations, learnings, decisions, and errors are appended throughout the day. This is the "scratchpad" — the agent's stream of consciousness.

3. **Curated Memory (`MEMORY.md`):** Long-term knowledge distilled from daily notes. During heartbeats, Johann reviews daily notes and promotes important items to MEMORY.md.

4. **Session Transcripts (`sessions/*.jsonl`):** JSONL-format logs of every conversation. Each entry records the role (user/agent/system/subtask), content, and metadata.

5. **Subagent Registry (`registry/*.json`):** Tracks every subagent spawned — what model it used, whether it succeeded, how long it took, and whether it was an escalation.

6. **Announce Flow (`announceFlow.ts`):** When a subagent completes, a structured notification is built and injected back into the main agent's context. This enables the main agent to understand what happened without relying on conversation history.

### Why Files Instead of In-Memory State?

- **Persistence:** Files survive VS Code restarts. In-memory state doesn't.
- **Transparency:** Users can open and inspect any file in `.vscode/johann/`.
- **Cross-Session Continuity:** Today's session can read yesterday's daily notes.
- **Agent Self-Awareness:** The agent can read its own SOUL.md to understand its personality, its USER.md to know about its human, and its MEMORY.md to recall past decisions.
- **Debuggability:** When something goes wrong, the full paper trail is on disk.

### Memory Categories

| Category | File | Purpose | Editable |
|----------|------|---------|----------|
| Identity | `SOUL.md` | Agent personality, tone, values | Yes — evolves over time |
| Identity | `IDENTITY.md` | Structured name/emoji/vibe | Yes |
| User Profile | `USER.md` | Human's preferences and info | Yes — updated as learned |
| Instructions | `AGENTS.md` | Operating manual and safety rules | Yes (with care) |
| Environment | `TOOLS.md` | Device and tool notes | Yes |
| Long-Term Memory | `MEMORY.md` | Curated, distilled knowledge | Yes — maintained actively |
| Working Memory | `memory/*.md` | Raw daily logs (append-only) | Yes |
| Heartbeat Tasks | `HEARTBEAT.md` | Periodic check list | Yes |
| Sessions | `sessions/*.jsonl` | Conversation transcripts | Read-only (auto-generated) |
| Registry | `registry/*.json` | Subagent tracking | Read-only (auto-generated) |
| Skills | `skills/*/SKILL.md` | Discoverable skill definitions | Yes |

---

## Model Selection & Escalation

### Selection Algorithm

```
Given task complexity (e.g., "complex"):
  1. Map complexity → ideal tier (e.g., 4) and acceptable range (3-5)
  2. Filter available models to those in the acceptable range
  3. Sort by distance from ideal tier
  4. Pick the closest match
  5. If no models in range, pick the closest available model period
```

### Escalation Algorithm

When a subtask fails review:
```
  1. Analyze the failure reason
  2. Decide escalation direction:
     - Task too hard → escalate UP (higher tier)
     - Model overthinking → escalate DOWN (lower tier)
  3. Pick the best untried model in that direction
  4. Re-execute the subtask
  5. Repeat until maxAttempts reached or success
```

**Down-escalation triggers** (heuristic):
- Output too verbose
- Over-engineered solution
- Hallucination detected
- Off-topic response

**Default:** Escalate up (task was too hard).

---

## Subagent System

### Subagent Lifecycle

```
Spawned → Running → [Review] → Completed/Failed → [Escalated]
```

1. **Spawned:** SubagentManager receives a subtask with a model selection
2. **Running:** LLM invocation begins, output streams live
3. **Review:** A separate LLM call evaluates output against success criteria
4. **Completed:** Output accepted, results stored
5. **Failed:** Review rejected output — may trigger escalation
6. **Escalated:** New model selected, subtask re-executed

### Subagent Isolation

Each subagent:
- Gets its own prompt (self-contained with all needed context)
- Gets reduced bootstrap files (only `AGENTS.md` + `TOOLS.md`)
- Has NO awareness of other subagents running simultaneously
- Cannot initiate heartbeats, memory maintenance, or proactive actions
- Is ephemeral — may be terminated after completion

### Dependency Resolution

Subtasks can declare dependencies via `dependsOn`:
```json
{
  "id": "task-2",
  "dependsOn": ["task-1"],
  "description": "Using the output from task-1..."
}
```

The orchestrator ensures task-1's output is available before task-2 executes. The output is injected into task-2's prompt under "RESULTS FROM PREVIOUS SUBTASKS".

---

## Bootstrap & Self-Evolution

### First Run

On first run in a workspace, Johann:
1. Creates `.vscode/johann/` directory structure
2. Copies template files (SOUL.md, IDENTITY.md, USER.md, etc.)
3. Creates `BOOTSTRAP.md` — a first-run onboarding guide
4. Asks the user about their name, timezone, project, and preferences
5. Updates its files based on the conversation
6. Deletes BOOTSTRAP.md to mark onboarding complete

### Self-Evolution

Johann's files are **designed to be evolved by the agent itself**:
- As Johann learns about the user, it updates `USER.md`
- As Johann discovers its own style preferences, it updates `SOUL.md`
- As decisions are made, they're recorded in `MEMORY.md`
- The system prompt explicitly instructs: *"These files are YOURS to evolve."*

This creates a feedback loop where Johann becomes more personalized and effective over time, without requiring the user to manually configure anything.

---

## Skills System

Skills are discoverable instruction sets stored in `.vscode/johann/skills/`:

```
.vscode/johann/skills/
  my-skill/
    SKILL.md          ← Description + instructions
    supporting.md     ← Optional supporting files
```

At startup, Johann discovers all skills and injects their descriptions into the system prompt. When a user request matches a skill's description, Johann follows that skill's instructions.

### Creating Skills

Use the `createSkill()` API or manually create a directory under `skills/`:

```markdown
# my-skill
> Short description of what this skill does

## Instructions
When this skill is triggered:
1. Do step one
2. Do step two
```

---

## Session Transcripts

Every conversation is recorded as a JSONL file in `.vscode/johann/sessions/`:

```json
{"ts":"2026-02-14T10:00:00Z","role":"user","content":"Build a REST API"}
{"ts":"2026-02-14T10:00:05Z","role":"agent","content":"(orchestration complete)"}
```

Each session also gets a `.meta.json` file with summary info:
```json
{
  "sessionId": "s-abc123",
  "startedAt": "2026-02-14T10:00:00Z",
  "endedAt": "2026-02-14T10:05:00Z",
  "summary": "Build a REST API",
  "active": false
}
```

---

## Heartbeat System

The heartbeat is a periodic timer that fires every N minutes (default: 15):

1. Reads `HEARTBEAT.md` for a checklist of maintenance tasks
2. Executes lightweight file-based checks (no LLM calls)
3. Logs heartbeat events to daily notes
4. Can trigger memory compaction (daily notes → MEMORY.md)

Enable/disable via `johann.heartbeatEnabled` setting.

---

## Directives (Slash Commands)

| Directive | Description |
|-----------|-------------|
| `/help` | Show available commands |
| `/status` | Show Johann's state, memory count, sessions |
| `/compact` | Minimal one-line status |
| `/memory` | Show MEMORY.md content |
| `/search <query>` | Keyword search across all memory |
| `/config` | Show current configuration |
| `/notes [date]` | Show daily notes (today or specific date) |
| `/sessions` | List recent session transcripts |

---

## Configuration Reference

All settings are under the `johann.*` namespace in VS Code:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `johann.maxSubtasks` | number | 10 | Maximum subtasks per plan |
| `johann.maxAttempts` | number | 3 | Max attempts per subtask |
| `johann.allowParallel` | boolean | true | Allow parallel subtask execution |
| `johann.memoryDir` | string | `.vscode/johann` | Memory directory path |
| `johann.maxBootstrapChars` | number | 15000 | Max chars for bootstrap context |
| `johann.heartbeatEnabled` | boolean | false | Enable periodic heartbeat |
| `johann.heartbeatIntervalMinutes` | number | 15 | Heartbeat interval |
| `johann.transcriptsEnabled` | boolean | true | Record session transcripts |
| `johann.logLevel` | string | `info` | Logging level |
| `johann.onboardingEnabled` | boolean | true | Show first-run onboarding |
| `johann.autoDistill` | boolean | true | Auto-distill daily notes |
| `johann.promptMode` | string | `full` | System prompt mode (full/minimal/none) |
| `johann.largeInputChunkSize` | number | 8000 | Character threshold for chunking large inputs |
| `johann.maxInputSize` | number | 100000 | Maximum input size before truncation |

### Copilot Settings (Not Johann's — Read for Awareness)

| Setting | What It Controls |
|---------|-----------------|
| `github.copilot.chat.agent.autoApprove` | Whether Copilot skips "Allow" confirmation for commands |
| `github.copilot.chat.agent.maxRequests` | Max LLM requests per session before Copilot pauses |

Johann reads these settings via `/yolo` and pre-orchestration checks but does not own or override them.

---

## YOLO Mode

"YOLO mode" removes confirmation friction during long-running orchestrations. It is controlled by **GitHub Copilot's settings**, not Johann's.

### The Problem

During complex orchestrations, Johann makes many LLM requests (planning + subtask execution + review + merge + escalation). Copilot has built-in limits that can interrupt this:

1. **Command approval** — Copilot shows "Allow?" before each terminal command or file edit
2. **Request limit** — After N requests, Copilot pauses with "Would you like to continue?"

When these fire mid-orchestration, Johann appears to freeze.

### The Settings (Copilot's, Not Johann's)

| Setting | What It Controls | Recommended Value |
|---------|-----------------|-------------------|
| `github.copilot.chat.agent.autoApprove` | Skips "Allow" confirmation for commands | `true` |
| `github.copilot.chat.agent.maxRequests` | Max LLM requests per session before pausing | `200` |

These are GitHub Copilot settings in VS Code — Johann reads them for awareness but does not own or override them.

### How Johann Handles Limits

- **Pre-orchestration check:** Johann reads `maxRequests` before starting and warns if it's too low for the plan's complexity
- **Rate-limit detection:** If an LLM call fails due to request limits, Johann catches the error and tells the user exactly what to change
- **`/yolo` directive:** Type `@johann /yolo` to see current Copilot settings, or `/yolo on` for guided setup

### Johann's Own Limits

These settings ARE Johann's and affect orchestration complexity:

| Setting | Default | Description |
|---------|---------|-------------|
| `johann.maxSubtasks` | `10` | Max subtasks per plan (each = 1+ LLM calls) |
| `johann.maxAttempts` | `3` | Max retries per subtask (each retry = 1+ LLM calls) |

Raising these increases the total LLM requests needed. Make sure Copilot's `maxRequests` is high enough to accommodate.

See [YOLO-MODE.md](YOLO-MODE.md) for the full guide.

### Safety Notes

YOLO mode disables certain Copilot safety guardrails. Recommended only when:
- You trust the workspace and project
- You're actively monitoring the output
- The task is well-defined and non-destructive

Even in YOLO mode, Johann still:
- Logs all actions to daily notes and session transcripts
- Records decisions and learnings to memory
- Follows the safety rules in AGENTS.md (no secret exposure, no fabrication)

---

## Handling Large Inputs

### The Problem

When users paste large feature lists (e.g., 50+ features from another project), several bottlenecks can occur:

1. **Context window overflow:** The LLM's context window has a token limit. Large inputs + workspace context + system prompt can exceed it.
2. **Single-pass extraction failure:** A single LLM call may lose information when processing a very large input.
3. **Command confirmation freezing:** Long orchestrations trigger VS Code's confirmation dialog, causing the process to freeze.
4. **Timeout issues:** Large inputs take longer to process, increasing the risk of timeout.

### Solutions Implemented

1. **Input chunking:** Fugue's analysis phase automatically detects inputs exceeding a threshold and processes them in chunks:
   - Each chunk is analyzed independently to extract features
   - Results are merged, deduplicated, and organized
   - No information is lost because each chunk is small enough for reliable extraction

2. **Streaming responses:** All LLM interactions stream output live to the chat window, providing immediate feedback and preventing apparent freezes.

3. **Progressive context building:** Instead of sending the entire input in one message, context is built progressively:
   - First pass: extract high-level structure
   - Second pass: fill in details for each section
   - This keeps each individual LLM call within comfortable token limits

4. **Configurable limits:** Key limits can be adjusted:
   - `johann.maxBootstrapChars`: Max chars for bootstrap context (default: 15000)
   - Memory context and daily notes are auto-truncated to fit

5. **YOLO mode:** For long orchestrations, YOLO mode prevents confirmation prompts from freezing the process (see [YOLO Mode](#yolo-mode)).

---

## OpenClaw Inspirations

Johann's architecture draws significant inspiration from [OpenClaw](https://github.com/openclaw), an open-source orchestration framework. Key concepts adopted:

### From OpenClaw's Architecture

| Concept | OpenClaw | Johann Implementation |
|---------|----------|----------------------|
| **Bootstrap files** | Workspace persona files loaded into system prompt | `.vscode/johann/` directory with SOUL.md, IDENTITY.md, etc. |
| **System prompt assembly** | Multi-section system prompt builder | `systemPrompt.ts` — Identity, Safety, Tools, Memory, Skills, Runtime sections |
| **Skills system** | Discoverable skill directories with instructions | `.vscode/johann/skills/` with SKILL.md metadata |
| **Daily notes** | Append-only daily log files | `memory/YYYY-MM-DD.md` with categorized entries |
| **Heartbeat** | Periodic self-check timer | `heartbeat.ts` — configurable maintenance pulse |
| **Announce flow** | Subagent completion notifications | `announceFlow.ts` — structured result reporting |
| **Subagent registry** | Agent tracking with status, timing, escalation | `subagentRegistry.ts` — persistent JSON snapshots |
| **Self-evolution** | Agent updates its own configuration files | SOUL.md, USER.md, MEMORY.md are agent-writable |

### Layered Orchestration Insight

The most critical insight from the OpenClaw author's video:

> **"Johann is an orchestrator that can spin up Copilot sessions. Copilot itself acts as an orchestrator, creating a layered orchestration system."**

This layered model means:
- Johann delegates to Copilot's language models (Layer 1)
- Johann handles the meta-orchestration: planning, model selection, review, escalation (Layer 2)
- The communication between layers happens through VS Code's `vscode.lm` API
- No direct API calls to model providers needed

### Agent Communication via Text Files

> **"Johann documents its actions in text files to enable internal communication and programming awareness among agents."**

This principle drives the entire memory architecture:
- Actions are logged to daily notes
- Decisions are recorded to MEMORY.md
- Session transcripts capture full conversations
- Subagent registries track every invocation
- All of this is on disk, inspectable, and persistent
