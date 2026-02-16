# Memory — Curated Knowledge Base

> This is your long-term memory. Only the most important, distilled knowledge goes here.
> Raw observations go in `memory/YYYY-MM-DD.md` daily notes.
> Periodically review daily notes and update this file.

## Project Knowledge
- **Tech Stack:** TypeScript, VS Code Extension API, GitHub Copilot Chat API.
- **Project Goal:** Multi-agent AI workflow layer. Orchestrates independent subagents to solve complex coding tasks.
- **Entry Points:** package.json main: out/extension.js (compiled from src/extension.ts). activationEvents: onChatParticipant:ramble, onChatParticipant:johann.
- **Build System:** npm scripts (compile, watch, test, lint).
- **Key Modules:** orchestrator.ts (main execution loop), subagentManager.ts (ephemeral agents), executionLedger.ts (persistent task tracking), modelPicker.ts (LLM selection), memory.ts (persistent memory), config.ts (settings).
- Recent features: Hivemind, git worktree isolation for parallel tasks.

## User Preferences
- (nothing recorded yet)

## Decisions & Rationale
- (nothing recorded yet)

## Patterns & Learnings
- MEMORY.md corruption on 2026-02-16 was caused by concurrent non-atomic writes from multiple code paths using fs.writeFileSync/appendFileSync without locking or deduplication.
- Long self-improvement sessions tend to fail with "Response stream has been closed" after extended run times — need better checkpointing.
- Johann's self-modification attempts should be reviewed before merging — the appended code duplicated existing functionality and introduced the exact write patterns that caused corruption.
