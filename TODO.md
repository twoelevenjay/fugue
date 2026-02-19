# TODO

## Fixed (2026-02-19)

### Johann Fixes — All Implemented ✅

- ✅ **Review false-negative bug** — Tasks marked "failed" despite succeeding
    - Fixed explicit COMPLETED marker detection
    - Lowered auto-pass threshold 8→6 tool calls
    - Added detailed logging for review decisions
    - **See:** `johann-fixes-implementation.md` for full details
- ✅ **Model usage reporting** — End-of-run model usage report
    - Shows models used per subtask, success rates, premium requests
    - Escalation chains visible
    - Helps track cost/quota
    - **See:** `johann-fixes-implementation.md` for report format
- ✅ **Skill promotion UI bug** — Redundant banner removed
    - No more instructional message after clicking "Promote to Global"
    - Cleaner UX
    - **See:** `johann-fixes-implementation.md`

### Ramble Fixes

- ✅ Ramble chat participant header — changed from "Fugue — Prompt Compiler" to "Ramble — Prompt Compiler" in package.json
- ✅ Ramble analysis phase hanging — fixed empty response loop (increased tool rounds 5→10, added detailed logging, stronger finish instruction, better error diagnostics)

---

## Future Enhancements

### Skill Promotion (Full Implementation)

- Wire up actual promotion in `offerSkillPromotion()` using SkillPromotionManager
- Requires passing GlobalSkillStore to orchestrator constructor
- Currently deferred to end-of-run promotion UI (which works correctly)
