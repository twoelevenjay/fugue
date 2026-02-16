# Fugue for GitHub Copilot

> Stop crafting perfect prompts. Just describe what you need — Fugue turns your stream-of-consciousness into structured, effective prompts for GitHub Copilot Chat.

---

## Product Overview

**Fugue** is a VS Code extension that extends GitHub Copilot with two chat participants: `@ramble` and `@johann`. Together they create a structured AI workflow layer over Copilot — separating prompt formation from task execution.

### @ramble — Prompt Compiler

`@ramble` converts rough or incomplete user prompts into well-formed, high-context execution prompts. It:

- **Analyzes** the original request to extract intent, constraints, and structure
- **Inspects the local codebase** to infer architectural and domain context (reads `.github/copilot-instructions.md`, `CLAUDE.md`, `README.md` files, and workspace structure)
- **Uses LLM reasoning** to identify missing assumptions, ambiguity, and gaps
- **Asks clarifying questions** until sufficient precision is reached (up to 3 rounds)
- **Outputs a finalized, structured prompt** ready for execution — in three forms:
  - **Rendered Markdown** for visual review
  - **Raw copyable Markdown** in a code block
  - **A one-click option** to forward directly to `@johann` for orchestrated execution

`@ramble` does not execute changes. It designs the execution context.

### @johann — Orchestration Agent

`@johann` is a higher-order orchestration layer built on top of GitHub Copilot's Language Model API. It embeds structured pre-prompts, execution constraints, and task decomposition logic — inspired by the architectural patterns of [OpenClaw](https://github.com/OpenClaw). Key capabilities:

- **Large task decomposition** — breaks complex requests into subtasks with dependencies
- **Multi-step execution planning** — creates orchestration plans with ordered phases
- **Structured reasoning flows** — plan → execute → review → merge lifecycle
- **Multi-model routing** — selects the best available model per subtask via a 5-tier system, with automatic escalation on failure
- **Prompt-level subtask isolation** — each subagent receives its own focused prompt and context
- **Persistent memory** — stores decisions, learnings, and context in `.vscode/johann/` across sessions

Johann makes multiple LLM API calls within a single Copilot chat session to orchestrate work. It does not spawn separate Copilot chat windows or manage external processes.

### System Model

```
@ramble → Prompt formation (analysis, context gathering, clarification, compilation)
   ↓ (one-click forward)
@johann → Execution orchestration (decomposition, model selection, subagent dispatch, review)
```

Together they create a structured AI workflow layer that upgrades GitHub Copilot from a reactive assistant into a planned, multi-step execution system with persistent memory.

---

## Requirements

- **VS Code** 1.108.1 or later
- **GitHub Copilot** extension installed and active

## Quick Start

1. Open GitHub Copilot Chat (`Cmd+Shift+I` / `Ctrl+Shift+I`)
2. Type `@ramble` followed by your request — don't worry about structure, just explain what you need
3. Answer any clarifying questions
4. Copy the compiled prompt and use it with Copilot, or click to forward to `@johann`

### Example

**You type:**
```
@ramble okay so we have this API that's getting slow and I think it's the database 
queries, there's like 5 of them running sequentially when they could probably run 
in parallel, also the caching is broken I think, users are complaining about stale 
data, oh and we need to add rate limiting before we launch next week
```

**Fugue extracts:**
- Goal: Optimize API performance and add rate limiting before launch
- Current issues: Sequential DB queries, broken caching (stale data)
- Constraints: Launch deadline next week
- Success criteria: Parallel queries, working cache, rate limiting implemented

**Fugue asks** (only if needed):
- Which API endpoints are affected?
- What caching solution are you using?

**Fugue outputs:** A structured prompt ready for Copilot.

## @ramble Commands

| Command | Description |
|---------|-----------|
| `@ramble <your request>` | Start a new session |
| `@ramble reset` | Clear session and start fresh |
| `@ramble refresh` | Reload workspace context |
| `Fugue: Copy Last Compiled Prompt` | Copy the last compiled prompt to clipboard |

## @johann Commands

| Command | Description |
|---------|-------------|
| `@johann <task>` | Send a task for orchestrated execution |
| `@johann /help` | Show available directives |
| `@johann /status` | Show Johann's state and statistics |
| `@johann /memory` | Show long-term memory |
| `@johann /search <query>` | Search across all memory |
| `@johann /yolo on\|off` | Show setup guide for Copilot's YOLO mode settings |
| `@johann /config` | Show current configuration |

## Workspace Context

Fugue automatically reads your workspace to understand your project:

- `.github/copilot-instructions.md` — Your project's Copilot instructions
- `CLAUDE.md` — Alternative instructions file
- `README.md` files — Project documentation
- Workspace structure — Folder and file layout

Use `@ramble refresh` to reload context after making changes to these files.

## How @ramble Works

Fugue uses GitHub Copilot's language model to intelligently analyze your request. Unlike rigid templates, it understands context and only asks questions when information is genuinely missing.

**What gets preserved:**
- All distinct facts, examples, and technical details
- Relationships between systems/components
- Analogies and concept explanations

**What gets cleaned up:**
- Filler words (um, uh, you know)
- Duplicate mentions of the same fact
- Scattered fragments get organized together

**Large input handling:** Inputs over 8,000 characters are automatically chunked and analyzed in segments, then merged into a single coherent prompt.

## Documentation

- [Johann Architecture Guide](docs/JOHANN.md) — Full system documentation
- [YOLO Mode Guide](docs/YOLO-MODE.md) — Copilot confirmation/limit settings for uninterrupted orchestration
- [Feature Matrix](docs/OPENCLAW-FEATURES.md) — OpenClaw feature integration status

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

