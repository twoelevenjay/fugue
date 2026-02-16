# Johann UX: Status Snapshots & Interactive Running

## Overview

Johann now provides a native-feeling VS Code Chat UX with:
- **Live status snapshots** with Mermaid workflow diagrams
- **Interactive while running** — check status or queue work without stopping
- **Delegation panels** showing subagent status in a compact, collapsible format
- **Add-task-while-running** queue with safe checkpoint integration
- **Stop/cancel** support via VS Code's native cancellation token

## Status Snapshots

### `/status`

During an active run, shows a rich snapshot including:
- Run ID, elapsed time, overall status
- Task counters (queued / running / done / failed)
- Active items list (currently running tasks + next up)
- Compact Mermaid workflow diagram (phase-level)
- Text fallback table
- Pending user queue messages
- Action hints

### `/status detailed`

Same as `/status` but adds a **detailed task-level Mermaid diagram** showing each individual task as a node (capped at 30 nodes for readability).

### While idle

When no run is active, `/status` shows Johann's general status: memory directory, daily notes count, session history, and configuration.

## Interactive While Running

During an active orchestration, you can talk to `@johann` without interrupting the run:

### Check status
```
@johann status
```
Returns a live snapshot. Equivalent to `/status` but can be used mid-sentence.

### Queue a new task
```
@johann Add task: Also write integration tests
@johann Add: Fix the CSS issues too
@johann Also update the README
```
The message is queued and will be integrated at the next safe checkpoint (wave boundary in the DAG execution).

### Any other message
Any message sent while running is automatically queued:
```
@johann Can you also check the TypeScript errors?
```
Returns a confirmation with queue position and a hint to check status.

## Delegation Panel

After each execution wave, a compact delegation summary is rendered as a collapsible `<details>` block:

```
🤖 **Delegation** — 2 running · 3 done · 1 failed (6 total)
  - ✅ Build models — Completed
  - ✅ Write API routes — Completed  
  - 🔄 Implement auth — Running
  - ❌ Deploy — Failed: timeout
```

This panel gives a bird's-eye view without cluttering the chat with per-task details.

## Stop / Cancel

Pressing VS Code's **Stop** button (or the cancel button in the chat input):
1. Sets the CancellationToken, which propagates to all active LLM calls
2. RunState transitions to `cancelling` status
3. Active subtasks are interrupted
4. RunState transitions to `failed` status
5. Session is persisted — can be resumed later with `/resume`

## Architecture

### RunState Model

The canonical UI model is `RunStateData` in [src/johann/runState.ts](../src/johann/runState.ts). It provides:

| Component | Purpose |
|-----------|---------|
| `RunStateManager` | Singleton managing the active run state |
| `RunStateData` | The full state object (tasks, subagents, counters, queue) |
| `RunTask` | Per-task status with timestamps, model, phase, artifacts |
| `RunSubagent` | Per-subagent status with summary and result |
| `QueuedUserMessage` | User messages enqueued during a run |
| `onStateChange` event | Reactive notifications for UI updates |

### Status Snapshot Generator

[src/johann/statusSnapshot.ts](../src/johann/statusSnapshot.ts) generates `StatusSnapshot` objects from `RunStateData`:

- `generateSnapshot(state)` → compact phase-level Mermaid + text table
- `generateDetailedSnapshot(state)` → adds task-level Mermaid diagram

Phase assignment uses keyword heuristics on task titles:
- `scan`, `discover`, `analyze` → Discovery
- `plan`, `design`, `architect` → Planning  
- `delegate`, `assign`, `dispatch` → Delegation
- `test`, `verify`, `validate`, `check` → Verification
- `package`, `deploy`, `publish`, `report` → Packaging
- Everything else → Implementation

### Integration Points

| File | What was added |
|------|---------------|
| `orchestrator.ts` | `startRun()` at entry, task status updates, delegation panels, queue drain at wave boundaries, `completeRun()`/`failRun()` at exit |
| `participant.ts` | "status" keyword detection, "add task" queueing, fallback message queueing while running |
| `chatProgressReporter.ts` | `DelegationPanelEvent` handler rendering collapsible delegation summary |
| `backgroundProgressReporter.ts` | `DelegationPanelEvent` handler collecting delegation notes |
| `progressEvents.ts` | New `DelegationPanelEvent` type |
| `directives.ts` | Enhanced `/status` with live RunState snapshots |
| `index.ts` | New module exports |

### Data Flow

```
User message → participant.ts
  ├─ If running → enqueue or show status
  └─ If idle → orchestrator.orchestrate()
       ├─ RunStateManager.startRun()
       ├─ Planning → setPlanSummary() + registerTasks()
       ├─ Execution waves:
       │   ├─ Wave boundary → drain user queue
       │   ├─ Per subtask → updateTask(running/done/failed)
       │   └─ Wave end → emitDelegationPanel()
       └─ Complete → completeRun() | failRun()
```

## Limitations

1. **Single active run** — Only one orchestration can run at a time. The RunStateManager is a singleton.
2. **Queue integration is deferred** — Queued user messages are acknowledged but not yet dynamically integrated into the running plan. They're marked as integrated at wave boundaries.
3. **No streaming snapshots** — Snapshots are point-in-time captures triggered by `/status` or `@johann status`. They do not auto-refresh.
4. **Mermaid diagram cap** — Detailed task-level diagrams are limited to 30 nodes. Larger plans get only the compact phase-level diagram.
5. **Phase inference is heuristic** — Phase assignment from task titles uses keyword matching and may not always be accurate.
