/**
 * selfAwareness.ts — Self-Referential Task Detection & Context Enrichment
 *
 * When Johann is asked to work on his own source code (the Fugue extension),
 * subagents need special awareness:
 *
 * 1. They're modifying the very system that's orchestrating them
 * 2. They need architectural knowledge of Johann's modules
 * 3. They need higher execution limits (more files to read, more changes)
 * 4. They must be careful not to break the running extension
 *
 * This module:
 * - Detects self-referential tasks from the request + workspace
 * - Provides architecture context so subagents understand the codebase
 * - Signals the orchestrator to apply elevated execution limits
 */

import * as vscode from 'vscode';

// ============================================================================
// Detection
// ============================================================================

/** Signals from the request text that suggest self-referential work. */
const SELF_REF_PATTERNS: RegExp[] = [
    /\bjohann\b/i,
    /\bfugue\b/i,
    /\borchestrat/i,
    /\bsubagent/i,
    /\bmulti.?pass/i,
    /\bself.?(?:improv|modif|heal|aware|referen)/i,
    /\bown\s+(?:source|code|codebase)/i,
    /\bwork\s+on\s+(?:yourself|himself|itself)/i,
    /\bmodify\s+(?:yourself|himself|itself)/i,
    /\bupgrade\s+(?:yourself|himself|itself)/i,
    /\bimprove\s+(?:yourself|himself|itself)/i,
    /\bextension\.ts\b/i,
    /\bparticipant\.ts\b/i,
    /\borchestrator\.ts\b/i,
    /\btaskDecomposer\b/i,
    /\bsubagentManager\b/i,
    /\bexecutionLedger\b/i,
    /\bmodelPicker\b/i,
    /\bworktreeManager\b/i,
    /\bmemory\.ts\b/i,
    /\bsessionPersist/i,
];

/** Workspace-level signals: files that indicate we're in Johann's own repo. */
const SELF_REPO_MARKER_FILES = [
    'src/johann/orchestrator.ts',
    'src/johann/subagentManager.ts',
    'src/johann/participant.ts',
    'src/extension.ts',
];

export interface SelfAwarenessResult {
    /** Whether this task involves working on Johann's own code */
    isSelfReferential: boolean;
    /** Confidence score 0-1 */
    confidence: number;
    /** Which signals triggered detection */
    signals: string[];
    /** Architecture context block to inject into subagent prompts */
    architectureContext: string;
    /** Recommended complexity override (self-referential tasks are inherently complex) */
    recommendedComplexity: 'complex' | 'expert';
}

/**
 * Detect whether a request involves Johann working on his own source code.
 */
export async function detectSelfReferentialTask(
    request: string,
    workspaceContext: string,
): Promise<SelfAwarenessResult> {
    const signals: string[] = [];
    let score = 0;

    // Check request text for self-referential patterns
    for (const pattern of SELF_REF_PATTERNS) {
        if (pattern.test(request)) {
            signals.push(`request matches: ${pattern.source}`);
            score += 0.15;
        }
    }

    // Check if we're in Johann's own workspace.
    // Only count markers from ONE folder (the first match) to avoid
    // accumulating false positives in multi-root or mono-repo workspaces.
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        let markersFired = false;
        for (const folder of workspaceFolders) {
            if (markersFired) {
                break;
            }
            let folderHits = 0;
            for (const marker of SELF_REPO_MARKER_FILES) {
                try {
                    const uri = vscode.Uri.joinPath(folder.uri, marker);
                    await vscode.workspace.fs.stat(uri);
                    signals.push(`marker file found: ${marker} in ${folder.name}`);
                    folderHits++;
                } catch {
                    // File doesn't exist — not a signal
                }
            }
            if (folderHits > 0) {
                // Credit once: presence in Johann's repo scores 0.3 regardless of
                // how many marker files match. This prevents 4 markers × 0.2 = 0.8
                // from auto-triggering on every workspace that contains fugue/.
                score += 0.3;
                markersFired = true;
            }
        }
    }

    // Check workspace context for Johann-specific references
    if (/src\/johann\//.test(workspaceContext)) {
        signals.push('workspace context references src/johann/');
        score += 0.2;
    }

    const isSelfReferential = score >= 0.3;
    const confidence = Math.min(score, 1.0);

    return {
        isSelfReferential,
        confidence,
        signals,
        architectureContext: isSelfReferential ? buildArchitectureContext() : '',
        recommendedComplexity: confidence > 0.6 ? 'expert' : 'complex',
    };
}

// ============================================================================
// Architecture Context — Injected into subagent prompts for self-referential tasks
// ============================================================================

function buildArchitectureContext(): string {
    return `=== SELF-AWARENESS: YOU ARE WORKING ON JOHANN'S OWN SOURCE CODE ===

You are modifying the Fugue VS Code extension — specifically the Johann orchestration system.
Johann is the system that is CURRENTLY RUNNING and orchestrating YOUR execution.
Be methodical and careful: breaking this code breaks the orchestrator itself.

## Architecture Quick Reference

\`\`\`
extension.ts (entry point + @ramble participant)
└── src/johann/
    ├── participant.ts     — @johann chat participant registration
    ├── orchestrator.ts    — 4-phase pipeline: Plan → Execute → Merge → Memory
    ├── taskDecomposer.ts  — LLM-powered task decomposition to JSON plan
    ├── subagentManager.ts — Agentic tool-calling loop (complexity-aware limits)
    ├── executionLedger.ts — Hive mind: file-based real-time coordination
    ├── modelPicker.ts     — 5-tier model selection + cost-aware escalation
    ├── worktreeManager.ts — Git worktree isolation for parallel subtasks
    ├── memory.ts          — File-based persistent memory
    ├── sessionPersist*.ts — Session state + resume capability
    ├── selfAwareness.ts   — Self-referential task detection (THIS module)
    ├── selfHealing.ts     — Failure pattern → skill creation
    ├── skills.ts          — Discoverable SKILL.md system
    ├── multiPass*.ts      — Multi-pass strategies (designed, not yet wired for agentic)
    ├── config.ts          — VS Code settings-based configuration
    ├── types.ts           — Core type definitions
    ├── bootstrapContext.ts— Environment detection (DDEV, Docker, npm, etc.)
    ├── hooks.ts           — Lifecycle hook system
    ├── flowCorrection.ts  — Upstream task re-run on downstream error detection
    ├── delegationPolicy.ts— Delegation guard (prevents runaway spawning)
    ├── graphManager.ts    — DAG wave computation for parallel execution
    ├── runState.ts        — Live run state tracking
    └── [support files]    — logger, retry, safeIO, contextDistiller, etc.
\`\`\`

## Critical Rules for Self-Modification

1. **Read before writing.** Always read the FULL file before editing it.
2. **Verify after writing.** Read the file back after edits to confirm correctness.
3. **Preserve imports.** Every import must resolve. Check before adding new ones.
4. **TypeScript strict mode.** All code must compile under \`strict: true\`.
5. **No orphaned code.** If you add a function, it must be called. If you remove a caller, remove the dead code.
6. **VS Code API only.** Use \`vscode.workspace.fs\` for file ops — no raw \`fs\` calls.
7. **Atomic writes.** Use safeIO.ts patterns for files in \`.vscode/johann/\`.
8. **Don't break the running session.** Changes take effect on next activation, not during this run.

## Key Type Definitions

- \`TaskComplexity\`: 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert'
- \`OrchestrationPlan\`: { summary, subtasks[], strategy, successCriteria[], overallComplexity }
- \`Subtask\`: { id, title, description, complexity, dependsOn[], successCriteria[], status, ... }
- \`SubtaskResult\`: { success, modelUsed, output, reviewNotes, durationMs, timestamp }
- \`JohannSession\`: { sessionId, originalRequest, plan, status, escalations[], ... }

## Subagent Execution Limits (complexity-aware)

| Complexity | Tool Rounds | Output Chars | Text Rounds |
|------------|-------------|--------------|-------------|
| trivial    | 15          | 100K         | 2           |
| simple     | 30          | 200K         | 3           |
| moderate   | 40          | 350K         | 4           |
| complex    | 60          | 500K         | 5           |
| expert     | 80          | 750K         | 6           |

===`;
}
