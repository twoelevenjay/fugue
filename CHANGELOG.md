# Changelog

All notable changes to Fugue for GitHub Copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — ACP Worker Backend (Breaking Architecture Change)
- **ACP execution backend:** Replaced in-process `SubagentManager` (LanguageModelChat API) with `AcpWorkerManager` that spawns persistent Copilot CLI workers via Agent Client Protocol (`copilot --acp --stdio`)
- **`@agentclientprotocol/sdk@^0.14.1`** added as a dependency
- **Worker Activity Panel (`workerActivityPanel.ts`):** Each ACP worker gets a dedicated `LogOutputChannel` in VS Code's Output panel, streaming tool calls, agent messages, and errors in real-time
- **`Johann: Show Worker Activity` command:** QuickPick to browse active/recent workers and open their live logs
- **`Johann: Stop All Workers` command:** Kill all active ACP workers with confirmation dialog
- **`Johann: Setup Copilot CLI` command:** Guided setup with npm install, docs link, custom path, and re-check options
- **Copilot CLI detection (`copilotCliStatus.ts`):** Checks for `copilot` in PATH (or `COPILOT_CLI_PATH` env var) with cached results
- **Activation notification:** Non-blocking warning when Copilot CLI is not installed, with one-click setup
- **Execution-time error:** Actionable error notification when a task fails due to missing CLI
- **Startup orphan cleanup:** On activation, detects and kills orphaned `copilot --acp --stdio` processes from previous VS Code crashes (cross-platform: `pgrep` on macOS/Linux, `wmic`/PowerShell on Windows)
- **Shutdown cleanup:** `deactivate()` and disposable both call `AcpWorkerManager.cleanupAllInstances()` with `pkill` fallback
- **Chat log buttons:** Each subtask renders a "📋 View Worker Logs" button in the Copilot chat response
- **Complexity-based timeouts:** trivial=2min, simple=3min, moderate=5min, complex=10min, expert=15min
- **Verification loops:** Baked into worker preprompt — workers typecheck/test/verify their own work before finishing
- **Few-shot planning examples:** Good vs bad subtask descriptions added to task decomposer prompt
- **Prior attempt carry-forward:** When a subtask escalates, the retry receives context showing what the previous model did and why it failed
- **Flow correction from subtask output:** Correction signals parsed from both review notes and worker execution output
- **Mid-execution context compaction:** After 12+ messages, older tool rounds compressed into summaries (keeping 6 recent)
- **46 shipped skills** (up from 10) — upgraded to opinionated workflow procedures with exact commands

### Changed
- `orchestrator.ts` now imports and instantiates `AcpWorkerManager` instead of `SubagentManager` (3 lines changed — all orchestration logic preserved)
- `index.ts` exports `AcpWorkerManager` instead of `SubagentManager`
- Review system unchanged — still uses VS Code LanguageModelChat API (review doesn't need tools)
- CI workflow triggers on all branches (not just `main`)
- Updated README with ACP architecture, Copilot CLI requirement, full command reference, and updated security model
- Updated `docs/JOHANN.md` with ACP worker system documentation (lifecycle, activity panel, process cleanup, CLI setup)

### Removed
- `SubagentManager` is no longer imported (file preserved on disk for reference)
- In-process agentic tool-calling loop (ACP workers handle this natively)
- Tool schema sanitization/normalization
- Rate limit guard integration in worker manager (workers manage their own limits)
- Context compaction mid-execution in worker manager (workers manage their own context)
- Hallucination/corruption detection (workers are more stable)
- Long-running command auto-background detection

### Fixed
- `hookRunner` was passed as `undefined` to `executeSubtask` despite being available — now correctly wired
- Dead code cleanup: removed commented-out MultiPassExecutor/ToolVerifier imports
- ESLint config: added `caughtErrorsIgnorePattern: '^_'` to `@typescript-eslint/no-unused-vars`
- Prettier formatting fixed across 5 files
- Shipped skills count assertion updated in tests (10 → 46)

### Added (prior unreleased)
- **Large input chunking:** Fugue automatically detects and chunks large inputs (>8K chars) to prevent information loss when processing big feature lists
- **Copilot confirmation handling:** Johann now detects and surfaces Copilot's rate-limit/request-limit errors, guiding users to adjust `github.copilot.chat.agent.maxRequests` and `autoApprove` settings
- **`/yolo` directive:** Reads and displays current Copilot agent settings, provides guided setup for enabling/disabling YOLO mode (`@johann /yolo on|off`)
- **Pre-orchestration warnings:** Johann checks Copilot's `maxRequests` setting before starting complex orchestrations and warns if limits are too low
- **Copilot-awareness in system prompt:** Johann's system prompt now includes a full section on how Copilot's approval/limit mechanisms work and how to handle them
- **New configuration settings:**
  - `johann.largeInputChunkSize` — Chunk size threshold for large inputs (default: 8000)
  - `johann.maxInputSize` — Maximum input size with truncation warning (default: 100K)
- **Comprehensive documentation:**
  - `docs/JOHANN.md` — Full architecture documentation covering layered orchestration, memory system, model escalation, subagent lifecycle, and all subsystems
  - `docs/YOLO-MODE.md` — Guide to managing Copilot's confirmation/request-limit settings for uninterrupted orchestration
  - `docs/OPENCLAW-FEATURES.md` — Feature integration matrix tracking 55 features from OpenClaw

### Changed
- Improved input size handling with configurable max input size and truncation warnings
- Updated `/help` directive to include YOLO mode documentation
- Rate-limit errors from Copilot are now caught and surfaced with actionable guidance instead of generic error messages

## [0.1.0] - 2026-02-11

### Added
- Initial release of Fugue for GitHub Copilot
- `@ramble` chat participant for analyzing user requests
- Intelligent extraction of goals, constraints, and context
- Clarifying questions for genuinely missing information
- Workspace context awareness (copilot-instructions.md, READMEs)
- Session state management with multi-round Q&A
- `@ramble reset` command to start fresh
- `@ramble refresh` command to reload workspace context
- Copy compiled prompt button and command