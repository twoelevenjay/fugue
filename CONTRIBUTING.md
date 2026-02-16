# Contributing to Fugue

Thanks for your interest in contributing to Fugue for GitHub Copilot!

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/fugue.git
   cd fugue
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run in development mode**
   - Press `F5` in VS Code to launch the Extension Development Host
   - Or run `npm run watch` to compile on changes

4. **Test the extension**
   - In the Extension Development Host, open Copilot Chat
   - Type `@ramble` followed by a test request

## Project Structure

```
fugue/
├── src/
│   ├── extension.ts          # Main extension: @ramble participant, input analysis, chunking
│   ├── johann/               # Johann orchestration agent
│   │   ├── index.ts          # Public exports
│   │   ├── participant.ts    # @johann chat participant registration
│   │   ├── orchestrator.ts   # Core orchestration: plan → execute → review → merge
│   │   ├── taskDecomposer.ts # LLM-powered task decomposition
│   │   ├── modelPicker.ts    # 5-tier model selection and escalation
│   │   ├── subagentManager.ts# Subagent execution and review
│   │   ├── memory.ts         # Persistent memory system
│   │   ├── memorySearch.ts   # Keyword search across memory
│   │   ├── dailyNotes.ts     # Append-only daily log files
│   │   ├── sessionTranscript.ts # JSONL conversation recording
│   │   ├── subagentRegistry.ts  # Subagent tracking
│   │   ├── announceFlow.ts   # Subagent completion notifications
│   │   ├── bootstrap.ts      # First-run workspace setup
│   │   ├── templates.ts      # Bootstrap file templates (SOUL.md etc.)
│   │   ├── systemPrompt.ts   # Multi-section system prompt assembly
│   │   ├── skills.ts         # Discoverable skill system
│   │   ├── heartbeat.ts      # Periodic self-check timer
│   │   ├── directives.ts     # Slash command handling (/help, /yolo, etc.)
│   │   ├── config.ts         # VS Code settings-based configuration
│   │   ├── logger.ts         # Structured logging
│   │   └── types.ts          # Core type definitions
│   └── test/
│       └── extension.test.ts
├── docs/
│   ├── JOHANN.md             # Architecture documentation
│   ├── YOLO-MODE.md          # YOLO mode guide
│   └── OPENCLAW-FEATURES.md  # Feature integration matrix
├── package.json              # Extension manifest
├── tsconfig.json             # TypeScript config
└── eslint.config.mjs         # Linting rules
```

## Code Style

- Run `npm run lint` before committing
- Use TypeScript strict mode
- Keep functions focused and well-named
- Add comments for non-obvious logic

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** for your feature: `git checkout -b feature/my-feature`
3. **Make your changes** with clear, atomic commits
4. **Run tests**: `npm run pretest`
5. **Push** and open a Pull Request

### PR Guidelines

- Describe what your PR does and why
- Reference any related issues
- Keep PRs focused — one feature or fix per PR
- Update documentation if needed

## Reporting Issues

- Check existing issues first to avoid duplicates
- Use the issue templates when available
- Include VS Code and extension version
- Provide steps to reproduce

## Questions?

Open a [Discussion](https://github.com/YOUR_USERNAME/fugue/discussions) for questions or ideas.
