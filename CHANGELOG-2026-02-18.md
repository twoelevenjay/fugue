# Fugue Extension - Logging & Error Handling Improvements

## 2026-02-18

### Summary

Added comprehensive logging infrastructure to Ramble, improved Johann's error reporting, and enhanced timeout/stall detection for ACP workers.

---

## 🎵 Ramble Logging System

### New Files Created

**`src/ramble/logger.ts`**

- Central logger writing to "Ramble" OutputChannel
- Supports debug, info, warn, error levels
- Structured context logging with JSON metadata
- Singleton pattern for global access

**`src/ramble/debugConversationLog.ts`**

- Full LLM conversation capture to `.vscode/ramble/debug/<date>_<time>_<sessionId>.md`
- Logs complete request/response transcripts with:
    - Timestamps
    - Phase labels (analysis, question-generation, merge, compilation, etc.)
    - Model used
    - Full prompts sent
    - Full responses received
    - Duration metrics
    - Error details
- Same detailed format as Johann's debug logs
- Session summary with call timeline and duration breakdown

**`src/ramble/llmHelpers.ts`**

- `sendToLLMWithLogging()` wrapper around VS Code LLM API
- Automatic logging of:
    - LLM request parameters
    - Response length and duration
    - Errors with stack traces
- Integrates with `RambleDebugConversationLog`

### Changes to `src/extension.ts`

**Initialization:**

- Added Ramble logger creation on activation (debug level)
- Logger writes to VS Code OutputChannel ("Ramble")

**Chat Participant Updates:**

- Debug log created at start of each Ramble session
- Session lifecycle events logged (reset, refresh, errors)
- All LLM calls now use `sendToLLMWithLogging` with descriptive phase/label:
    - `codebase-analysis` — Analyzing workspace files for missing info
    - `web-research` — Knowledge resolution from training data
    - `merge` — Merging resolved answers or chunk results
    - `analysis` — Initial request analysis or chunk analysis
    - `compilation` — Final prompt compilation
- Finalization on completion/failure with outcome tracking

**Backward Compatibility:**

- `sendToLLM()` now delegates to `sendToLLMWithLogging` with generic phase
- All existing calls still work
- Individual calls migrated to use specific phase/label where appropriate

---

## 🎭 Johann Error Handling Improvements

### Error Classification (`src/johann/retry.ts`)

**Added Stream Error Detection:**

- New patterns added to `NETWORK_PATTERNS`:
    - `'response stream'`
    - `'stream has been closed'`
    - `'stream closed'`
- Catches VS Code API stream timeout errors
- Classifies as retryable network errors with helpful user guidance

### Error Rendering (`src/johann/orchestrator.ts`)

**Enhanced `renderErrorForUser()`:**

**Subtask Status Summary:**

- Shows detailed breakdown of all subtasks by status:
    - ✅ Completed (with IDs)
    - ❌ Failed (with IDs and review notes excerpt)
    - ⬆️ Escalated (with IDs)
    - ⏸️ Interrupted (with IDs)
    - ⏳ Not started (with IDs)
- Rendered as a structured table in error output

**Network Error Guidance:**

- Specific advice for "Response stream has been closed" errors
- Suggests higher complexity model or breaking task into smaller pieces
- Retains existing guidance for general network issues

**All Error Categories:**

- Subtask status summary now shown for all error types:
    - Network errors
    - Rate limit errors
    - Cancellation
    - Auth errors
    - Unknown errors

---

## ⚙️ ACP Worker Timeout & Stall Detection

### Changes to `src/johann/acpWorkerManager.ts`

**Stall Detection:**

- Added `STALL_THRESHOLD_MS = 180_000` (3 minutes)
- Health check now actively detects stalls:
    - Warns at 60s of inactivity
    - Kills worker and rejects promise at 180s of inactivity
    - Logs detailed stall information:
        - Duration of inactivity
        - Threshold exceeded
        - Last activity timestamp
- Stall error propagates through early exit mechanism

**Existing Timeouts (unchanged):**

- Complexity-based timeout limits remain:
    - Trivial: 2 min
    - Simple: 3 min
    - Moderate: 5 min
    - Complex: 10 min
    - Expert: 15 min

**Combined Protection:**

- Workers now have TWO failure modes:
    - Total timeout (max time for entire task)
    - Stall timeout (max time without activity)

---

## 📊 Logging Output Locations

### Ramble

- **OutputChannel:** View → Output → Select "Ramble"
- **Debug logs:** `.vscode/ramble/debug/YYYY-MM-DD_HH-MM-SS_ramble-<timestamp>-<id>.md`

### Johann (existing)

- **OutputChannel:** View → Output → Select "Johann"
- **Debug logs:** `.vscode/johann/debug/YYYY-MM-DD_HH-MM-SS_johann-<timestamp>-<id>.md`

---

## 🧪 Testing Notes

**Compilation:**

- ✅ All TypeScript compilation passes
- ✅ No errors or warnings

**Next Steps:**

1. Test Ramble with a real prompt compilation session
2. Verify debug logs are created in `.vscode/ramble/debug/`
3. Trigger an error scenario to verify improved error messages
4. Check OutputChannel logging for both Ramble and Johann
5. Test ACP worker stall detection with a long-running task

---

## 📝 Migration Notes

**For Ramble:**

- Most `sendToLLM` calls now use `sendToLLMWithLogging` with descriptive phases
- Helper functions (`analyzeCodebaseForMissingInfo`, `attemptKnowledgeResolution`, etc.) still use generic wrapper
- Future improvement: Thread `debugLog` through helper functions for fuller coverage

**For Johann:**

- Error messages now include actionable subtask status breakdown
- Stream errors are better classified and have specific guidance
- ACP workers will now fail faster when truly stalled (3 min vs previous indefinite hang)

---

## 🔍 Improvements to Consider (Future)

1. **Ramble:** Thread `debugLog` through all helper functions for complete LLM call coverage
2. **Johann:** Add stall detection to older LanguageModelChat-based code paths (if any remain)
3. **Both:** Unified logging dashboard showing parallel Ramble/Johann activities
4. **Performance:** Log rotation for large debug files
5. **Observability:** Export logs in structured format (JSON lines) for analysis tools
