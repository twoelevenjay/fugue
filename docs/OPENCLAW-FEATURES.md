# OpenClaw Feature Integration Matrix

> Tracks which features from the OpenClaw orchestration framework have been adopted, adapted, or planned for Ramble/Johann.

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Implemented |
| 🔨 | In progress |
| 📋 | Planned |
| ➖ | Not applicable / Intentionally excluded |

---

## Core Orchestration

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 1 | **Meta-orchestrator pattern** | ✅ | `orchestrator.ts` — Johann orchestrates Copilot's models as subagents | Layered orchestration: Johann (L2) on top of Copilot (L1) |
| 2 | **Task decomposition** | ✅ | `taskDecomposer.ts` — LLM-powered task breakdown with dependencies | Produces `OrchestrationPlan` with subtasks, strategy, criteria |
| 3 | **Multi-model routing** | ✅ | `modelPicker.ts` — 5-tier model classification and selection | Maps task complexity to model capability tier |
| 4 | **Model escalation** | ✅ | `modelPicker.ts` — Non-linear escalation (up or down) | Heuristic-based: too hard→up, overthinking→down |
| 5 | **Subagent spawning** | ✅ | `subagentManager.ts` — Independent LLM invocations per subtask | Each subagent gets self-contained prompt + dependencies |
| 6 | **Subagent review** | ✅ | `subagentManager.ts` — Success criteria evaluation | Separate LLM call reviews output against criteria |
| 7 | **Result merging** | ✅ | `orchestrator.ts` — LLM-powered synthesis of subtask outputs | Single subtask → direct return, multi → LLM merge |
| 8 | **Dependency graph execution** | ✅ | `orchestrator.ts` — Respects `dependsOn` ordering | Tasks execute only when all dependencies complete |
| 9 | **Parallel execution support** | ✅ | Config: `johann.allowParallel` | Currently serial execution with parallel config; full parallel planned |

---

## Memory & Persistence

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 10 | **File-based agent memory** | ✅ | `memory.ts` — Timestamped markdown files in `.vscode/johann/` | Categories: task, decision, learning, context, error |
| 11 | **Agent self-documentation** | ✅ | Agents document actions in text files for inter-agent communication | Core principle from OpenClaw author's video |
| 12 | **Daily notes (working memory)** | ✅ | `dailyNotes.ts` — Append-only `memory/YYYY-MM-DD.md` files | Categorized entries: observation, learning, decision, event, error, user |
| 13 | **Curated long-term memory** | ✅ | `MEMORY.md` — Distilled knowledge from daily notes | Agent maintains this actively during heartbeats |
| 14 | **Memory search** | ✅ | `memorySearch.ts` — Keyword-based search across all memory sources | No embeddings/SQLite — zero external dependencies |
| 15 | **Session transcripts** | ✅ | `sessionTranscript.ts` — JSONL conversation recording | Enables replay, audit, memory distillation |
| 16 | **Cross-session continuity** | ✅ | Daily notes + MEMORY.md + transcripts survive restarts | Files persist across VS Code sessions |

---

## Identity & Self-Evolution

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 17 | **Bootstrap workspace** | ✅ | `bootstrap.ts` — Creates `.vscode/johann/` on first run | Template files: SOUL, IDENTITY, USER, AGENTS, TOOLS, MEMORY, HEARTBEAT |
| 18 | **Self-evolving identity** | ✅ | SOUL.md, IDENTITY.md — Agent updates its own personality | System prompt: "These files are YOURS to evolve" |
| 19 | **User profiling** | ✅ | USER.md — Agent learns and records user preferences | Updated as interactions reveal preferences, timezone, etc. |
| 20 | **Operating manual** | ✅ | AGENTS.md — Master instructions, safety rules, protocols | Defines memory protocol, subagent behavior, communication style |
| 21 | **First-run onboarding** | ✅ | BOOTSTRAP.md + `onboardingEnabled` config | Guides through setup, then self-deletes |

---

## System Prompt Architecture

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 22 | **Multi-section system prompt** | ✅ | `systemPrompt.ts` — 9-section structured prompt | Identity, Safety, Tool style, Memory, Skills, Self-awareness, Workspace, Bootstrap, Runtime |
| 23 | **Prompt modes** | ✅ | `full` / `minimal` / `none` — Different prompts for different contexts | Full for main agent, minimal for subagents, none for bare invocations |
| 24 | **Runtime metadata line** | ✅ | Agent ID, hostname, OS, model, mode, timestamp | Runtime context for debugging and situational awareness |
| 25 | **Bootstrap file injection** | ✅ | Persona files injected under "Project Context" section | Capped at `maxBootstrapChars` to prevent context overflow |
| 26 | **Subagent context reduction** | ✅ | Subagents only get AGENTS.md + TOOLS.md | Reduced context for ephemeral workers |

---

## Skills System

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 27 | **Discoverable skills** | ✅ | `skills.ts` — Skill directories under `.vscode/johann/skills/` | Each skill has SKILL.md with description + instructions |
| 28 | **Skill injection in prompt** | ✅ | Skill descriptions listed in system prompt | LLM checks skills before answering; follows matching skill's instructions |
| 29 | **Skill creation API** | ✅ | `createSkill()` — Programmatic skill directory creation | Templates SKILL.md with description and instruction placeholders |

---

## Monitoring & Maintenance

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 30 | **Heartbeat system** | ✅ | `heartbeat.ts` — Periodic timer with configurable interval | Reads HEARTBEAT.md checklist, executes lightweight file checks |
| 31 | **Auto-distill** | ✅ | Config: `johann.autoDistill` — Daily notes → MEMORY.md | Heartbeat triggers review and distillation |
| 32 | **Subagent registry** | ✅ | `subagentRegistry.ts` — Persistent JSON tracking | Records spawn, status, timing, model, escalation history |
| 33 | **Announce flow** | ✅ | `announceFlow.ts` — Structured completion notifications | Builds formatted reports for main agent context injection |
| 34 | **Structured logging** | ✅ | `logger.ts` — VS Code OutputChannel with levels | debug/info/warn/error with timestamps and structured context |

---

## Directives

| # | OpenClaw Feature | Status | Johann Implementation | Notes |
|---|-----------------|--------|----------------------|-------|
| 35 | **Slash command system** | ✅ | `directives.ts` — `/` prefixed command parsing | help, status, compact, memory, search, config, notes, sessions, yolo |
| 36 | **Status reporting** | ✅ | `/status` — Memory count, sessions, heartbeat, config | Both full and compact modes |
| 37 | **YOLO mode toggle** | ✅ | `/yolo on|off` — Toggle maximum autonomy | Updates yoloMode, autoApproveCommands, maxAutoApprovedCommands |

---

## Input Processing (Ramble-Specific)

| # | Feature | Status | Implementation | Notes |
|---|---------|--------|----------------|-------|
| 38 | **Talk-to-text awareness** | ✅ | Analysis prompt detects and corrects STT transcription errors | Cross-references workspace context to resolve mangled terms |
| 39 | **Large input chunking** | ✅ | `extension.ts` — Automatically chunks inputs >8K chars | Each chunk analyzed independently, results merged with deduplication |
| 40 | **Progressive context building** | ✅ | Multi-pass analysis for large inputs | Prevents single-pass information loss |
| 41 | **Input size limits** | ✅ | `maxInputSize` (100K chars) with truncation warning | Configurable via `johann.maxInputSize` |
| 42 | **Streaming responses** | ✅ | All LLM responses stream chunks live to chat | Prevents apparent freezes during long operations |

---

## Autonomy & Safety

| # | Feature | Status | Implementation | Notes |
|---|---------|--------|----------------|-------|
| 43 | **YOLO mode** | ✅ | Config: `johann.yoloMode` — Master autonomy switch | Auto-approves commands, increases limits |
| 44 | **Auto-approve commands** | ✅ | Config: `johann.autoApproveCommands` | Independent toggle for command approval |
| 45 | **Command limits** | ✅ | Config: `johann.maxAutoApprovedCommands` | Prevents runaway execution |
| 46 | **Safety rules** | ✅ | System prompt Safety section + AGENTS.md | Human oversight, no goal-seeking, no manipulation, protect secrets |
| 47 | **Transparent limitations** | ✅ | System prompt: "If you don't know, say so" | No fabrication policy |

---

## Planned / Future Features

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| 48 | **Parallel subtask execution** | 📋 | Actually execute independent subtasks concurrently via Promise.all |
| 49 | **Embedding-based memory search** | 📋 | Vector similarity search for more precise memory recall |
| 50 | **Inter-agent message bus** | 📋 | Real-time communication between concurrent subagents |
| 51 | **Plugin skill marketplace** | 📋 | Shareable skill packs that can be installed from a registry |
| 52 | **Hooks system (WordPress-style)** | 📋 | Action hooks (execute code at lifecycle points) and filter hooks (transform values) |
| 53 | **Visual orchestration dashboard** | 📋 | Webview panel showing subtask graph, status, and timing in real-time |
| 54 | **Cost tracking** | 📋 | Token usage estimation per subtask and session-level cost reporting |
| 55 | **Checkpoint/resume** | 📋 | Save orchestration state to disk and resume after VS Code restart |
