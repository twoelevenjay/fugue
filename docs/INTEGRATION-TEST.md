# Johann Integration Test Prompt

## Quick Validation (5 minutes)

Use this prompt with `@johann` to validate the full orchestration pipeline.

### The Prompt

```
Build a simple Express.js API with:
1. A /healthcheck endpoint
2. A /users endpoint with GET (list) and POST (create)
3. A basic SQLite database using better-sqlite3
4. Input validation middleware
5. Error handling middleware
6. Unit tests for each endpoint
7. A README.md documenting the API

Structure the project properly with separate files for routes, middleware, database, and tests.
```

## What This Tests

| Feature | How This Prompt Validates It |
|---------|------------------------------|
| **DAG Wave Engine** | DB + middleware in wave 0, routes in wave 1, tests in wave 2 |
| **Context Distillation** | Routes need DB schema from upstream; tests need route paths |
| **Skill Inference** | Database skill, API skill, testing skill should auto-match |
| **Hive Mind** | Parallel tasks (DB + middleware) share `package.json` awareness |
| **Message Bus** | Agents might broadcast file creation signals to prevent conflicts |
| **Hooks** | `before_planning`, `after_planning`, `before_subtask`, `after_subtask` fires |
| **Session Persistence** | Plan saved to disk; can resume if interrupted |
| **Memory** | Task completion recorded with structured summaries |

## Verification Checklist

After the prompt completes, verify:

- [ ] **Plan structure** — Has proper DAG (not flat serial). Check the plan display shows dependency arrows.
- [ ] **Wave execution** — Console/debug log shows `DAG: N waves` with max parallelism > 1.
- [ ] **Context distillation** — Downstream tasks reference upstream outputs (e.g., routes know about `db.ts` schema).
- [ ] **Skill inference** — Debug log shows skills matched to subtasks (database, api, testing).
- [ ] **Hive mind refresh** — Output shows "🐝 Hive mind refresh" messages during multi-round subtasks.
- [ ] **Message signals** — `<!--HIVE_SIGNAL:...-->` patterns parsed from model output (check debug log).
- [ ] **Hooks firing** — Debug log or logger output shows hook execution at lifecycle points.
- [ ] **Persistence** — `.vscode/johann/sessions/<id>/` directory exists with `session.json`, `plan.json`, subtask results.
- [ ] **Memory recording** — `.vscode/johann/memory/` has new entries after completion.
- [ ] **No duplicate files** — The created project has a clean structure without duplicated directories.
- [ ] **Working output** — API files exist, tests are present, README is generated.

## Expected Plan Structure

```
Wave 0: [Database setup, Middleware setup]  (parallel)
Wave 1: [Route implementation]              (depends on DB + middleware)
Wave 2: [Unit tests, README]                (depends on routes; parallel with each other)
```

## Debug Log Location

After running the prompt, find the debug log at:
```
.vscode/johann/sessions/<sessionId>/debug-conversation.md
```

This log shows every LLM call, tool invocation, hook execution, and hive mind interaction.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Plan is flat serial | TaskDecomposer not inferring dependencies | Check `taskDecomposer.ts` planning prompt |
| No wave parallelism | `allowParallelExecution` config off | Check `config.ts` defaults |
| Context distillation missing | Model didn't emit `summary` block | Check `SUMMARY_BLOCK_INSTRUCTION` in prompt |
| Hive mind not refreshing | Ledger not initialized | Check ledger init in `orchestrator.ts` |
| Hooks not firing | HookRunner not passed through call chain | Check `executePlan` → `executeSubtaskWithEscalation` |
| Tests fail to run | `vscode-test` not picking up test files | Check `.vscode-test.mjs` glob pattern |
