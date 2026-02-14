# Changelog

All notable changes to Ramble for GitHub Copilot will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Large input chunking:** Ramble automatically detects and chunks large inputs (>8K chars) to prevent information loss when processing big feature lists
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
- Initial release of Ramble for GitHub Copilot
- `@ramble` chat participant for analyzing rambling requests
- Intelligent extraction of goals, constraints, and context
- Clarifying questions for genuinely missing information
- Workspace context awareness (copilot-instructions.md, READMEs)
- Session state management with multi-round Q&A
- `@ramble reset` command to start fresh
- `@ramble refresh` command to reload workspace context
- Copy compiled prompt button and command