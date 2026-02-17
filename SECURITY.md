# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Fugue, **please do not open a public issue.**

Instead, report it privately:

1. **Email:** [leon@211j.com](mailto:leon@211j.com)
2. **Subject line:** `[SECURITY] Fugue — <brief description>`
3. **Include:**
    - Description of the vulnerability
    - Steps to reproduce
    - Impact assessment (what an attacker could do)
    - Affected version(s)

You will receive an acknowledgment within **48 hours** and a resolution timeline within **7 days**.

## Security Model

Fugue is a VS Code extension that runs inside the Extension Host process. It operates under the VS Code extension security sandbox with these constraints:

### What Fugue CAN do

| Capability                                                     | Justification                                                                   | Files                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Read/write files via `vscode.workspace.fs`                     | Persistent memory, session state, ledger, skill files                           | `memory.ts`, `safeIO.ts`, `executionLedger.ts`, `skillStore.ts` |
| Call GitHub Copilot LLM via `vscode.lm`                        | Core functionality — prompt compilation, task decomposition, subagent execution | `orchestrator.ts`, `subagentManager.ts`, `extension.ts`         |
| Execute `git` commands via `child_process.execFile`            | Git worktree creation/cleanup for parallel subtask isolation                    | `worktreeManager.ts`                                            |
| Verify external tool availability via `child_process.execFile` | Pre-flight check: `which <tool>` (no shell)                                     | `toolVerifier.ts`                                               |

### What Fugue CANNOT do

| Excluded Capability                           | Enforcement                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Network requests (HTTP, fetch, WebSocket)     | ESLint `no-restricted-imports` blocks `http`, `https`, `axios`, `node-fetch`. No network calls exist in codebase. |
| Dynamic code execution (`eval`, `Function()`) | ESLint `no-eval`, `no-implied-eval`, `no-new-func` rules.                                                         |
| Shell command execution                       | `execFile` used instead of `exec`/`spawn(shell:true)`. Only `git` and `which` are invoked.                        |
| Environment variable reading                  | No `process.env` access for secrets.                                                                              |
| Telemetry or data exfiltration                | No outbound network capability.                                                                                   |
| Arbitrary file deletion                       | `assertSafePath()` validates all `fs.rm()` targets against `$TMPDIR/johann-worktrees/` prefix.                    |

### Workspace Trust

Fugue checks `vscode.workspace.isTrusted` before starting any orchestration. In Restricted Mode, the extension will refuse to operate and display a message explaining why.

### Subagent Safety

Johann's subagent execution loop includes:

- **Tool blocklist** — Subagents cannot use destructive tools (e.g., `deleteFile`, `renameFile`)
- **Round limit** — Maximum 30 tool-calling rounds per subagent to prevent runaway execution
- **Context isolation** — Subagents receive workspace structure only, never Johann's system prompt or memory
- **Skill validation** — User-provided skills are validated against an injection blocklist before inclusion in prompts

### Supply Chain

- **Zero runtime dependencies** — Fugue ships no `node_modules` in its VSIX
- **Dev dependencies only** — TypeScript, ESLint, Prettier, test tooling
- **Automated scanning** — CodeQL (weekly + on PR), `npm audit` in CI, dependency review on PR

## Dependency Policy

- Runtime dependencies: **not permitted** without security review
- Dev dependencies: must be well-known, actively maintained, and MIT/Apache-2.0 licensed
- Transitive vulnerabilities: tracked in CI via `npm audit --omit=dev`
- License restrictions: GPL-3.0 and AGPL-3.0 dependencies are blocked by the dependency review workflow

## Disclosure Timeline

| Step              | Target                     |
| ----------------- | -------------------------- |
| Acknowledgment    | 48 hours                   |
| Assessment        | 7 days                     |
| Fix release       | 30 days (critical: 7 days) |
| Public disclosure | After fix is published     |
