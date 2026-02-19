import * as vscode from 'vscode';
import { Subtask, SubtaskResult, ModelInfo } from './types';
import { withRetry, REVIEW_RETRY_POLICY, classifyError } from './retry';
import { DebugConversationLog } from './debugConversationLog';
import { getConfig } from './config';
import { ExecutionLedger } from './executionLedger';
import { extractSummary, distillContext, SUMMARY_BLOCK_INSTRUCTION } from './contextDistiller';
import { Skill, loadSkillContent } from './skills';
import { SkillDoc } from './skillTypes';
import { MessageBus, parseHiveSignals, HIVE_SIGNAL_INSTRUCTION } from './messageBus';
import { HookRunner } from './hooks';
import { RateLimitGuard } from './rateLimitGuard';
import { FlowCorrectionManager } from './flowCorrection';
import {
    DelegationGuard,
    buildDelegationConstraintBlock,
    getDelegationPolicy,
} from './delegationPolicy';
import { SelfHealingDetector } from './selfHealing';

// ============================================================================
// SUBAGENT MANAGER — Spawns and manages individual subagent executions
//
// Each subagent is a tool-using LLM agent that:
// - Has access to ALL VS Code language model tools (file creation, editing,
//   terminal commands, search, etc.) via the vscode.lm.tools API
// - Runs in an agentic loop: prompt → tool calls → results → prompt → ...
// - Continues until the model produces a final text response with no tool calls
// - Has its own model (chosen by the model picker)
// - Has context from dependent subtasks' results
// - Has success criteria to evaluate against
// ============================================================================

/** Default maximum number of tool-calling loop iterations to prevent runaway agents. */
const _DEFAULT_MAX_TOOL_ROUNDS = 30;

/**
 * Default maximum consecutive text-only rounds (no tool calls) before forcing exit.
 * Prevents the model from rambling indefinitely without doing real work.
 */
const _DEFAULT_MAX_CONSECUTIVE_TEXT_ROUNDS = 3;

/**
 * Default maximum total output size in characters before aborting.
 * Prevents unbounded output accumulation from hallucinating models.
 */
const _DEFAULT_MAX_TOTAL_OUTPUT_CHARS = 200_000;

/**
 * Complexity-based execution limits.
 * Complex and expert tasks (e.g., self-modification, multi-file refactors)
 * need significantly higher limits to avoid premature stops.
 */
const LIMITS_BY_COMPLEXITY: Record<
    string,
    { maxToolRounds: number; maxConsecutiveTextRounds: number; maxTotalOutputChars: number }
> = {
    trivial: { maxToolRounds: 15, maxConsecutiveTextRounds: 2, maxTotalOutputChars: 100_000 },
    simple: { maxToolRounds: 30, maxConsecutiveTextRounds: 3, maxTotalOutputChars: 200_000 },
    moderate: { maxToolRounds: 40, maxConsecutiveTextRounds: 4, maxTotalOutputChars: 350_000 },
    complex: { maxToolRounds: 60, maxConsecutiveTextRounds: 5, maxTotalOutputChars: 500_000 },
    expert: { maxToolRounds: 80, maxConsecutiveTextRounds: 6, maxTotalOutputChars: 750_000 },
};

/** Get execution limits for a given complexity level. */
function getLimitsForComplexity(complexity: string): {
    maxToolRounds: number;
    maxConsecutiveTextRounds: number;
    maxTotalOutputChars: number;
} {
    return LIMITS_BY_COMPLEXITY[complexity] || LIMITS_BY_COMPLEXITY['moderate'];
}

/**
 * How often (in tool-loop rounds) to re-read the ledger and inject an update
 * into the running agent's conversation. Lower = more awareness, higher = less
 * prompt bloat. Every HIVE_MIND_REFRESH_INTERVAL rounds the agent gets a
 * compact "what changed" message from the hive mind.
 */
const HIVE_MIND_REFRESH_INTERVAL = 5;

/** Known problematic tools that can expose invalid schemas in some environments. */
const TOOL_NAME_BLOCKLIST = new Set<string>(['mcp_gitkraken_gitkraken_workspace_list']);

const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
    /\bnpm\s+run\s+(dev|start|watch)\b/i,
    /\byarn\s+(dev|start|watch)\b/i,
    /\bpnpm\s+(dev|start|watch)\b/i,
    /\b(next|vite|webpack|nodemon|ts-node-dev|uvicorn|gunicorn)\b/i,
    /\bpython\s+-m\s+http\.server\b/i,
    /\bflask\s+run\b/i,
    /\bdocker\s+compose\s+up(\s|$)(?!.*-d)/i,
    /\bdocker-compose\s+up(\s|$)(?!.*-d)/i,
    /\btail\s+-f\b/i,
    /\bwatch\s+\S+/i,
];

const SUBAGENT_SYSTEM_PREFIX = `You are a GitHub Copilot coding agent executing a specific subtask assigned to you by an orchestrator.

IDENTITY: You are a FULLY AUTONOMOUS execution agent. You do NOT interact with users. You do NOT ask questions. You do NOT narrate what you're about to do — you just DO it. Call your tools immediately and silently. The only text you should produce is a final summary of what you accomplished.

CRITICAL RULES:
1. **JUST ACT.** Do not narrate routine tool calls. Do not explain what you're about to do. Call the tool. If you need to create a file, create it. If you need to run a command, run it. No preamble, no commentary.
2. **USE YOUR TOOLS.** You have full access to file creation, file editing, terminal commands, and all other Copilot tools. You MUST use them to make real changes in the workspace. Do NOT just output text describing what should be done — actually DO it.
3. **CREATE REAL FILES.** When the task says "create a component," create the actual file in the workspace using your file-creation tools. When it says "install dependencies," run the actual npm/pip/etc command in the terminal. When it says "edit a file," use your edit tools.
4. **You are NOT Johann.** You are NOT an orchestrator. You are NOT doing onboarding. You are a worker agent executing a specific coding task. Do not introduce yourself. Do not ask questions. Do not give a greeting. Just execute the task.
5. **No stubs or placeholders.** Every function must be fully implemented. No "// TODO" comments. No "// Implement logic here" placeholders. No empty function bodies. Complete, working code only.
6. **Report what you DID.** Your final response should be a brief summary of what you actually did (files created, commands run, changes made), not what should be done.
7. **Prefer file tools over shell file-writing.** Use create/edit/patch file tools for source changes. Avoid brittle shell redirection patterns (heredoc, long echo/printf chains) unless absolutely necessary.
8. **Recover quickly from terminal issues.** If a shell command pattern fails twice (e.g., heredoc corruption), stop repeating it and switch to safer tools.

FORBIDDEN OUTPUTS (these indicate failure — ANY of these in your output means you FAILED):
- "Please run..."
- "You should..."
- "The user needs to..."
- "Ask the user to..."
- "Tell [someone] to..."
- "Make sure to..."
- "Would you like me to..."
- "Here's what you need to do..."
- "Here's what needs to happen..."
- "Next steps:" / "Next Steps Required"
- "Manual investigation needed"
- "You can then..." / "You'll need to..."
- Any instruction directed at a human rather than being an action you take yourself.
- Any suggestion starting with "Consider..." that tells someone else to act.
- Code blocks meant for a human to copy-paste into their terminal.

If your task requires running a command, YOU run it. If it requires starting a service, YOU start it. If it requires checking system state, YOU check it. You are FULLY AUTONOMOUS.

TERMINAL AUTONOMY (CRITICAL):
- When running terminal commands, use flags that avoid interactive prompts:
  - Use \`--yes\`, \`-y\`, \`--force\`, \`--no-input\` where available
  - Use \`DEBIAN_FRONTEND=noninteractive\` for apt commands
  - Pipe \`yes\` into commands that ask for confirmation: \`yes | command\`
  - Use \`--non-interactive\` for composer, ddev, etc.
- For long-running commands (dev servers, watchers), ALWAYS use background mode:
  - Set isBackground: true when calling run_in_terminal for servers/watchers
  - Never run \`npm run dev\`, \`ddev start\`, or similar in foreground — they block forever
- If a terminal command seems to hang (no output for 30+ seconds), it probably needs
  background mode or a timeout. Don't wait — move on and check status later.
- Do NOT rely on terminal approval dialogs being accepted. If a command requires
  user confirmation in VS Code, find an alternative approach or use the \`--yes\` flag.

ERROR RECOVERY (CRITICAL — THIS IS YOUR JOB):
When you encounter errors, DO NOT give up and report them to the user. Instead:
1. **Read the error message carefully.** Most errors tell you exactly what's wrong.
2. **Diagnose the root cause.** Check logs, config files, error output — gather context.
3. **Fix the issue yourself.** Edit config files, install missing dependencies, fix permissions, change ports.
4. **Retry the failed operation.** After fixing, run the command again to verify.
5. **Iterate until it works.** You have 30 rounds of tool calls — use them. Try multiple approaches.

Examples of what you MUST handle autonomously:
- Service won't start → check logs, fix config, restart
- Missing dependency → install it
- Port conflict → change port or stop conflicting service
- Permission denied → fix permissions
- Config error → read docs, fix the config
- Database not initialized → run migrations/setup
- Build fails → read error output, fix the code
- File not found → search for it, or create it if appropriate
- Command not found → install the tool, or find the correct command name
- API/network error → retry with backoff, or skip non-essential steps

You have the same capabilities as any skilled developer at a terminal. USE THEM.
Do NOT report "I encountered an error" and stop. Fix it.

SITUATIONAL AWARENESS (CRITICAL — READ CAREFULLY):
- You will receive a CURRENT WORKSPACE STATE section showing the LIVE directory structure.
  Files and directories listed there ALREADY EXIST. Do NOT recreate them.
- You will receive a COMPLETED SUBTASKS section showing what previous agents have done.
  Do NOT redo their work. Build UPON what they created, using the paths they established.
- If a previous subtask created a directory (e.g., "frontend/"), navigate INTO it — do NOT create
  a new one. Check the workspace snapshot first.
- If you are running in PARALLEL with other agents, you will see their status.
  Avoid modifying files they are likely editing. Each parallel agent has its own worktree.
- BEFORE creating any file or directory, CHECK the workspace snapshot. If it already exists,
  use or modify it instead of creating a duplicate.
- You may receive an ENVIRONMENT TOOLS section listing detected capabilities (DDEV, Docker,
  npm, etc.). These tools are ALREADY INSTALLED. Use the exact commands listed — do NOT
  install alternative tools or workarounds.

HIVE MIND (LIVE AWARENESS):
- You are part of a **hive mind** — a network of agents sharing state in real time.
- Every few rounds, you will receive a 🐝 HIVE MIND UPDATE message injected into your conversation.
  This tells you what other agents have accomplished, what files they created, and what's still running.
  **READ THESE UPDATES CAREFULLY.** They may change what you need to do.
- You also BROADCAST your actions — every tool call you make is logged to a shared journal that
  other agents can read. This means they know what you're doing, just as you know what they're doing.
- If a hive mind update shows that another agent has ALREADY created files or directories you were
  about to create, STOP and integrate their work instead of duplicating it.
- If a hive mind update shows that another agent FAILED, consider whether your task needs to
  compensate or adjust.
- Think of yourself as a neuron in a larger brain — you have your own task, but you are aware of
  and responsive to the collective state.

IF YOU OUTPUT INSTRUCTIONS OR PROSE INSTEAD OF MAKING ACTUAL CHANGES WITH YOUR TOOLS, YOU HAVE FAILED THE TASK.

VERIFICATION LOOP (CRITICAL — THIS IS WHAT SEPARATES GOOD FROM GREAT):
After completing your implementation work, you MUST run a verification loop before finishing.
This is not optional. Do not emit your summary block until verification passes.

The loop:
1. **Identify the right check.** Based on what you just did, pick the appropriate verification:
   - Code changes → run the build/typecheck: \`npx tsc --noEmit\`, \`npm run build\`, etc.
   - Test-related work → run the tests: \`npm test\`, \`pytest\`, etc.
   - Config/infrastructure changes → verify the service works: check endpoints, run smoke tests
   - File creation → verify the files exist and have correct content
   - Dependency installation → verify they resolve: import check, build, or lock file exists

2. **Run the check.** Execute the verification command in the terminal.

3. **If it fails → FIX IT.** Read the error output. Diagnose. Fix. Re-run. Repeat until it passes.
   You have 30 rounds — use them. A task that "works" but doesn't pass its own verification is not done.

4. **If it passes → emit your summary block and finish.**

Common verification commands (use whichever apply):
- TypeScript: \`npx tsc --noEmit\` (typecheck without emitting)
- ESLint: \`npx eslint src/ --quiet\` (lint errors only)
- Node tests: \`npm test\` or \`npx jest --passWithNoTests\`
- Python: \`python -m pytest\` or \`python -c "import module"\`
- Go: \`go build ./...\` and \`go test ./...\`
- Rust: \`cargo check\` and \`cargo test\`
- General: \`git diff --stat\` (confirm you actually changed files)

If the project has no test/build infrastructure, at minimum verify:
- Files you created actually exist (\`ls\` or \`cat\` them)
- Code you wrote has no syntax errors (run interpreter/compiler if available)
- Commands you configured actually work (run them)

DO NOT SKIP VERIFICATION. A completed task without verification is an unverified guess.

`;

const REVIEW_SYSTEM_PROMPT = `You are a pragmatic code review agent. Your job is to evaluate whether a subtask's output meets its success criteria.

Given:
1. The original subtask description
2. The success criteria
3. The output produced

CRITICAL PRINCIPLE — SUBSTANCE OVER CEREMONY:
A subtask that ran 10+ tool-calling rounds, executed terminal commands, got real output from those commands,
and produced a structured summary block has DONE REAL WORK. Do not fail it because:
- It didn't run one more verification command you would have liked
- The output was truncated and you can't see every step
- Some minor criterion wasn't explicitly verified (but the underlying work was done)
- The success criteria used slightly different wording than the output

When a subtask ran real commands (ddev start, npm install, docker compose, etc.) and those commands
produced real output showing success, the task SUCCEEDED. Do not reject work because you wanted
additional confirmation steps that weren't strictly necessary.

REVIEW CHECKLIST — You MUST evaluate ALL of these before making a judgment:

1. **Did real work happen?** The subagent was supposed to USE TOOLS to create files, run commands, and make actual workspace changes. If the output is just instructions, prose, step-by-step guides, or code in markdown blocks telling someone what to do (rather than reporting what was actually done), mark as FAILURE. Look for phrases like "Create a file", "Run the following", "Add this code" — these indicate the agent described work instead of doing it. BUT if you see [Tool: run_in_terminal] entries with real command output, that IS real work.

2. **No user-directed instructions.** If the output contains phrases like "Please run...", "You should...", "The user needs to...", "Ask the user to...", "Tell the user to...", "Make sure to run...", or any other instructions directed at a human rather than a report of actions taken, mark as FAILURE. The agent must ACT, not INSTRUCT.

3. **No stubs or placeholders.** Search for these red flags in any code output:
   - Comments like "// TODO", "// Implement", "// Add logic here", "/* Placeholder */"
   - Empty function bodies or functions returning only hardcoded dummy values
   - Components with "Implement rendering logic here" style comments
   - Hooks or utilities that are skeletal shells without real logic
   If ANY are found in critical functionality, mark as FAILURE.

4. **Success criteria substantially met.** Check each criterion. The key word is SUBSTANTIALLY — if the agent ran the right commands and got the right results, don't fail it because it didn't add one more curl check. If 3 out of 4 criteria are clearly met and the 4th is implied by the work done, mark as SUCCESS.

5. **Code correctness.** Look for:
   - Missing imports or obviously wrong import paths
   - Variables or functions used before definition
   - Type mismatches (in TypeScript)
   - Logic bugs (e.g., event handlers triggering without proper guard conditions)
   - Missing error handling for likely failure points
   - Interfaces/types that don't match between files

6. **Completeness.** Are all requested files, components, and features present? Is anything mentioned in the task description but missing from the output?

Return a JSON object:
{
  "success": true/false,
  "reason": "Specific explanation citing concrete evidence from the output. Reference specific file names, function names, or code patterns you checked.",
  "suggestions": ["Specific actionable improvement 1", "..."],
  "checklist": {
    "realWorkDone": true/false,
    "noUserDirectedInstructions": true/false,
    "noStubs": true/false,
    "criteriaMet": true/false,
    "codeCorrect": true/false,
    "complete": true/false
  }
}

A review that passes everything without citing specific evidence is WRONG. Analyze the output thoroughly.

${FlowCorrectionManager.CORRECTION_SIGNAL_INSTRUCTION}

Return ONLY valid JSON.`;

export class SubagentManager {
    private readonly config = getConfig();

    /** Best-effort check for plain object records. */
    private isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * Normalize tool input schemas to avoid provider-side validation failures.
     * Some providers reject object schemas that omit `properties`.
     */
    private normalizeSchemaNode(node: unknown): void {
        if (!this.isRecord(node)) {
            return;
        }

        if (node.type === 'object') {
            const properties = node.properties;
            if (!this.isRecord(properties)) {
                node.properties = {};
            }
            if (node.additionalProperties === undefined) {
                node.additionalProperties = true;
            }
        }

        if (this.isRecord(node.properties)) {
            for (const child of Object.values(node.properties)) {
                this.normalizeSchemaNode(child);
            }
        }

        if (node.items !== undefined) {
            this.normalizeSchemaNode(node.items);
        }

        for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
            const variants = node[key];
            if (Array.isArray(variants)) {
                for (const variant of variants) {
                    this.normalizeSchemaNode(variant);
                }
            }
        }
    }

    /**
     * Prepare a safe input schema for model/tool registration.
     */
    private sanitizeInputSchema(inputSchema: unknown): object {
        if (!this.isRecord(inputSchema)) {
            return {
                type: 'object',
                properties: {},
                additionalProperties: true,
            };
        }

        const cloned = JSON.parse(JSON.stringify(inputSchema)) as Record<string, unknown>;
        this.normalizeSchemaNode(cloned);
        return cloned;
    }

    private looksLongRunningCommand(command: string): boolean {
        const normalized = command.trim();
        if (!normalized) {
            return false;
        }
        return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
    }

    /**
     * Detect signs of hallucination or garbled output in a text chunk.
     *
     * Returns a reason string if the output looks corrupted, or empty string
     * if it looks normal. Checks for:
     *   1. High ratio of non-ASCII characters (garbled text, wrong encoding)
     *   2. Excessive repetition (model stuck in a loop)
     *   3. Very long lines with no whitespace (binary/encoded data)
     */
    private detectOutputCorruption(text: string): string {
        if (text.length < 100) {
            return '';
        }

        // Check 1: High ratio of non-Latin/non-common characters
        // Normal code/docs should be mostly ASCII with some Unicode
        // Garbled hallucinations often produce Arabic, CJK, or control chars
        const nonAsciiCount = (text.match(/[^\x00-\x7F]/g) || []).length;
        const ratio = nonAsciiCount / text.length;
        if (ratio > 0.3 && text.length > 200) {
            return `Output appears garbled: ${(ratio * 100).toFixed(0)}% non-ASCII characters`;
        }

        // Check 2: Excessive repetition — same 20+ char sequence repeated 5+ times
        // This catches the model getting stuck in a degenerate loop
        if (text.length > 500) {
            const sample = text.substring(text.length - 500);
            for (let len = 20; len <= 100; len += 10) {
                const tail = sample.substring(sample.length - len);
                let count = 0;
                let pos = 0;
                while ((pos = sample.indexOf(tail, pos)) !== -1) {
                    count++;
                    pos += tail.length;
                }
                if (count >= 5) {
                    return `Output contains excessive repetition (${len}-char pattern repeated ${count}x)`;
                }
            }
        }

        // Check 3: Very long lines with no whitespace (likely binary/encoded data)
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.length > 1000 && !line.includes(' ') && !line.includes('\t')) {
                return 'Output contains suspiciously long lines without whitespace (possible binary data)';
            }
        }

        return '';
    }

    /**
     * Detect model safety refusals in output.
     * Returns a reason string if refusal detected, empty string otherwise.
     * A refusal is when the model declines to perform the task entirely
     * (as opposed to encountering an error while trying).
     */
    private detectRefusal(output: string, toolCallCount: number): string {
        // If the model used tools, it was executing — not refusing
        if (toolCallCount > 0) {
            return '';
        }

        const trimmed = output.trim();

        // Very short output with no tool calls is suspicious
        if (trimmed.length === 0) {
            return 'Model produced no output and made no tool calls';
        }

        // Known refusal patterns from Copilot and LLM safety filters
        const refusalPatterns = [
            /^sorry,?\s+i\s+can'?t\s+assist\s+with\s+that\.?$/i,
            /^i'?m\s+not\s+able\s+to\s+help\s+with\s+that\.?$/i,
            /^i\s+cannot\s+assist\s+with\s+that\s+request\.?$/i,
            /^i'?m\s+unable\s+to\s+(complete|do|perform|help\s+with)\s+th/i,
            /^i\s+can'?t\s+help\s+with\s+that\.?$/i,
            /^i'?m\s+sorry,?\s+but\s+i\s+can'?t/i,
        ];

        for (const pattern of refusalPatterns) {
            if (pattern.test(trimmed)) {
                return `Safety refusal detected: "${trimmed.substring(0, 80)}"`;
            }
        }

        // Short output (< 200 chars) without tool calls, containing refusal keywords
        if (
            trimmed.length < 200 &&
            /\b(can'?t|cannot|unable|not able|won'?t)\b.*\b(assist|help|complete|do this)\b/i.test(
                trimmed,
            )
        ) {
            return `Likely refusal: "${trimmed.substring(0, 80)}"`;
        }

        return '';
    }

    private prepareToolInput(
        toolName: string,
        rawInput: unknown,
    ): { input: object; warnings: string[] } {
        const warnings: string[] = [];
        const input = this.isRecord(rawInput) ? { ...rawInput } : {};

        if (toolName === 'run_in_terminal') {
            const command = typeof input.command === 'string' ? input.command : '';
            const isBackground = input.isBackground === true;
            const timeout = typeof input.timeout === 'number' ? input.timeout : 0;

            if (
                this.config.autoBackgroundLongRunningCommands &&
                !isBackground &&
                this.looksLongRunningCommand(command)
            ) {
                input.isBackground = true;
                warnings.push(
                    `Auto-switched \`run_in_terminal\` to background for likely long-running command: ${command.substring(0, 120)}`,
                );
            }

            if (typeof input.timeout !== 'number' || timeout <= 0) {
                input.timeout = this.config.toolInvocationTimeoutMs;
            }
        }

        if (toolName === 'await_terminal') {
            const timeout = typeof input.timeout === 'number' ? input.timeout : 0;
            if (timeout <= 0) {
                input.timeout = this.config.toolInvocationTimeoutMs;
                warnings.push('Capped `await_terminal` timeout to prevent indefinite waiting.');
            }
        }

        return { input, warnings };
    }

    private async invokeToolWithTimeout(
        toolName: string,
        input: object,
        toolToken: vscode.ChatParticipantToolToken | undefined,
        token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const timeoutMs = this.config.toolInvocationTimeoutMs;
        let timer: NodeJS.Timeout | undefined;

        const toolPromise = vscode.lm.invokeTool(
            toolName,
            {
                input,
                toolInvocationToken: toolToken,
            },
            token,
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                reject(
                    new Error(
                        `Tool \"${toolName}\" exceeded ${timeoutMs}ms and was treated as timed out.`,
                    ),
                );
            }, timeoutMs);
        });

        try {
            return await Promise.race([toolPromise, timeoutPromise]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }

    /**
     * Convert tool result content to supported LM message parts.
     */
    private toSupportedToolContent(
        content: readonly unknown[],
    ): (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] {
        const supported: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [];

        for (const item of content) {
            if (
                item instanceof vscode.LanguageModelTextPart ||
                item instanceof vscode.LanguageModelDataPart
            ) {
                supported.push(item);
            } else if (typeof item === 'string') {
                supported.push(new vscode.LanguageModelTextPart(item));
            }
        }

        if (supported.length === 0) {
            supported.push(
                new vscode.LanguageModelTextPart('Tool executed with no textual output.'),
            );
        }

        return supported;
    }

    /**
     * Discover available VS Code LM tools and convert to LanguageModelChatTool format.
     * Filters out tools that aren't useful for coding tasks.
     */
    private getAvailableTools(): vscode.LanguageModelChatTool[] {
        const tools: vscode.LanguageModelChatTool[] = [];

        for (const tool of vscode.lm.tools) {
            if (TOOL_NAME_BLOCKLIST.has(tool.name)) {
                continue;
            }

            tools.push({
                name: tool.name,
                description: tool.description,
                inputSchema: this.sanitizeInputSchema(tool.inputSchema),
            });
        }

        return tools;
    }

    /**
     * Execute a single subtask using the given model.
     * Runs a full agentic tool-calling loop:
     *   1. Send prompt + tool definitions to the model
     *   2. If the model returns tool calls, execute them via vscode.lm.invokeTool()
     *   3. Feed tool results back as messages
     *   4. Repeat until the model produces a final text-only response
     *   5. Return the accumulated text output
     */
    async executeSubtask(
        subtask: Subtask,
        modelInfo: ModelInfo,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog,
        toolToken?: vscode.ChatParticipantToolToken,
        ledger?: ExecutionLedger,
        skills?: Skill[],
        messageBus?: MessageBus,
        hookRunner?: HookRunner,
        rateLimitGuard?: RateLimitGuard,
        delegationGuard?: DelegationGuard,
        skillDocs?: SkillDoc[],
        priorAttempts?: Array<{ modelId: string; output: string; reason: string }>,
    ): Promise<SubtaskResult> {
        const startTime = Date.now();

        try {
            // Capture fresh workspace snapshot if ledger is available
            let dynamicContext = workspaceContext;
            if (ledger?.isReady()) {
                // Snapshot the directory the subagent will operate in
                const snapshotDir = subtask.worktreePath || undefined;
                const freshSnapshot = await ledger.captureWorkspaceSnapshot(snapshotDir);
                // Build rich execution context from the ledger
                const ledgerContext = ledger.buildContextForSubagent(
                    subtask.id,
                    freshSnapshot,
                    true,
                );
                // Dynamic context = ledger context + original workspace metadata
                dynamicContext = ledgerContext + '\n\n' + workspaceContext;
            }

            // Build the prompt with context from dependencies + dynamic ledger state
            const prompt = this.buildSubagentPrompt(
                subtask,
                dependencyResults,
                dynamicContext,
                skills,
                skillDocs,
                priorAttempts,
            );

            // Discover available tools
            const tools = this.getAvailableTools();

            const options: vscode.LanguageModelChatRequestOptions = {
                tools: tools.length > 0 ? tools : undefined,
                toolMode: tools.length > 0 ? vscode.LanguageModelChatToolMode.Auto : undefined,
            };

            // Build the conversation messages — will grow as we loop
            const messages: vscode.LanguageModelChatMessage[] = [
                vscode.LanguageModelChatMessage.User(prompt),
            ];

            // Open a collapsible log section
            if (stream) {
                stream.markdown(
                    `\n<details><summary>📋 ${subtask.title} — <code>${modelInfo.name}</code> output</summary>\n\n`,
                );
            }

            let fullOutput = '';
            let round = 0;
            let totalToolCalls = 0;
            let consecutiveTextRounds = 0;

            // Get complexity-aware limits for this subtask
            const limits = getLimitsForComplexity(subtask.complexity);
            const maxToolRounds = limits.maxToolRounds;
            const maxConsecutiveTextRounds = limits.maxConsecutiveTextRounds;
            const maxTotalOutputChars = limits.maxTotalOutputChars;

            // === AGENTIC TOOL-CALLING LOOP ===
            while (round < maxToolRounds) {
                if (token.isCancellationRequested) {
                    break;
                }

                // Guard: abort if total output is getting too large
                if (fullOutput.length > maxTotalOutputChars) {
                    if (stream) {
                        stream.markdown(
                            `\n> ⚠️ Output limit reached (${(fullOutput.length / 1000).toFixed(0)}KB). Stopping execution.\n`,
                        );
                    }
                    fullOutput +=
                        '\n[OUTPUT LIMIT REACHED — execution stopped to prevent runaway output]';
                    break;
                }

                round++;

                const callStart = Date.now();
                // Use rate limit guard if available, otherwise call sendRequest directly
                let response: vscode.LanguageModelChatResponse;
                if (rateLimitGuard) {
                    const guarded = await rateLimitGuard.guardedSendRequest(
                        modelInfo.model,
                        modelInfo.family,
                        messages,
                        options,
                        token,
                        stream,
                    );
                    response = guarded.response;
                } else {
                    response = await modelInfo.model.sendRequest(messages, options, token);
                }

                // Collect text parts and tool call parts from the response stream
                const toolCalls: vscode.LanguageModelToolCallPart[] = [];
                let roundText = '';

                for await (const part of response.stream) {
                    if (part instanceof vscode.LanguageModelTextPart) {
                        roundText += part.value;
                        fullOutput += part.value;
                        if (stream) {
                            stream.markdown(part.value);
                        }
                    } else if (part instanceof vscode.LanguageModelToolCallPart) {
                        toolCalls.push(part);
                    }
                }

                // Debug log this round
                if (debugLog) {
                    const toolCallSummary =
                        toolCalls.length > 0
                            ? ` | Tool calls: ${toolCalls.map((tc) => tc.name).join(', ')}`
                            : '';
                    await debugLog.logLLMCall({
                        timestamp: new Date(callStart).toISOString(),
                        phase: 'subtask-execution',
                        label: `${subtask.title} (round ${round}${toolCallSummary})`,
                        model: modelInfo.id || modelInfo.name || 'unknown',
                        promptMessages:
                            round === 1
                                ? [prompt]
                                : [
                                      `(continuation round ${round}, ${messages.length} messages in context)`,
                                  ],
                        responseText:
                            roundText +
                            (toolCalls.length > 0 ? `\n[${toolCalls.length} tool call(s)]` : ''),
                        durationMs: Date.now() - callStart,
                    });
                }

                // === HIVE SIGNAL EXTRACTION ===
                // Parse HIVE_SIGNAL patterns from model output and forward to message bus
                if (roundText.length > 0 && messageBus) {
                    const signals = parseHiveSignals(roundText);
                    if (signals.length > 0) {
                        await messageBus.processSignals(subtask.id, signals);
                    }
                }

                // === HALLUCINATION / CORRUPTION GUARD ===
                // Check if the model's output looks garbled or corrupted.
                // If so, abort immediately — continuing will only make it worse.
                if (roundText.length > 0) {
                    const corruptionReason = this.detectOutputCorruption(roundText);
                    if (corruptionReason) {
                        if (stream) {
                            stream.markdown(
                                `\n> 🛑 **Output corruption detected:** ${corruptionReason}. Aborting subtask.\n`,
                            );
                        }
                        fullOutput += `\n[ABORTED: ${corruptionReason}]`;

                        if (debugLog) {
                            await debugLog.logEvent(
                                'other',
                                `Corruption detected in subtask ${subtask.id}: ${corruptionReason}`,
                            );
                        }

                        // Close section and return failure
                        if (stream) {
                            stream.markdown('\n\n</details>\n\n');
                        }

                        return {
                            success: false,
                            modelUsed: modelInfo.id,
                            output: fullOutput,
                            reviewNotes: `Aborted due to output corruption: ${corruptionReason}`,
                            durationMs: Date.now() - startTime,
                            timestamp: new Date().toISOString(),
                        };
                    }

                    // === DELEGATION RUNAWAY DETECTION ===
                    // In johann-only mode, check if the model is attempting to
                    // self-delegate. If signals exceed the threshold, the guard
                    // freezes and we abort the subtask.
                    if (delegationGuard) {
                        delegationGuard.checkForRunaway(roundText);
                        if (delegationGuard.isFrozen) {
                            if (stream) {
                                stream.markdown(
                                    '\n> 🛑 **Delegation runaway detected.** Model is attempting to self-delegate. Aborting subtask.\n',
                                );
                            }
                            fullOutput +=
                                '\n[ABORTED: delegation runaway detected — model is attempting to self-delegate]';

                            if (debugLog) {
                                await debugLog.logEvent(
                                    'other',
                                    `Delegation runaway in subtask ${subtask.id}: guard frozen`,
                                );
                            }

                            if (stream) {
                                stream.markdown('\n\n</details>\n\n');
                            }

                            return {
                                success: false,
                                modelUsed: modelInfo.id,
                                output: fullOutput,
                                reviewNotes:
                                    'Aborted: delegation runaway detected — model attempted to self-delegate',
                                durationMs: Date.now() - startTime,
                                timestamp: new Date().toISOString(),
                            };
                        }
                    }
                }

                // If no tool calls, the model is done — break out of the loop
                if (toolCalls.length === 0) {
                    // Track consecutive text-only rounds to detect rambling models
                    consecutiveTextRounds++;
                    if (
                        consecutiveTextRounds >= maxConsecutiveTextRounds &&
                        round < maxToolRounds
                    ) {
                        // The model has produced text without tool calls multiple times
                        // in a row. It's probably rambling. Force exit.
                        if (stream) {
                            stream.markdown(
                                `\n> ⚠️ ${consecutiveTextRounds} consecutive text-only rounds with no tool usage. Stopping.\n`,
                            );
                        }
                        fullOutput +=
                            '\n[STOPPED: model produced only text without tool calls for multiple rounds]';
                        break;
                    }
                    // Not yet at the limit — continue the loop to give the model
                    // another chance to produce tool calls
                    continue;
                }

                // Reset consecutive text round counter since we got tool calls
                consecutiveTextRounds = 0;

                totalToolCalls += toolCalls.length;

                // Add the assistant's response (with tool calls) to the conversation
                const assistantParts: (
                    | vscode.LanguageModelTextPart
                    | vscode.LanguageModelToolCallPart
                )[] = [];
                if (roundText) {
                    assistantParts.push(new vscode.LanguageModelTextPart(roundText));
                }
                for (const tc of toolCalls) {
                    assistantParts.push(tc);
                }
                messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

                // Execute each tool call and feed all results back in one user turn
                const toolResultParts: vscode.LanguageModelToolResultPart[] = [];
                const missingCallIdWarnings: string[] = [];

                for (const tc of toolCalls) {
                    if (token.isCancellationRequested) {
                        break;
                    }

                    try {
                        const prepared = this.prepareToolInput(tc.name, tc.input);

                        if (stream) {
                            stream.markdown(`\n> 🔧 Calling tool: \`${tc.name}\`\n`);
                            for (const warning of prepared.warnings) {
                                stream.markdown(`> ⚠️ ${warning}\n`);
                            }
                        }

                        const toolResult = await this.invokeToolWithTimeout(
                            tc.name,
                            prepared.input,
                            toolToken,
                            token,
                        );

                        // Extract text content from the tool result for logging
                        const resultText = this.extractToolResultText(toolResult);

                        if (stream && resultText) {
                            // Show a short summary of the tool result
                            const preview =
                                resultText.length > 200
                                    ? resultText.substring(0, 200) + '…'
                                    : resultText;
                            stream.markdown(`> ✅ Result: ${preview}\n\n`);
                        }

                        fullOutput += `\n[Tool: ${tc.name}] ${resultText}\n`;

                        if (!tc.callId) {
                            missingCallIdWarnings.push(
                                `Tool "${tc.name}" returned without a callId.`,
                            );
                            // Output was already captured in fullOutput above
                            continue;
                        }

                        toolResultParts.push(
                            new vscode.LanguageModelToolResultPart(
                                tc.callId,
                                this.toSupportedToolContent(toolResult.content),
                            ),
                        );
                    } catch (toolErr) {
                        const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);

                        if (stream) {
                            stream.markdown(
                                `\n> ❌ Tool \`${tc.name}\` failed: ${errMsg.substring(0, 150)}\n\n`,
                            );
                        }

                        fullOutput += `\n[Tool: ${tc.name}] ERROR: ${errMsg}\n`;

                        if (!tc.callId) {
                            missingCallIdWarnings.push(
                                `Tool "${tc.name}" failed and had no callId: ${errMsg}`,
                            );
                            // Error info already captured in fullOutput above
                            continue;
                        }

                        toolResultParts.push(
                            new vscode.LanguageModelToolResultPart(tc.callId, [
                                new vscode.LanguageModelTextPart(
                                    `Error executing tool "${tc.name}": ${errMsg}`,
                                ),
                            ]),
                        );
                    }
                }

                if (toolResultParts.length > 0) {
                    messages.push(vscode.LanguageModelChatMessage.User(toolResultParts));
                }
                if (missingCallIdWarnings.length > 0) {
                    messages.push(
                        vscode.LanguageModelChatMessage.User(missingCallIdWarnings.join('\n')),
                    );
                }

                // ============================================================
                // HIVE MIND — Outbound signal: journal what we just did
                // ============================================================
                if (ledger?.isReady()) {
                    const journalEntries = ledger.buildToolRoundJournalEntry(
                        toolCalls.map((tc) => ({ name: tc.name, input: tc.input })),
                        roundText,
                    );
                    for (const entry of journalEntries) {
                        await ledger.appendJournal(subtask.id, entry);
                    }
                }

                // ============================================================
                // HIVE MIND — Inbound signal: periodic ledger refresh
                // Every HIVE_MIND_REFRESH_INTERVAL rounds, re-read the ledger
                // from disk (the orchestrator may have updated it as other
                // agents complete) and inject a compact update message.
                // ============================================================
                if (
                    ledger?.isReady() &&
                    round % HIVE_MIND_REFRESH_INTERVAL === 0 &&
                    round < maxToolRounds
                ) {
                    try {
                        // Re-read ledger.json from disk to pick up changes from
                        // the orchestrator (other agents completing, etc.)
                        await ledger.reloadFromDisk();

                        // Build a compact update — much smaller than the full
                        // context to avoid bloating the conversation
                        const hiveMindUpdate = ledger.buildMidRoundRefresh(subtask.id, round);

                        // Inject as a user message so the model sees it
                        messages.push(vscode.LanguageModelChatMessage.User(hiveMindUpdate));

                        if (stream) {
                            stream.markdown(`\n> 🐝 Hive mind refresh (round ${round})\n`);
                        }
                    } catch {
                        // Non-critical — agent continues without the update
                    }
                }

                // ============================================================
                // CONTEXT COMPACTION — Compress old rounds to stay in budget
                // When messages exceed a threshold, compress older tool
                // call/result pairs into a compact summary, keeping the
                // system prompt (first message) and recent rounds intact.
                // This prevents context window exhaustion on long-running tasks.
                // ============================================================
                const COMPACTION_THRESHOLD = 12; // messages count to trigger compaction
                const KEEP_RECENT = 6; // keep this many recent messages untouched

                if (messages.length > COMPACTION_THRESHOLD) {
                    // messages[0] is the system/user prompt — always keep it
                    // Compact everything between messages[1] and messages[length - KEEP_RECENT]
                    const compactEnd = messages.length - KEEP_RECENT;
                    if (compactEnd > 1) {
                        const oldMessages = messages.slice(1, compactEnd);

                        // Build a compact summary of the old rounds
                        const compactedLines: string[] = [
                            '=== COMPACTED CONTEXT (earlier tool rounds summarized) ===',
                        ];
                        let toolCallCount = 0;
                        const toolNames = new Set<string>();
                        const keyActions: string[] = [];

                        for (const msg of oldMessages) {
                            // Extract tool call names from assistant messages
                            if (msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
                                for (const part of msg.content) {
                                    if (part instanceof vscode.LanguageModelToolCallPart) {
                                        toolCallCount++;
                                        toolNames.add(part.name);
                                    } else if (
                                        part instanceof vscode.LanguageModelTextPart &&
                                        part.value.trim().length > 0
                                    ) {
                                        // Extract first sentence of assistant reasoning as key action
                                        const firstSentence = part.value
                                            .trim()
                                            .split(/[.\n]/)[0]
                                            .substring(0, 120);
                                        if (firstSentence.length > 10) {
                                            keyActions.push(firstSentence);
                                        }
                                    }
                                }
                            }
                        }

                        compactedLines.push(
                            `Rounds compacted: ${compactEnd - 1} messages → this summary`,
                        );
                        compactedLines.push(
                            `Tool calls made: ${toolCallCount} (${[...toolNames].join(', ')})`,
                        );
                        if (keyActions.length > 0) {
                            compactedLines.push('Key actions taken:');
                            // Keep last 5 key actions to show progression
                            for (const action of keyActions.slice(-5)) {
                                compactedLines.push(`- ${action}`);
                            }
                        }
                        compactedLines.push(
                            'Full details are in the execution log. Continue from where you left off.',
                        );

                        // Replace old messages with a single compact summary
                        const compactMessage = vscode.LanguageModelChatMessage.User(
                            compactedLines.join('\n'),
                        );
                        const originalPrompt = messages[0]; // the system prompt
                        const recentMessages = messages.slice(compactEnd);

                        // Rebuild: [original system prompt, compact summary, recent messages]
                        messages.length = 0;
                        messages.push(
                            originalPrompt, // original system prompt
                            compactMessage, // compacted old rounds
                            ...recentMessages, // recent rounds preserved
                        );

                        if (stream) {
                            stream.markdown(
                                `\n> 🗜️ Context compacted: ${compactEnd - 1} old messages → summary (${messages.length} messages now)\n`,
                            );
                        }
                    }
                }

                // ============================================================
                // CONTEXT LIMIT DETECTION — Pre-compaction flush trigger
                // Estimate token usage and fire on_context_limit when
                // approaching 85% of the model's context window.
                // ============================================================
                if (hookRunner) {
                    // Rough estimate: ~4 chars per token for English text/code
                    const estimatedTokens = Math.ceil(fullOutput.length / 4);
                    const contextLimit = modelInfo.model.maxInputTokens;
                    if (contextLimit && estimatedTokens > contextLimit * 0.85) {
                        await hookRunner.run('on_context_limit', {
                            subtaskId: subtask.id,
                            round,
                            estimatedTokens,
                            contextLimit,
                        });
                    }
                }
            }

            // Close the collapsible section
            if (stream) {
                if (totalToolCalls > 0) {
                    stream.markdown(
                        `\n\n> **${totalToolCalls} tool call(s)** executed across **${round} round(s)**\n`,
                    );
                }
                stream.markdown('\n\n</details>\n\n');
            }

            const durationMs = Date.now() - startTime;

            // === REFUSAL DETECTION ===
            // Catch model safety refusals (e.g., "Sorry, I can't assist with that.")
            // These must be marked as failures immediately — they contain zero useful work
            // and should trigger model escalation, not pass through to review.
            const refusalReason = this.detectRefusal(fullOutput, totalToolCalls);
            if (refusalReason) {
                if (stream) {
                    stream.markdown(`\n> 🚫 **Model refused the task:** ${refusalReason}\n`);
                }
                return {
                    success: false,
                    modelUsed: modelInfo.id,
                    output: fullOutput,
                    reviewNotes: `Model refusal: ${refusalReason}`,
                    durationMs,
                    timestamp: new Date().toISOString(),
                };
            }

            return {
                success: true, // Preliminary — will be reviewed
                modelUsed: modelInfo.id,
                output: fullOutput,
                reviewNotes: '',
                durationMs,
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const classified = classifyError(err);

            let errorMsg: string;
            if (classified.category === 'rate-limit') {
                errorMsg =
                    `Copilot request limit reached during subtask execution. ` +
                    `Increase \`github.copilot.chat.agent.maxRequests\` in VS Code settings. ` +
                    `Original error: ${classified.message}`;
            } else if (classified.category === 'network') {
                errorMsg = `Network error during subtask execution (retries exhausted): ${classified.message}`;
            } else {
                errorMsg = `Execution error: ${classified.message}`;
            }

            // Debug log the failed call
            if (debugLog) {
                await debugLog.logLLMCall({
                    timestamp: new Date(startTime).toISOString(),
                    phase: 'subtask-execution',
                    label: subtask.title,
                    model: modelInfo.id || modelInfo.name || 'unknown',
                    promptMessages: ['(prompt was built but call failed)'],
                    responseText: '',
                    durationMs,
                    error: errorMsg,
                });
            }

            if (stream) {
                stream.markdown(`\n⚠️ ${errorMsg}\n\n</details>\n\n`);
            }

            return {
                success: false,
                modelUsed: modelInfo.id,
                output: '',
                reviewNotes: errorMsg,
                durationMs,
                timestamp: new Date().toISOString(),
            };
        }
    }

    /**
     * Extract readable text from a LanguageModelToolResult.
     */
    private extractToolResultText(result: vscode.LanguageModelToolResult): string {
        const parts: string[] = [];
        for (const item of result.content) {
            if (item instanceof vscode.LanguageModelTextPart) {
                parts.push(item.value);
            }
        }
        return parts.join('\n');
    }

    /**
     * Count tool call markers in execution output (e.g., "[Tool: run_in_terminal]").
     * Returns a map of tool names to call counts plus aggregate stats.
     */
    private countToolUsage(output: string): {
        total: number;
        byTool: Map<string, number>;
        roundCount: number;
    } {
        const toolCallRegex = /\[Tool:\s*(\S+)\]/g;
        const byTool = new Map<string, number>();
        let total = 0;
        let match: RegExpExecArray | null;

        while ((match = toolCallRegex.exec(output)) !== null) {
            const name = match[1];
            byTool.set(name, (byTool.get(name) || 0) + 1);
            total++;
        }

        // Estimate round count from round markers or tool call density
        const roundMarkers = output.match(/\(round \d+/g);
        const roundCount = roundMarkers ? roundMarkers.length : Math.ceil(total / 2);

        return { total, byTool, roundCount };
    }

    /**
     * Review a subtask's output against its success criteria.
     * Uses a model to evaluate the output.
     */
    async reviewSubtaskOutput(
        subtask: Subtask,
        result: SubtaskResult,
        reviewModel: vscode.LanguageModelChat,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog,
        selfHealing?: SelfHealingDetector,
    ): Promise<{ success: boolean; reason: string; suggestions: string[] }> {
        // If the execution itself failed, no need to review
        if (!result.success) {
            return {
                success: false,
                reason: result.reviewNotes || 'Execution failed',
                suggestions: [],
            };
        }

        // If no success criteria, assume success
        if (subtask.successCriteria.length === 0) {
            return {
                success: true,
                reason: 'No specific success criteria defined — output accepted.',
                suggestions: [],
            };
        }

        // Gather execution metadata BEFORE truncation so we count ALL tool calls
        const toolUsage = this.countToolUsage(result.output);
        const hasSummaryBlock =
            /```summary/i.test(result.output) ||
            /^\s*(?:#{1,3}\s*)?(?:COMPLETED|SUMMARY|DONE)[:\s]/im.test(result.output);
        const hasFileCreation =
            /\[Tool:\s*(copilot_createFile|create_file)\]/i.test(result.output) ||
            /\[Tool:\s*run_in_terminal\].*?(cat|echo|tee|>>|>)\s/i.test(result.output);

        // Detect explicit "COMPLETED:" markers in summary blocks or at start of lines
        const hasExplicitCompletion =
            /```summary[\s\S]*?COMPLETED:/i.test(result.output) ||
            /^COMPLETED:/im.test(result.output);

        // == AUTO-PASS: strong success signals make review unnecessary ==

        // Failsafe: Explicit COMPLETED marker with summary block = definite success
        if (hasExplicitCompletion && hasSummaryBlock) {
            if (debugLog) {
                await debugLog.logEvent(
                    'subtask-execution',
                    `[Auto-Pass] Explicit COMPLETED marker detected with summary block - skipping review`,
                );
            }
            return {
                success: true,
                reason: `Auto-approved: Explicit COMPLETED marker detected with summary block. Review skipped to prevent false negatives.`,
                suggestions: [],
            };
        }

        // If the execution ran 6+ tool rounds AND produced a summary block,
        // real work unambiguously happened. Review risks a false negative.
        // (Lowered from 8 to 6 to catch more legitimate completions)
        if (toolUsage.total >= 6 && hasSummaryBlock) {
            if (debugLog) {
                await debugLog.logEvent(
                    'subtask-execution',
                    `[Auto-Pass] ${toolUsage.total} tool calls with summary block - skipping review`,
                );
            }
            return {
                success: true,
                reason: `Auto-approved: ${toolUsage.total} tool calls across ~${toolUsage.roundCount} rounds with a COMPLETED summary block. Real work confirmed without review.`,
                suggestions: [],
            };
        }

        // Smart truncation: prioritize the END of the output (which contains the summary block)
        // but also include the beginning for context
        const MAX_REVIEW_LENGTH = 20000;
        let outputForReview = result.output;

        if (result.output.length > MAX_REVIEW_LENGTH) {
            // Show last 15K chars (includes summary block) + first 4K chars (context)
            // with a clear marker in between
            const endChars = 15000;
            const startChars = 4000;
            const start = result.output.substring(0, startChars);
            const end = result.output.substring(result.output.length - endChars);
            outputForReview =
                start +
                `\n\n... [Output truncated: ${result.output.length - startChars - endChars} chars omitted] ...\n\n` +
                end;
        }

        // Build execution metadata block — gives the review model unambiguous evidence
        const toolSummary = Array.from(toolUsage.byTool.entries())
            .map(([name, count]) => `${name} (${count}x)`)
            .join(', ');

        const metadataBlock = [
            '=== EXECUTION METADATA (AUTOGENERATED — NOT FROM THE AGENT) ===',
            `Total tool calls made: ${toolUsage.total}`,
            `Estimated execution rounds: ${toolUsage.roundCount}`,
            `Tools used: ${toolSummary || 'none detected'}`,
            `Execution duration: ${(result.durationMs / 1000).toFixed(1)}s`,
            `Output length: ${result.output.length} chars`,
            `Summary block present: ${hasSummaryBlock ? 'YES' : 'NO'}`,
            `File creation detected: ${hasFileCreation ? 'YES' : 'NO'}`,
            '',
            'NOTE: This metadata was generated by the orchestrator, not the agent.',
            'If the agent made 8+ tool calls and ran terminal commands, REAL WORK WAS DONE.',
            'Do not mark realWorkDone as false if the metadata shows substantial tool usage.',
            '===',
            '',
        ].join('\n');

        const reviewPrompt = `
=== SUBTASK ===
Title: ${subtask.title}
Description: ${subtask.description}

=== SUCCESS CRITERIA ===
${subtask.successCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}

${metadataBlock}
=== OUTPUT TO REVIEW ===
${outputForReview}
`;

        try {
            const fullReviewPrompt = REVIEW_SYSTEM_PROMPT + '\n\n---\n\n' + reviewPrompt;
            const messages = [vscode.LanguageModelChatMessage.User(fullReviewPrompt)];

            if (stream) {
                stream.markdown(`<details><summary>🔍 Reviewing: ${subtask.title}</summary>\n\n`);
            }

            const reviewOutput = await withRetry(
                async () => {
                    const callStart = Date.now();
                    const response = await reviewModel.sendRequest(messages, {}, token);
                    let text = '';
                    for await (const chunk of response.text) {
                        text += chunk;
                        if (stream) {
                            stream.markdown(chunk);
                        }
                    }

                    // Debug log the review call
                    if (debugLog) {
                        await debugLog.logLLMCall({
                            timestamp: new Date(callStart).toISOString(),
                            phase: 'review',
                            label: `Review: ${subtask.title}`,
                            model: reviewModel.id || reviewModel.name || 'unknown',
                            promptMessages: [fullReviewPrompt],
                            responseText: text,
                            durationMs: Date.now() - callStart,
                        });
                    }

                    return text;
                },
                REVIEW_RETRY_POLICY,
                token,
                // No onRetry callback — reviews are silent about retries
            );

            if (stream) {
                stream.markdown('\n\n</details>\n\n');
            }

            // Parse the review result
            const review = this.parseReviewResult(reviewOutput);

            // Log the review decision for debugging
            if (debugLog) {
                await debugLog.logEvent(
                    'subtask-execution',
                    `[Review Decision] ${review.success ? 'PASSED' : 'FAILED'} - ${review.reason}`,
                );
            }

            // === SELF-HEALING: Detect failure patterns ===
            if (selfHealing && !review.success && reviewOutput) {
                try {
                    // Pass the raw review output (which has the checklist) along with subtask info
                    selfHealing.detectFromReview(
                        subtask.id,
                        subtask.description,
                        this.parseReviewJson(reviewOutput), // Parse just the JSON for checklist analysis
                        result.output,
                    );
                } catch {
                    // Detection failed — non-critical, continue
                }
            }

            return review;
        } catch {
            // If review fails, default to REJECTING the output — don't rubber-stamp
            return {
                success: false,
                reason: 'Review model unavailable — output rejected by default for safety. Re-run to retry.',
                suggestions: [],
            };
        }
    }

    /**
     * Build the full prompt for a subagent, including dependency context
     * and dynamic execution state from the ledger.
     *
     * The workspaceContext parameter may already contain ledger context
     * (current workspace snapshot + completed subtask summaries + parallel
     * agent awareness) if the ExecutionLedger was available. This gives
     * every subagent a real-time view of the orchestration state.
     */
    private buildSubagentPrompt(
        subtask: Subtask,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        skills?: Skill[],
        skillDocs?: SkillDoc[],
        priorAttempts?: Array<{ modelId: string; output: string; reason: string }>,
    ): string {
        const parts: string[] = [];

        parts.push(SUBAGENT_SYSTEM_PREFIX);

        // Inject delegation constraint — tells the model its delegation boundaries
        const delegationPolicy = getDelegationPolicy();
        parts.push(buildDelegationConstraintBlock(delegationPolicy));

        // Inject skill-specific instructions from the new SkillDoc system (with dependency resolution)
        if (subtask.skillHint && skillDocs && skillDocs.length > 0) {
            const resolved = this.resolveSkillWithDependencies(subtask.skillHint, skillDocs);
            if (resolved.length > 0) {
                parts.push('=== SKILL INSTRUCTIONS ===');
                for (const doc of resolved) {
                    parts.push(`--- ${doc.metadata.slug} v${doc.metadata.version} ---`);
                    parts.push(doc.instruction.body);
                    if (doc.instruction.steps && doc.instruction.steps.length > 0) {
                        parts.push('\nSteps:');
                        for (const step of doc.instruction.steps) {
                            parts.push(`- ${step}`);
                        }
                    }
                    parts.push('');
                }
            }
        }
        // Fallback: inject skill from old Skill system if no SkillDoc match
        else if (subtask.skillHint && skills) {
            const skillContent = loadSkillContent(skills, subtask.skillHint);
            if (skillContent) {
                parts.push(`=== SKILL: ${subtask.skillHint} ===`);
                parts.push(skillContent);
                parts.push('');
            }
        }

        if (workspaceContext) {
            parts.push('=== WORKSPACE CONTEXT ===');
            parts.push(workspaceContext);
            parts.push('');
        }

        // If this subtask has an isolated worktree, instruct the subagent to use it
        if (subtask.worktreePath) {
            parts.push('=== ISOLATED WORKING DIRECTORY ===');
            parts.push(`You are operating in a dedicated git worktree at: ${subtask.worktreePath}`);
            parts.push(
                'This is an isolated copy of the codebase on its own branch, created to prevent',
            );
            parts.push('conflicts with other parallel subtasks.');
            parts.push('');
            parts.push('CRITICAL RULES FOR WORKTREE ISOLATION:');
            parts.push(
                `1. ALL file operations (create, edit, delete) MUST target paths under: ${subtask.worktreePath}`,
            );
            parts.push(
                `2. When running terminal commands, ALWAYS cd to the worktree first: cd "${subtask.worktreePath}"`,
            );
            parts.push(
                '3. Do NOT modify files in the main workspace directory — only use your worktree.',
            );
            parts.push(
                '4. Your changes will be automatically committed and merged back to the main branch.',
            );
            parts.push(
                '5. If installing dependencies, run install commands inside the worktree directory.',
            );
            parts.push('');
        }

        // Include distilled results from dependencies (compact, structured)
        if (subtask.dependsOn.length > 0) {
            const hasDeps = subtask.dependsOn.some((depId) => {
                const r = dependencyResults.get(depId);
                return r && r.success;
            });

            if (hasDeps) {
                parts.push('=== DEPENDENCY CONTEXT (distilled) ===');
                for (const depId of subtask.dependsOn) {
                    const depResult = dependencyResults.get(depId);
                    if (depResult && depResult.success) {
                        const summary = extractSummary(depResult.output);
                        const distilled = distillContext(summary, 400);
                        parts.push(`\n[${depId}]`);
                        parts.push(distilled);
                    }
                }
                parts.push('');
            }
        }

        // Inject prior attempt context so retry models know what was already done
        if (priorAttempts && priorAttempts.length > 0) {
            parts.push('=== ⚠️ PRIOR ATTEMPT (THIS IS A RETRY) ===');
            parts.push(
                'A previous model attempted this task but failed. Review what it did and CONTINUE from where it left off.',
            );
            parts.push(
                'DO NOT duplicate work that was already completed (e.g., do not create records, files, or resources that already exist).',
            );
            parts.push(
                'Instead: verify what the previous attempt accomplished, fix any issues, and complete the remaining work.',
            );
            parts.push('');
            for (let i = 0; i < priorAttempts.length; i++) {
                const attempt = priorAttempts[i];
                parts.push(`--- Attempt ${i + 1} (${attempt.modelId}) ---`);
                parts.push(`Failure reason: ${attempt.reason}`);
                // Include a truncated summary of what was done (last 2000 chars most relevant)
                if (attempt.output.length > 0) {
                    const outputSummary =
                        attempt.output.length > 2000
                            ? '...\n' + attempt.output.slice(-2000)
                            : attempt.output;
                    parts.push('What was accomplished:');
                    parts.push(outputSummary);
                }
                parts.push('');
            }
            parts.push('=== END PRIOR ATTEMPT ===');
            parts.push('');
        }

        parts.push('=== YOUR TASK ===');
        parts.push(`**Title:** ${subtask.title}`);
        parts.push(`**Description:** ${subtask.description}`);

        if (subtask.successCriteria.length > 0) {
            parts.push('');
            parts.push('**Success Criteria:**');
            for (const criterion of subtask.successCriteria) {
                parts.push(`- ${criterion}`);
            }
        }

        // Final reminder about workspace awareness
        parts.push('');
        parts.push(
            'REMINDER: Check the CURRENT WORKSPACE STATE above before creating files or directories.',
        );
        parts.push('If a path already exists, use it — do not create duplicates.');

        // Append summary block instruction so the model emits structured metadata
        parts.push(SUMMARY_BLOCK_INSTRUCTION);

        // Append inter-agent communication instructions
        parts.push(HIVE_SIGNAL_INSTRUCTION);

        // If this task has dependencies, teach the agent how to signal upstream corrections
        if (subtask.dependsOn.length > 0) {
            parts.push(FlowCorrectionManager.CORRECTION_SIGNAL_INSTRUCTION);
        }

        return parts.join('\n');
    }

    /**
     * Parse the review model's output into a structured result.
     * Handles both the legacy format and new checklist format.
     */
    private parseReviewResult(rawOutput: string): {
        success: boolean;
        reason: string;
        suggestions: string[];
    } {
        const parsed = this.parseReviewJson(rawOutput);
        if (!parsed) {
            // Fallback to failure if parsing fails
            return {
                success: false,
                reason: 'Could not parse review output — defaulting to failure for safety',
                suggestions: [],
            };
        }

        // If the review includes a checklist, ALL checklist items must pass
        // for the overall review to pass. This prevents rubber-stamp reviews.
        let success = Boolean(parsed.success);
        const checklist = parsed.checklist as Record<string, boolean> | undefined;
        if (checklist && typeof checklist === 'object') {
            const checklistValues = Object.values(checklist);
            const allPassed = checklistValues.every((v) => v === true);
            if (!allPassed && success) {
                // Override: if any checklist item failed, the review fails
                success = false;
                const failedItems = Object.entries(checklist)
                    .filter(([, v]) => v !== true)
                    .map(([k]) => k);
                parsed.reason = `Review checklist failures: ${failedItems.join(', ')}. ${parsed.reason || ''}`;
            }
        }

        // Preserve flow-correction signals from the raw output.
        // These are HTML comments like <!--CORRECTION:taskId:problem:hint-->
        // that live OUTSIDE the JSON block. We append them to `reason` so
        // they survive into result.reviewNotes and the orchestrator can
        // parse them with FlowCorrectionManager.parseCorrectionSignals().
        let reason = String(parsed.reason || '');
        const correctionSignals = rawOutput.match(/<!--CORRECTION:[^>]+-->/g);
        if (correctionSignals && correctionSignals.length > 0) {
            reason += '\n' + correctionSignals.join('\n');
        }

        return {
            success,
            reason,
            suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
        };
    }

    /**
     * Parse just the JSON from review output.
     * Returns the parsed object or undefined if parsing fails.
     */
    private parseReviewJson(rawOutput: string): Record<string, unknown> | undefined {
        try {
            let jsonStr = rawOutput.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                jsonStr = jsonMatch[1].trim();
            }

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(jsonStr);
            } catch {
                const objMatch = rawOutput.match(/\{[\s\S]*\}/);
                if (objMatch) {
                    parsed = JSON.parse(objMatch[0]);
                } else {
                    return undefined;
                }
            }

            return parsed;
        } catch {
            return undefined;
        }
    }

    /**
     * Resolve a skill and all its transitive dependencies from the SkillDoc array.
     * Returns the skill bundle in dependency-first order (dependencies before the skill itself).
     * Cycle-safe via visited set.
     */
    private resolveSkillWithDependencies(slug: string, allSkills: SkillDoc[]): SkillDoc[] {
        const bySlug = new Map<string, SkillDoc>();
        for (const s of allSkills) {
            bySlug.set(s.metadata.slug, s);
        }

        const result: SkillDoc[] = [];
        const visited = new Set<string>();

        const resolve = (current: string): void => {
            if (visited.has(current)) {
                return;
            }
            visited.add(current);
            const doc = bySlug.get(current);
            if (!doc) {
                return;
            }
            // Resolve dependencies first
            if (doc.applies_to.dependencies) {
                for (const dep of doc.applies_to.dependencies) {
                    resolve(dep);
                }
            }
            result.push(doc);
        };

        resolve(slug);
        return result;
    }
}
