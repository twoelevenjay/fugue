# Contributing to Fugue

Thanks for your interest in contributing to Fugue for GitHub Copilot!

## Prerequisites

- **Node.js** 20 or later (22 recommended)
- **VS Code** 1.108.1 or later with GitHub Copilot installed

## Development Setup

1. **Clone the repository**

    ```bash
    git clone https://github.com/leonshelhamer/fugue.git
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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture guide.

```
fugue/
├── src/
│   ├── extension.ts      # Entry point: @ramble participant
│   ├── johann/            # @johann orchestration agent (~50 modules)
│   └── test/              # Mocha test suite
├── docs/                  # Architecture, feature matrix, guides
├── .github/workflows/     # CI, CodeQL, dependency review
├── package.json           # Extension manifest
├── tsconfig.json          # TypeScript strict config
└── eslint.config.mjs      # ESLint flat config with security rules
```

## Code Quality

Run all checks before committing:

```bash
npm run lint          # ESLint
npm run format:check  # Prettier (check only)
npm run typecheck     # TypeScript --noEmit
npm run compile       # Full compile
npm test              # Mocha tests
```

To auto-fix formatting:

```bash
npm run lint:fix      # ESLint --fix
npm run format        # Prettier --write
```

### Standards

- TypeScript strict mode — no `any` unless unavoidable and justified
- Single quotes, trailing commas, 4-space indent (enforced by Prettier)
- No `eval`, `new Function`, or dynamic `require`
- No network imports (`http`, `https`, `axios`, `node-fetch`)
- No `child_process.exec` or `spawn(shell: true)` — use `execFile` only
- All `fs.rm()` calls must be guarded by `assertSafePath()`

### Security Rules

See [SECURITY.md](SECURITY.md) for the full security model. Key rules for contributors:

- **No runtime dependencies.** Everything ships as a single extension bundle.
- **No shell injection.** Use `execFile`, never `exec` or `spawn(shell: true)`.
- **No network calls.** The extension must work fully offline.
- **Guard destructive ops.** Any `fs.rm()` or `fs.unlink()` must validate the target path.
- **Isolate subagent context.** Never pass Johann's system prompt or memory to subagents.

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** for your feature: `git checkout -b feature/my-feature`
3. **Make your changes** with clear, atomic commits
4. **Run all checks:**
    ```bash
    npm run lint && npm run format:check && npm run typecheck && npm test
    ```
5. **Push** and open a Pull Request

### PR Checklist

- [ ] All CI checks pass (lint, format, typecheck, test, package)
- [ ] No new `any` types without justification
- [ ] No new `child_process` or `fs` usage without security review
- [ ] Documentation updated if behavior changed
- [ ] CHANGELOG.md updated for user-facing changes

### PR Guidelines

- Describe what your PR does and why
- Reference any related issues
- Keep PRs focused — one feature or fix per PR
- Update documentation if needed

## Reporting Security Issues

**Do not open public issues for security vulnerabilities.**

See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## Reporting Bugs

- Check existing issues first to avoid duplicates
- Use the issue templates when available
- Include VS Code and extension version
- Provide steps to reproduce

## Questions?

Open a [Discussion](https://github.com/leonshelhamer/fugue/discussions) for questions or ideas.
