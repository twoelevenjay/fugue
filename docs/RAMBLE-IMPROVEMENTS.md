# Ramble Agent Improvements — Question Generation & Context Engineering

## Date: February 15, 2026

## Problem Statement

Testing revealed that the Ramble agent's question-asking behavior varied significantly across different models:

- **Opus 4.5 & 4.6**: Consistently asked excellent, contextual follow-up questions that improved prompt quality
- **GPT-5.3 Codex**: Rarely asked questions, even when context was ambiguous

The issue: Ramble's system prompts relied too heavily on implicit model reasoning rather than providing explicit, mechanical processes for identifying ambiguities and generating questions.

## Core Capability Preserved: Dynamic Multi-Round Questioning

**IMPORTANT:** These improvements preserve AND enhance Ramble's dynamic, iterative questioning:

- ✅ Asks as many rounds of questions as needed (up to 3 rounds)
- ✅ If an answer reveals NEW ambiguities, it asks follow-up questions
- ✅ If an answer is vague or incomplete, it probes deeper
- ✅ Only stops when context is genuinely complete OR max rounds reached

The enhancements make this behavior **more consistent across models**, not more limited.

## Root Cause

The original prompts assumed the model would:
1. Naturally identify ambiguities through "understanding"
2. Intuitively know what makes a good vs bad question
3. Judge completeness based on general reasoning ability

This works well for models with strong general reasoning (Opus), but fails for models optimized for specific tasks (Codex for orchestration vs. prompt engineering).

## Solution: Mechanical, Explicit Question Generation

### Key Changes

#### 1. Added Explicit Process Framework
```
THIS IS A SYSTEMATIC, MECHANICAL PROCESS — NOT CREATIVE REASONING:
1. Extract all distinct facts into the context packet (mechanical organization)
2. Apply the ambiguity checklist to identify potential questions (pattern matching)
3. Filter questions using explicit criteria (rule application)
4. Format questions with specific, contextual language (template application)
```

This signals to ALL models (regardless of capability) that this is a step-by-step process, not open-ended reasoning.

#### 2. Systematic Ambiguity Detection Checklist

Replaced vague "identify missing info" with concrete categories:

**STEP 1 - IDENTIFY AMBIGUITIES:**
- a) **Multiple interpretations**: 2+ valid ways to understand the request
- b) **Vague scope boundaries**: Unclear start/stop points
- c) **Underspecified behavior**: Edge cases/alternatives not defined
- d) **Missing critical context**: Info that changes implementation approach
- e) **Contradictory statements**: Conflicting requirements
- f) **Unclear pronouns/references**: Ambiguous "it", "that system", etc.

Each category includes concrete examples showing BOTH the ambiguous input AND the clarifying question.

#### 3. Explicit Filtering Criteria

**STEP 2 - FILTER OUT NON-QUESTIONS:**
Clear rules for what NOT to ask about:
- Things implied by context
- Standard practices
- Implementation details decided during coding
- Info auto-resolved by later tiers (codebase search, knowledge resolution)
- Clarifications where any choice works fine

#### 4. Good vs Bad Question Examples

Added 5 detailed examples showing:
- ❌ BAD: Generic, terse, or implementation-detail questions
- ✓ GOOD: Specific, contextual questions grounded in the user's request

**Example:**
```
User says: "Make the app work offline"
❌ BAD: "How should offline mode work?" (too broad)
✓ GOOD: "For offline functionality - should users be able to create/edit data 
         offline (requires conflict resolution) or just view previously loaded data?"
```

#### 5. Explicit isComplete Criteria

Replaced subjective "enough info" with concrete checklist:

Set **isComplete: false** if ANY of:
- Goal is ambiguous (2+ interpretations)
- Multiple implementation approaches exist
- Critical missing context (from Step 1 checklist)
- Unresolved transcription errors

Set **isComplete: true** if ALL of:
- Clear, singular understanding
- Remaining uncertainties are implementation details
- Could write comprehensive prompt leading to good results

#### 6. Enhanced Merge Prompt

Applied the same improvements to the merge prompt used in multi-round questioning:
- Re-evaluate using the SAME systematic checklist
- Generate follow-up questions if answers revealed new ambiguities
- Don't over-ask once context is sufficient

## Expected Outcomes

### Dynamic Multi-Round Flow Preserved & Enhanced:

**The iterative questioning capability is fully preserved:**
1. Initial analysis identifies ambiguities \u2192 asks questions (Round 1)
2. User answers \u2192 merge prompt re-evaluates with systematic checklist
3. If answers reveal NEW ambiguities \u2192 asks follow-up questions (Round 2)
4. Process continues until context is complete OR 3 rounds reached
5. Each round uses 3-tier resolution (codebase search \u2192 knowledge \u2192 user questions)

**What changed:** The QUALITY and CONSISTENCY of questions across models, not the dynamic nature.

### For All Models:
- More consistent question-asking behavior across different model families
- Higher-quality questions that are specific and contextual
- Better balance between thoroughness and minimal user interruption

### For Orchestration-Optimized Models (like GPT-5.3 Codex):
- Clear step-by-step process removes need for "intuitive understanding"
- Checklist-based approach leverages pattern matching strengths
- Explicit examples provide templates to follow

### For Reasoning-Heavy Models (like Opus 4.5/4.6):
- Structured approach maintains their already-good performance
- Examples reinforce best practices
- Checklists prevent over-asking

## Implementation Details

**Files Changed:**
- `/src/extension.ts`
  - `getAnalysisPrompt()` - Main analysis system prompt
  - `getMergePrompt()` - Multi-round merge system prompt

**Backward Compatibility:**
- No breaking changes to API or data structures
- Enhanced prompts work with existing context packet format
- All existing functionality preserved

## Testing Recommendations

### Example: Dynamic Multi-Round Flow

To verify the iterative capability works, try this test case:

**Initial prompt:** "Add notifications to the app"

**Expected Round 1 questions:**
- "What types of notifications - email, in-app, push, SMS, or multiple?"
- "What events should trigger notifications?"

**User answers:** "Both email and in-app notifications for user actions"

**Expected Round 2 questions (NEW ambiguities revealed):**
- "Should email notifications be real-time or batched (e.g., daily digest)?"
- "What specific user actions trigger notifications - logins, purchases, comments, likes?"
- "Should users be able to configure notification preferences?"

**User answers:** "Real-time emails for purchases, batched for comments. Users can configure preferences."

**Expected:** Marked as complete, proceeds to compilation.

This demonstrates:
- ✅ Multiple rounds triggered by answers revealing new ambiguities
- ✅ Each round generates specific, contextual questions
- ✅ Stops when context is sufficient

### Cross-Model Testing

1. **Cross-Model Testing**: Test with multiple models (GPT-5.3 Codex, Opus 4.5, Opus 4.6, GPT-4o) using identical prompts
2. **Ambiguity Detection**: Use intentionally ambiguous requests to verify questions are generated
3. **Over-Asking Prevention**: Use clear requests to verify questions aren't generated unnecessarily
4. **Question Quality**: Evaluate if generated questions are specific and contextual vs generic
5. **Multi-Round Behavior**: Test that follow-up rounds appropriately identify remaining ambiguities

## Future Improvements

1. **Prompt Tuning**: Adjust based on real-world usage patterns
2. **Model-Specific Tweaks**: Add model-family-specific guidance if needed
3. **Few-Shot Library**: Build a library of example ambiguities → questions for reference
4. **Confidence Scoring**: Add explicit confidence scores for isComplete judgments
5. **Feedback Loop**: Collect data on question quality and adjust criteria

## Notes

The philosophy here: **Context engineering shouldn't require a PhD-level reasoning model**. By breaking down the task into explicit, mechanical steps with concrete examples, we make high-quality prompt compilation accessible to a wider range of models—each contributing their strengths (speed, cost, specialized knowledge) without sacrificing quality.
