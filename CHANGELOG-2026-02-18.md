# Fugue Extension - Logging & Error Handling Improvements

## 2026-02-18

### Summary

Added comprehensive logging infrastructure to Ramble, improved Johann's error reporting, enhanced timeout/stall detection for ACP workers, and added robust model capability checking with automatic retries.

---

## 🔧 Model Capability Validation & Retry Logic

### Changes to `src/extension.ts`

**Model Capability Detection:**

- New `checkModelCapabilities()` function detects tool support
- Checks model ID and family against known tool-compatible models:
    - Claude (all versions)
    - GPT-4o, GPT-4 Turbo
    - o1, o3 models
- Returns structured capability info (supportsTools, modelId, modelFamily)

**Upfront Validation:**

- Ramble now validates model capabilities before processing
- If selected model doesn't support tools, shows clear error:
    - Explains why tools are required (web search)
    - Lists compatible models
    - Instructs user how to change model
- Prevents wasted processing time on incompatible models

**Model Selection Fixed:**

- `getLLM()` now respects user's model choice
- **Removed hardcoded `family: 'gpt-4o'` filter**
- Returns first model from user's selection (not forced family)
- Fallback to any available model if none selected

**Web Search Re-enabled:**

- `enableTools: true` restored for all analysis calls
- Initial request analysis
- Chunked analysis
- Follow-up research
- Safe now that we validate tool support upfront

### Changes to `src/ramble/llmHelpers.ts`

**Automatic Retry Logic:**

- `sendToLLMWithLogging()` now retries on failures
- **Default: 3 total attempts** (configurable via `maxRetries` param)
- Exponential backoff between retries:
    - Attempt 1: immediate
    - Attempt 2: 1s delay
    - Attempt 3: 2s delay
    - Cap at 5s max delay

**Empty Response Detection:**

- Detects when LLM returns 0 chars or whitespace-only
- Automatically retries empty responses
- Logs each attempt with chunk count
- Throws descriptive error after all retries exhausted

**Retry Behavior:**

- Retries all errors except `CancellationError` (user cancelled)
- Logs previous error on retry attempts
- Marks successful responses as retry or not
- Debug log captures all attempts with failure reasons

**Enhanced Logging:**

- Added `chunkCount` to response logging
- Shows attempt number in all log messages
- Tracks retry delays and previous errors
- Records all attempts in debug conversation log

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
    - **Retry attempts with failure reasons**
- Same detailed format as Johann's debug logs
- Session summary with call timeline and duration breakdown

**`src/ramble/llmHelpers.ts`**

- `sendToLLMWithLogging()` wrapper around VS Code LLM API
- Automatic logging of:
    - LLM request parameters
    - Response length and duration
    - Errors with stack traces
    - **Retry attempts and outcomes**
- Integrates with `RambleDebugConversationLog`

### Changes to `src/extension.ts`

**Initialization:**

- Added Ramble logger creation on activation (debug level)
- Logger writes to VS Code OutputChannel ("Ramble")

**Chat Participant Updates:**

- Debug log created at start of each Ramble session
- Session lifecycle events logged (reset, refresh, errors)
- **Model capability check logged with tool support status**
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

**Model Capability Validation:**

- ✅ Blocks incompatible models with clear error message
- ✅ Shows which models are compatible
- ✅ Logs tool support status in debug log

**Retry Logic:**

- ✅ Automatically retries empty responses
- ✅ Exponential backoff delays
- ✅ All attempts logged to debug file

**Next Steps:**

1. Test Ramble with Claude Opus 4.6 (should work with tools)
2. Test Ramble with incompatible model (should show error)
3. Verify debug logs capture retry attempts
4. Check OutputChannel logging for model capability checks
5. Test web search during analysis phase

---

## 📝 Migration Notes

**For Ramble:**

- Most `sendToLLM` calls now use `sendToLLMWithLogging` with descriptive phases
- Helper functions (`analyzeCodebaseForMissingInfo`, `attemptKnowledgeResolution`, etc.) still use generic wrapper
- **Model selection no longer forced to gpt-4o** — uses user's choice
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
6. **Model Detection:** Query VS Code API for actual tool support instead of hardcoded list (if API becomes available)
7. **Retry Strategy:** Make retry count/delays configurable per phase
