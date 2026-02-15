# Progress Reporter — Developer Guide

Johann's orchestration progress is rendered in VS Code Chat using a structured event model and
the `ChatProgressReporter`. This replaces inline `response.markdown()` calls with structured
events that map to native Chat Participant API parts (progress spinners, markdown, buttons,
file trees).

## Architecture

```
Orchestrator / SubagentManager
        │
        │  emit(ProgressEvent)
        ▼
  ChatProgressReporter
        │
        │  maps events to Chat API parts
        ▼
  vscode.ChatResponseStream
        │  .progress()   → transient spinner
        │  .markdown()   → permanent text
        │  .button()     → command buttons
        │  .filetree()   → file tree widget
        ▼
  VS Code Chat UI
```

## Event Types

All events are defined in `src/johann/progressEvents.ts`.

| Event                | When to emit                           | Chat rendering                          |
|----------------------|----------------------------------------|-----------------------------------------|
| `TaskStartedEvent`   | A subtask begins execution             | Transient progress spinner              |
| `TaskProgressEvent`  | Status update while running            | Updates the progress spinner text       |
| `TaskCompletedEvent` | A subtask finishes successfully        | `✅ **label** → model — Xs`            |
| `TaskFailedEvent`    | A subtask fails definitively           | `❌ **label** — error message`          |
| `FileSetDiscoveredEvent` | A set of files is relevant         | Native file tree or grouped markdown    |
| `NoteEvent`          | Informational/warning/success message  | Quoted markdown block (`> message`)     |

## Emitting Events

From the orchestrator or any component with access to the reporter:

```typescript
import { ChatProgressReporter } from './chatProgressReporter';

// Create from a ChatResponseStream
const reporter = new ChatProgressReporter(response);

// Subtask lifecycle
reporter.emit({ type: 'task-started', id: 'task-1', label: 'Build components',
    metadata: { model: 'gpt-4o', tier: '4' } });
reporter.emit({ type: 'task-progress', id: 'task-1', message: 'Creating files…' });
reporter.emit({ type: 'task-completed', id: 'task-1', durationMs: 3200 });
// or
reporter.emit({ type: 'task-failed', id: 'task-1', error: 'Timeout' });

// File sets
reporter.emit({ type: 'fileset-discovered', label: 'Changed files',
    files: ['src/a.ts', 'src/b.ts', 'lib/c.ts'] });

// Notes
reporter.emit({ type: 'note', message: 'Running 3 subtasks in parallel' });
reporter.emit({ type: 'note', message: 'Merge conflict detected', style: 'warning' });
reporter.emit({ type: 'note', message: 'All tests passing', style: 'success' });
```

## Convenience Methods

Beyond `emit()`, the reporter provides higher-level methods:

```typescript
reporter.section('Planning');           // Renders: ### Planning
reporter.showPlan(plan);                // Compact plan table with subtask list
reporter.showModels(modelSummary);      // Expandable model list
reporter.showButtons();                 // Action buttons at end of response
```

## Accessing the Raw Stream

For components that need to stream LLM output directly (e.g., `SubagentManager`'s
`<details>` blocks), use `reporter.stream`:

```typescript
// SubagentManager receives the raw stream for LLM output streaming
await subagentManager.executeSubtask(subtask, model, deps, ctx, token,
    reporter.stream,   // ← raw ChatResponseStream
    debugLog);
```

## Action Buttons

Three buttons are rendered at the end of each orchestration:

| Button                 | Command                  | Behavior                        |
|------------------------|--------------------------|---------------------------------|
| Show Changed Files     | `workbench.view.scm`     | Opens VS Code Source Control    |
| Open Output Log        | `johann.showLog`         | Reveals the OutputChannel       |
| Open Debug Log         | `johann.showDebugLog`    | Opens the session's debug log   |

## How the UI Maps Events to Chat Parts

| Chat API Part          | Used for                                    |
|------------------------|---------------------------------------------|
| `stream.progress()`   | Transient "working on…" spinners            |
| `stream.markdown()`   | Permanent checklist lines, notes, plan table|
| `stream.button()`     | Action buttons (SCM, logs)                  |
| `stream.filetree()`   | File set display (conflict files, changes)  |

The result is a Copilot-like experience: a progress spinner while working, a growing
checklist of completed/failed tasks, expandable detail sections, and action buttons —
without flooding the user with raw log lines.

## Existing Logs (Unchanged)

The reporter does **not** replace these existing logging mechanisms. They remain
available for debugging:

- **OutputChannel** (`JohannLogger`) — `johann.showLog` command
- **Debug conversation logs** — `.vscode/johann/debug/` — full LLM request/response capture
- **Session transcripts** — `.vscode/johann/sessions/` — JSONL conversation records
- **Memory entries** — `.vscode/johann/` — persistent learnings and task records
