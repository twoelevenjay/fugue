# Johann Memory Audit Report

Date: 2026-02-16
Workspace: fugue

## Summary
Audit of Johann persistent memory identified corruption risks and lifecycle gaps affecting `.vscode/johann/MEMORY.md` and daily notes under `.vscode/johann/memory/`. Root causes include concurrent non-atomic writes, read-modify-write races, mixed file APIs, and missing deduplication. BOOTSTRAP.md deletion depends on `isFirstRun`, causing sentinel to persist.

## Findings

### 1) MEMORY.md corruption (garbled repeats)
- File: `src/johann/memory.ts` lines 364–373
  - Helpers `writeText` (L364–L367) and `appendText` (L370–L373) use Node `fs.writeFileSync` and `fs.appendFileSync` directly (non-atomic, no lock).
- File: `src/johann/memory.ts` lines 529–568 — `writeReflection()`
  - Reads full MEMORY.md, mutates string, overwrites via `writeText` — classic read-modify-write race, not atomic.
- File: `src/johann/memory.ts` lines 620–647 — `trimMemory()`
  - Reads and slices sections, then overwrites via `writeText` (non-atomic).
- File: `src/johann/bootstrap.ts` lines 120–124 and 151–172
  - `writeFile` and `writeBootstrapFile` use `vscode.workspace.fs.writeFile` without temp+rename.
- Root cause: Concurrent, non-atomic writes and read-modify-write cycles on `MEMORY.md` from multiple entry points; no locking or deduplication; mixed VS Code FS and Node fs APIs.

### 2) Daily notes corruption (`.vscode/johann/memory/YYYY-MM-DD.md`)
- File: `src/johann/dailyNotes.ts` lines 92–94, 98–138 — `writeFileContent`, `appendDailyNote`
  - Read entire file → concatenate → overwrite; no mutex/lock; non-atomic.
- File: `src/johann/memory.ts` lines 538–545 — `writeReflection()` writing to daily notes via `appendText` (Node fs append) while `dailyNotes.ts` uses VS Code FS overwrite.
- Root cause: Competing write paths (append vs overwrite) with no coordination; parallel writes lead to torn/duplicated fragments.

### 3) No atomic write protection
- Evidence:
  - `src/johann/memory.ts` `writeText` (L364–L367) and `appendText` (L370–L373): direct writes.
  - `src/johann/dailyNotes.ts` `writeFileContent` (L92–L94): direct write.
  - `src/johann/executionLedger.ts` `saveLedger` (L988–L1003): direct write of `ledger.json`.
- Root cause: No temp-file-and-rename pattern; partial writes possible under contention or interruption.

### 4) No deduplication
- Evidence:
  - `src/johann/memory.ts` `writeReflection` (L529–L568): appends under `## Reflections` with no duplicate check.
  - `src/johann/dailyNotes.ts` `appendDailyNote` (L98–L138): unconditional append; no hashing/idempotency.
- Root cause: Missing content hashing or tail comparison allows repeated entries (appearing as corruption).

### 5) BOOTSTRAP.md lifecycle gap
- File: `src/johann/bootstrap.ts` lines 106–147
  - `initializeBootstrapWorkspace` sets `isFirstRun` based on directory existence and skips re-creating `BOOTSTRAP.md` if dir already exists (L123–L127).
- File: `src/johann/participant.ts` lines 396–401
  - Deletes `BOOTSTRAP.md` via `completeBootstrap(johannDir)` only when `isFirstRun` is true after orchestration completes.
- Observation: `BOOTSTRAP.md` remains in `.vscode/johann/` in the workspace listing, implying `isFirstRun` was false (dir pre-existed) or orchestration didn’t reach deletion.
- Root cause: Sentinel deletion tied to `isFirstRun`; if the directory existed pre-onboarding or execution fails early, `BOOTSTRAP.md` is not removed.

## Detailed Evidence (paths and line numbers)
- `src/johann/memory.ts`
  - L364–367: `writeText()` — `fs.writeFileSync`.
  - L370–373: `appendText()` — `fs.appendFileSync`.
  - L529–568: `writeReflection()` — read-modify-write of MEMORY.md.
  - L538–545: daily note appends via `appendText`.
  - L620–647: `trimMemory()` — non-atomic overwrite.
- `src/johann/dailyNotes.ts`
  - L92–94: `writeFileContent()` — direct write.
  - L98–138: `appendDailyNote()` — read-modify-write pattern.
- `src/johann/executionLedger.ts`
  - L988–1003: `saveLedger()` — direct write of `ledger.json`.
- `src/johann/bootstrap.ts`
  - L120–124, L151–172: direct writes.
- `src/johann/participant.ts`
  - L396–401: conditional `completeBootstrap` call.

## Recommendations

### Atomic writes and API consistency
- Adopt temp-write + rename for all memory files using `vscode.workspace.fs` (write temp URI, then `vscode.workspace.fs.rename` with overwrite).
- Remove `fs.*Sync` usage; standardize on VS Code FS to respect virtual providers and avoid sync I/O.

### Concurrency guards and idempotency
- Implement per-file async mutex (map of locks) wrapping all read-modify-write operations for `MEMORY.md` and daily notes.
- Add deduplication via content hashing or tail-window comparison before appends (skip identical entries).

### Append-only journaling and scheduled compaction
- Switch daily notes and reflections to append-only journal files; perform compaction/curation into `MEMORY.md` during heartbeat under a lock.

### BOOTSTRAP.md lifecycle
- Decouple deletion from `isFirstRun`: If `BOOTSTRAP.md` exists post-orchestration, delete it unconditionally (or gate behind confirmation).
- Persist `.vscode/johann/.bootstrap-completed` to prevent re-creation and mark completion independent of folder existence.

### Verification steps
- Simulate concurrent writes with two parallel append operations to the same daily note; ensure atomic append or lock prevents interleaving.
- Run heartbeat compaction while appending reflections; verify no torn writes using temp+rename.
- Confirm `BOOTSTRAP.md` removal after orchestration regardless of `isFirstRun` state.

## Conclusion
Corruption originates from concurrent, non-atomic writes and missing deduplication across multiple code paths writing to shared memory files. Implement atomic write patterns, per-file locks, idempotency, and unify file APIs. Fix BOOTSTRAP.md deletion logic to ensure sentinel removal.

