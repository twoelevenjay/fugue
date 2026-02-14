# YOLO Mode — Removing Confirmation Friction for Long Orchestrations

> YOLO mode is a **GitHub Copilot setting**, not a Johann setting. Johann reads these settings for awareness but does not own or override them.

---

## The Problem

Johann orchestrates complex tasks by making **many LLM requests** within a single session. A 10-subtask orchestration plan easily generates 20–40+ requests (planning + execution + review + merge + escalation retries). GitHub Copilot has built-in safety limits that can interrupt this workflow:

1. **Command approval** — Before each terminal command or file edit, Copilot shows an "Allow" confirmation
2. **Request limit** — After N LLM requests, Copilot pauses and asks "Would you like to continue?"

When these triggers fire mid-orchestration, Johann appears to freeze — it's actually waiting for you to click through a Copilot confirmation that you may not have noticed.

---

## The Settings

These are **GitHub Copilot settings** in VS Code. Johann does not own them.

| Setting | What It Controls | Default |
|---------|-----------------|---------|
| `github.copilot.chat.agent.autoApprove` | Skips "Allow" confirmation for commands and file edits | `false` |
| `github.copilot.chat.agent.maxRequests` | Max LLM requests per session before Copilot pauses | varies by VS Code version |

> **Note:** These setting names may change across VS Code versions. Check your Settings UI → search "copilot agent" for the current names.

---

## Enabling YOLO Mode

### Quick Setup

Add to `.vscode/settings.json`:

```json
{
  "github.copilot.chat.agent.autoApprove": true,
  "github.copilot.chat.agent.maxRequests": 200
}
```

Or use the Johann directive for guided setup:

```
@johann /yolo on
```

### What Each Setting Does

**`autoApprove: true`** — Copilot will no longer ask "Allow this command?" before each tool call. Commands, file edits, and terminal operations proceed automatically. This is the setting that prevents the most friction during orchestration.

**`maxRequests: 200`** — Copilot will allow up to 200 LLM requests in a single session before pausing. For typical Johann orchestrations:
- Simple task (1–3 subtasks): ~5–15 requests
- Medium task (5–8 subtasks): ~15–40 requests
- Complex task (10+ subtasks): ~30–80+ requests
- Very complex with escalations: 100+ requests

Set this high enough that Johann won't be interrupted mid-orchestration.

> **Infinite mode:** Copilot does not currently support an "unlimited" option. If you find Johann consistently hitting the limit, increase the number. The Ramble extension may add a workaround for this in a future release.

### Also Consider Raising Johann's Limits

These ARE Johann's own settings and can complement the Copilot settings:

```json
{
  "johann.maxSubtasks": 20,
  "johann.maxAttempts": 5
}
```

---

## Disabling YOLO Mode

```json
{
  "github.copilot.chat.agent.autoApprove": false,
  "github.copilot.chat.agent.maxRequests": 30
}
```

Or type `@johann /yolo off` for guidance.

---

## How Johann Handles Copilot's Limits

Johann is **aware** of Copilot's settings but **cannot override** them. Here's what happens at each boundary:

### When `autoApprove` is `false`

Copilot shows an "Allow" prompt before each tool invocation. During orchestration, these appear in the Copilot Chat UI. You need to click "Allow" (or "Always Allow") for the orchestration to proceed.

**Tip:** If you see Johann appear to freeze, look for an "Allow" button in the chat panel.

### When `maxRequests` is reached

Copilot pauses the session and asks "Would you like to continue?" Johann detects this as an error in its LLM calls and will:

1. Show you a clear message explaining what happened
2. Tell you the current `maxRequests` value
3. Suggest increasing it
4. Ask you to re-run the request

### Rate Limits from the Model Provider

Separate from Copilot's settings, the underlying model provider (OpenAI, Anthropic, etc.) may have its own rate limits. If Johann hits these:

1. The specific subtask fails
2. Johann escalates to a different model automatically
3. If all models are exhausted, the subtask is marked failed

---

## Checking Current Status

Type in Copilot Chat:

```
@johann /yolo
```

This shows the current Copilot agent settings, whether YOLO mode is effectively active, and guidance for changes.

---

## Safety Considerations

### YOLO Mode Does NOT Bypass

Even with YOLO mode fully enabled:

- Johann still logs all actions to daily notes and session transcripts
- Subagent output is still reviewed against success criteria
- The model's own safety guardrails remain active
- Johann's safety rules (no secret exposure, no fabrication) still apply
- No destructive actions without user acknowledgment in the original request

### When to Use YOLO Mode

**Good:**
- Large multi-step tasks you're actively watching
- Codebase refactoring across many files
- Batch processing (feature lists, boilerplate generation)
- When you trust the workflow and want speed

**Avoid:**
- Working with production systems
- Destructive operations (force-push, deletes)
- Tasks involving secrets or credentials
- When you're stepping away from the keyboard

---

## Troubleshooting

### "Johann froze mid-orchestration"

1. Look for a Copilot confirmation dialog in the chat panel ("Allow" or "Continue?")
2. Click through it to resume
3. Then increase your limits: `@johann /yolo on` for setup guidance

### "Johann says it hit a request limit"

1. Check your current `maxRequests`: `@johann /yolo`
2. Increase it in settings or `.vscode/settings.json`
3. Re-run your request

### "Subtask keeps failing and retrying"

This uses up LLM requests quickly. Consider:
1. Reducing `johann.maxAttempts` to limit retries
2. Checking model availability: `@johann /status`
3. Increasing `maxRequests` to accommodate the retries
