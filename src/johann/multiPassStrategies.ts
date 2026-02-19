// ============================================================================
// MULTI-PASS STRATEGIES — Deterministic verification patterns
//
// The problem: just retrying with different models pays 2× to be wrong twice.
// The solution: structured multi-pass patterns with deterministic aggregation.
//
// Key principles:
// - Use cheap (0×) models for most passes
// - Each pass has a specific role (draft, critique, verify, repair)
// - Aggregation is deterministic (voting, tool checks, rubrics)
// - Escalate to premium only when verifiers find high uncertainty
//
// Based on research showing multi-pass + verification outperforms
// single expensive model calls for most software engineering tasks.
// ============================================================================

import { TaskType } from './types';

/**
 * Multi-pass strategy types.
 * Each strategy has different pass types and aggregation logic.
 */
export type MultiPassStrategyType =
    | 'draft-critique-revise' // For subjective quality (docs, specs, plans)
    | 'self-consistency' // For debugging and reasoning questions
    | 'tool-verified-loop' // For code generation with automated checks
    | 'two-pass-rubric' // For code review and analysis
    | 'none'; // Single-pass only

/**
 * Individual pass in a multi-pass workflow.
 */
export interface MultiPassStep {
    /** Role of this pass */
    role:
        | 'draft'
        | 'critique'
        | 'revise'
        | 'sample'
        | 'aggregate'
        | 'verify'
        | 'repair'
        | 'extract'
        | 'score';

    /** Model cost tier to use for this pass (0, 0.33, 1, 3) */
    targetCost: number;

    /** Expected output format */
    outputFormat?: 'text' | 'json' | 'code' | 'structured-list';

    /** JSON schema for structured outputs (if applicable) */
    jsonSchema?: Record<string, any>;

    /** Description of what this pass should do */
    instruction: string;
}

/**
 * Configuration for a multi-pass strategy.
 */
export interface MultiPassStrategy {
    /** Strategy identifier */
    type: MultiPassStrategyType;

    /** When to use this strategy */
    useFor: string[];

    /** Sequence of passes to execute */
    passes: MultiPassStep[];

    /** Aggregation method */
    aggregator: {
        type:
            | 'majority-vote'
            | 'consensus-threshold'
            | 'tool-oracle'
            | 'rubric-score'
            | 'critic-fixes';
        description: string;
        config?: Record<string, any>;
    };

    /** When to escalate to premium model */
    escalationTriggers: string[];

    /** Description */
    description: string;
}

// ============================================================================
// STRATEGY 1: Draft → Critique → Revise
// ============================================================================

export const DRAFT_CRITIQUE_REVISE: MultiPassStrategy = {
    type: 'draft-critique-revise',
    useFor: [
        'PR descriptions',
        'ADRs and architecture proposals',
        'Refactor plans',
        'Code review comments',
        'Risk assessments',
        'Documentation',
        'Specifications',
    ],
    passes: [
        {
            role: 'draft',
            targetCost: 0, // GPT-4.1 or GPT-4o
            instruction:
                'Create an initial draft. Focus on covering all requirements and being thorough. Do not worry about polish yet.',
        },
        {
            role: 'critique',
            targetCost: 0, // GPT-4.1 (stricter)
            outputFormat: 'structured-list',
            instruction: `Review the draft against this rubric:

MUST-FIX issues:
- Missing required information or context
- Factual errors or incorrect claims
- Unclear or ambiguous language
- Missing edge cases or failure modes
- Incomplete implementation guidance

NICE-TO-HAVE improvements:
- Better examples or explanations
- More concise wording
- Better structure or organization
- Additional context for readers

Output a structured list of issues with severity (must-fix / nice-to-have) and specific location references.`,
        },
        {
            role: 'revise',
            targetCost: 0, // GPT-5 mini or GPT-4.1
            outputFormat: 'text',
            instruction:
                'Revise the draft to address ALL must-fix issues. Show a clear mapping of issue → fix. Maintain the original intent while improving clarity and completeness.',
        },
    ],
    aggregator: {
        type: 'critic-fixes',
        description:
            'Verify that revision addresses all must-fix issues from critique. If not, fail and escalate.',
        config: {
            requireAllMustFixAddressed: true,
        },
    },
    escalationTriggers: [
        'Critic finds > 5 must-fix issues',
        'Revision fails to address must-fix issues',
        'High uncertainty in critique',
    ],
    description:
        'Best for subjective quality improvements. Draft → Critique with rubric → Revise with explicit fixes.',
};

// ============================================================================
// STRATEGY 2: Self-Consistency / Voting
// ============================================================================

export const SELF_CONSISTENCY: MultiPassStrategy = {
    type: 'self-consistency',
    useFor: [
        'Root cause analysis',
        'Bug diagnosis',
        'Function responsibility pinpointing',
        'Algorithm selection',
        'Edge case enumeration',
        'Test case generation (what tests should exist)',
    ],
    passes: [
        {
            role: 'sample',
            targetCost: 0, // GPT-4.1 or GPT-5 mini
            outputFormat: 'json',
            jsonSchema: {
                type: 'object',
                properties: {
                    answer: { type: 'string', description: 'The main answer' },
                    reasoning: { type: 'string', description: 'Step-by-step reasoning' },
                    evidence: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Supporting evidence',
                    },
                    confidence: {
                        type: 'number',
                        minimum: 0,
                        maximum: 1,
                        description: 'Confidence 0-1',
                    },
                },
                required: ['answer', 'reasoning', 'confidence'],
            },
            instruction:
                'Analyze the problem and provide your answer with reasoning and evidence. Be specific and cite line numbers, file names, or error messages where relevant.',
        },
        {
            role: 'aggregate',
            targetCost: 0,
            instruction: 'This is a deterministic aggregation step - no LLM call needed.',
        },
    ],
    aggregator: {
        type: 'majority-vote',
        description:
            'Sample N=3-5 times. Cluster answers by similarity. Pick the cluster with highest frequency AND highest average confidence. If no majority (< 50%), escalate.',
        config: {
            numSamples: 3,
            minimumAgreement: 0.5, // 50% must agree
            confidenceWeight: 0.3, // 30% weight to confidence, 70% to frequency
        },
    },
    escalationTriggers: [
        'No majority answer (< 50% agreement)',
        'All samples have confidence < 0.6',
        'Contradictory evidence across samples',
    ],
    description:
        'Sample multiple reasoning paths, then vote on consensus. Best for debugging and analysis with uncertain answers.',
};

// ============================================================================
// STRATEGY 3: Generate → Verify → Repair (Tool-Verified Loop)
// ============================================================================

export const TOOL_VERIFIED_LOOP: MultiPassStrategy = {
    type: 'tool-verified-loop',
    useFor: [
        'Unit test generation',
        'Type error fixes',
        'Lint and format issues',
        'Compilation errors',
        'Failing CI reproduction',
        'Bug fixes with test coverage',
    ],
    passes: [
        {
            role: 'draft',
            targetCost: 0, // GPT-5 mini
            outputFormat: 'code',
            instruction:
                'Generate the code or fix. Ensure it compiles and follows project conventions.',
        },
        {
            role: 'verify',
            targetCost: 0,
            instruction:
                'Run automated checks: compile, typecheck, lint, tests. This is a tool-based verification step.',
        },
        {
            role: 'repair',
            targetCost: 0, // GPT-4.1 for diagnosis + GPT-5 mini for fix
            outputFormat: 'code',
            instruction:
                'Given the automated check failures, diagnose the issue and generate a targeted fix. Focus ONLY on the reported errors. Do not refactor unrelated code.',
        },
    ],
    aggregator: {
        type: 'tool-oracle',
        description:
            'Pass/fail is determined by automated tools. Loop up to maxIterations=3. If still failing after max iterations, escalate.',
        config: {
            maxIterations: 3,
            checks: ['compile', 'typecheck', 'lint', 'test'],
            failFast: false, // Continue through all checks even if one fails
        },
    },
    escalationTriggers: [
        'All iterations fail tool checks',
        'Same error persists across iterations (no progress)',
        'Tool check crashes or produces unclear error',
    ],
    description:
        'Generate code → Run tools (tests, lint, typecheck) → Repair if failed. Loop until pass or max iterations. Highest "truth signal".',
};

// ============================================================================
// STRATEGY 4: Two-Pass Code Review Rubric
// ============================================================================

export const TWO_PASS_RUBRIC: MultiPassStrategy = {
    type: 'two-pass-rubric',
    useFor: [
        'PR review automation',
        'Security scanning',
        'Consistency checks',
        'Style and pattern enforcement',
        'API design review',
    ],
    passes: [
        {
            role: 'extract',
            targetCost: 0, // GPT-4o or GPT-4.1
            outputFormat: 'structured-list',
            instruction: `Extract potential issues only. Do not score or filter yet.

Look for:
- Security vulnerabilities (SQL injection, XSS, auth bypasses)
- Performance problems (N+1 queries, inefficient algorithms)
- Error handling gaps (missing try-catch, unhandled promises)
- Type safety issues (unchecked casts, missing null checks)
- Code duplication (repeated logic that should be extracted)
- API design problems (unclear naming, inconsistent patterns)

Output: file path, line number, issue type, description for each finding.`,
        },
        {
            role: 'score',
            targetCost: 0, // GPT-4.1
            outputFormat: 'json',
            jsonSchema: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        file: { type: 'string' },
                        line: { type: 'number' },
                        ruleId: { type: 'string' },
                        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                        description: { type: 'string' },
                        suggestedFix: { type: 'string' },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                    },
                    required: ['file', 'line', 'ruleId', 'severity', 'description', 'confidence'],
                },
            },
            instruction: `Score each extracted issue using this rubric:

CRITICAL - Must fix before merge:
- Security vulnerabilities
- Data loss or corruption risks
- Breaking API changes without migration
- Crashes or undefined behavior

WARNING - Should fix:
- Performance degradation > 2x
- Missing error handling for common cases
- Significant code duplication
- Type safety gaps that could cause runtime errors

INFO - Consider improving:
- Minor style inconsistencies
- Opportunities for better naming
- Could use more comments

Deduplicate issues with same file + line + ruleId. Assign confidence based on certainty.`,
        },
    ],
    aggregator: {
        type: 'rubric-score',
        description:
            'Deduplicate by file+line+ruleId. Filter by minimum confidence. Group by severity. If any critical issues with high confidence, escalate for review.',
        config: {
            minimumConfidence: 0.7,
            escalateOnCritical: true,
        },
    },
    escalationTriggers: [
        'Critical issues with confidence > 0.8',
        'Multiple warnings with same root cause',
        'Uncertain severity classification (confidence < 0.6)',
    ],
    description:
        'Extract issues → Score with rubric → Deduplicate. More stable than single-pass review.',
};

// ============================================================================
// TASK TYPE → MULTI-PASS STRATEGY MAPPING
// ============================================================================

/**
 * Maps task types to recommended multi-pass strategies.
 * If no entry or strategy is 'none', use single-pass execution.
 */
export const TASK_TO_MULTIPASS_STRATEGY: Record<TaskType, MultiPassStrategyType> = {
    generate: 'tool-verified-loop', // Codegen benefits from automated checks
    refactor: 'tool-verified-loop', // Refactors need tests to verify correctness
    test: 'tool-verified-loop', // Tests must actually run
    debug: 'self-consistency', // Debugging needs multiple reasoning paths
    investigate: 'self-consistency', // Investigation benefits from multiple reasoning paths
    implement: 'tool-verified-loop', // Implementation needs verification
    review: 'two-pass-rubric', // Code review needs extraction + scoring
    spec: 'draft-critique-revise', // Specs benefit from critique
    edit: 'none', // Small edits don't need multi-pass
    design: 'draft-critique-revise', // Architecture docs need critique
    'complex-refactor': 'draft-critique-revise', // Plan first, then tool-verify implementation
};

/**
 * Get the recommended multi-pass strategy for a task type.
 */
export function getMultiPassStrategy(taskType: TaskType): MultiPassStrategy | null {
    const strategyType = TASK_TO_MULTIPASS_STRATEGY[taskType];

    switch (strategyType) {
        case 'draft-critique-revise':
            return DRAFT_CRITIQUE_REVISE;
        case 'self-consistency':
            return SELF_CONSISTENCY;
        case 'tool-verified-loop':
            return TOOL_VERIFIED_LOOP;
        case 'two-pass-rubric':
            return TWO_PASS_RUBRIC;
        case 'none':
        default:
            return null;
    }
}

/**
 * Determine if a task should use multi-pass based on complexity and type.
 *
 * Rules:
 * - Always use multi-pass for tool-verified-loop (has oracle)
 * - Use multi-pass for complex/expert tasks in appropriate types
 * - Skip multi-pass for trivial/simple tasks (not worth the overhead)
 */
export function shouldUseMultiPass(
    taskType: TaskType,
    complexity: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert',
): boolean {
    const strategyType = TASK_TO_MULTIPASS_STRATEGY[taskType];

    if (strategyType === 'none') {
        return false;
    }

    // Always use tool-verified loop if available (highest truth signal)
    if (strategyType === 'tool-verified-loop') {
        return true;
    }

    // For other strategies, use multi-pass for moderate+ complexity
    if (complexity === 'trivial' || complexity === 'simple') {
        return false;
    }

    return true;
}

// ============================================================================
// VOTING AND AGGREGATION UTILITIES
// ============================================================================

/**
 * Result from a self-consistency sample.
 */
export interface ConsistencySample {
    answer: string;
    reasoning: string;
    evidence?: string[];
    confidence: number;
}

/**
 * Cluster similar answers and vote.
 * Returns the consensus answer or null if no majority.
 */
export function voteOnConsistency(
    samples: ConsistencySample[],
    minimumAgreement: number = 0.5,
    confidenceWeight: number = 0.3,
): { consensus: string; confidence: number; evidence: string[] } | null {
    if (samples.length === 0) {
        return null;
    }

    // Simple clustering: group by exact answer match (could be improved with semantic similarity)
    const clusters = new Map<string, ConsistencySample[]>();

    for (const sample of samples) {
        const normalized = sample.answer.toLowerCase().trim();
        if (!clusters.has(normalized)) {
            clusters.set(normalized, []);
        }
        clusters.get(normalized)!.push(sample);
    }

    // Score each cluster
    const clusterScores = Array.from(clusters.entries()).map(([answer, clusterSamples]) => {
        const frequency = clusterSamples.length / samples.length;
        const avgConfidence =
            clusterSamples.reduce((sum, s) => sum + s.confidence, 0) / clusterSamples.length;

        // Combined score: frequency + weighted confidence
        const score = frequency * (1 - confidenceWeight) + avgConfidence * confidenceWeight;

        // Collect all evidence
        const evidence = clusterSamples.flatMap((s) => s.evidence || []);

        return {
            answer,
            frequency,
            avgConfidence,
            score,
            evidence,
            samples: clusterSamples,
        };
    });

    // Sort by score
    clusterScores.sort((a, b) => b.score - a.score);

    const winner = clusterScores[0];

    // Check if winner has majority
    if (winner.frequency < minimumAgreement) {
        return null; // No consensus
    }

    return {
        consensus: winner.samples[0].answer, // Use original casing from first sample
        confidence: winner.avgConfidence,
        evidence: winner.evidence,
    };
}

/**
 * Check if a revised draft addresses all must-fix issues from critique.
 */
export interface CritiqueIssue {
    severity: 'must-fix' | 'nice-to-have';
    location: string;
    issue: string;
}

export function verifyRevisionAddressesIssues(
    critiqueIssues: CritiqueIssue[],
    revision: string,
): { allAddressed: boolean; missingFixes: CritiqueIssue[] } {
    const mustFixIssues = critiqueIssues.filter((i) => i.severity === 'must-fix');
    const missingFixes: CritiqueIssue[] = [];

    // Simple heuristic: check if revision mentions each must-fix location
    for (const issue of mustFixIssues) {
        const locationMentioned = revision.toLowerCase().includes(issue.location.toLowerCase());
        const issueMentioned = revision
            .toLowerCase()
            .includes(issue.issue.toLowerCase().slice(0, 20));

        if (!locationMentioned && !issueMentioned) {
            missingFixes.push(issue);
        }
    }

    return {
        allAddressed: missingFixes.length === 0,
        missingFixes,
    };
}

/**
 * Deduplicate code review findings by file + line + rule.
 */
export interface ReviewFinding {
    file: string;
    line: number;
    ruleId: string;
    severity: 'critical' | 'warning' | 'info';
    description: string;
    suggestedFix?: string;
    confidence: number;
}

export function deduplicateReviewFindings(
    findings: ReviewFinding[],
    minimumConfidence: number = 0.7,
): ReviewFinding[] {
    // Filter by confidence first
    const highConfidence = findings.filter((f) => f.confidence >= minimumConfidence);

    // Deduplicate by file+line+ruleId
    const seen = new Set<string>();
    const deduplicated: ReviewFinding[] = [];

    for (const finding of highConfidence) {
        const key = `${finding.file}:${finding.line}:${finding.ruleId}`;
        if (!seen.has(key)) {
            seen.add(key);
            deduplicated.push(finding);
        }
    }

    // Sort by severity then confidence
    const severityOrder = { critical: 0, warning: 1, info: 2 };
    deduplicated.sort((a, b) => {
        const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (severityDiff !== 0) {
            return severityDiff;
        }
        return b.confidence - a.confidence;
    });

    return deduplicated;
}
