import { spawn, ChildProcess } from 'child_process';
import { Readable, Writable } from 'stream';
import * as vscode from 'vscode';
import * as acp from '@agentclientprotocol/sdk';
import { execSync } from 'child_process';
import { Subtask, SubtaskResult, ModelInfo, ToolResult } from './types';
import { DebugConversationLog } from './debugConversationLog';
import { getConfig } from './config';
import { ExecutionLedger, JournalEntry } from './executionLedger';
import { extractSummary, distillContext, SUMMARY_BLOCK_INSTRUCTION } from './contextDistiller';
import { Skill, loadSkillContent } from './skills';
import { SkillDoc } from './skillTypes';
import { MessageBus, HIVE_SIGNAL_INSTRUCTION } from './messageBus';
import { HookRunner } from './hooks';
import { RateLimitGuard } from './rateLimitGuard';
import { getActivityPanel } from './workerActivityPanel';
import { FlowCorrectionManager } from './flowCorrection';
import {
    DelegationGuard,
    buildDelegationConstraintBlock,
    getDelegationPolicy,
} from './delegationPolicy';
import { SelfHealingDetector } from './selfHealing';
import { getLogger } from './logger';

// ============================================================================
// ACP WORKER MANAGER — Spawns persistent Copilot CLI workers via ACP
//
// Replaces the old SubagentManager's LanguageModelChat-based execution with
// real Copilot CLI agents that have full tool access (file creation, editing,
// terminal commands, search) natively. Workers are spawned as child processes
// using the Agent Client Protocol (ACP) over stdio.
//
// Key differences from old SubagentManager:
// - Workers are real Copilot agent processes, not in-process LLM API calls
// - Full tool access without toolToken threading
// - Workers persist after task completion (idle state) for follow-up queries
// - Process isolation — a hung worker doesn't block the extension host
// - Model selection via CLI --model flag
// ============================================================================

/**
 * Map Copilot tool kinds to auto-approve categories.
 * These are the tool kinds that ACP workers can use without manual permission.
 */
const AUTO_APPROVE_TOOL_KINDS = new Set([
    'read',
    'fetch',
    'create_file',
    'write',
    'edit',
    'replace_string_in_file',
    'run_in_terminal',
    'execute',
    'search',
    'list_directory',
    'get_file_contents',
]);

/**
 * Runtime data for a live ACP worker.
 */
interface WorkerRuntime {
    process: ChildProcess;
    connection: acp.ClientSideConnection;
    outputs: string[];
    logs: string[];
    progress: number;
    lastMessage: string;
    lastActivity: number;
    startTime: number;
    sessionId?: string;
}

/**
 * The system prefix baked into every ACP worker's preprompt.
 * This is the same SUBAGENT_SYSTEM_PREFIX from the old SubagentManager,
 * carrying forward all the hard-won prompt engineering.
 */
const WORKER_SYSTEM_PREFIX = `You are a GitHub Copilot coding agent executing a specific subtask assigned to you by an orchestrator.

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
5. **Iterate until it works.** You have plenty of tool rounds — use them. Try multiple approaches.

SITUATIONAL AWARENESS (CRITICAL — READ CAREFULLY):
- You will receive a CURRENT WORKSPACE STATE section showing the LIVE directory structure.
  Files and directories listed there ALREADY EXIST. Do NOT recreate them.
- You will receive a COMPLETED SUBTASKS section showing what previous agents have done.
  Do NOT redo their work. Build UPON what they created, using the paths they established.
- BEFORE creating any file or directory, CHECK the workspace snapshot. If it already exists,
  use or modify it instead of creating a duplicate.

HIVE MIND (LIVE AWARENESS):
- You are part of a **hive mind** — a network of agents sharing state in real time.
- If other agents have completed tasks, you will see their summaries. Use this context.

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
   You have many rounds — use them. A task that "works" but doesn't pass its own verification is not done.

4. **If it passes → emit your summary block and finish.**

DO NOT SKIP VERIFICATION. A completed task without verification is an unverified guess.

`;

/**
 * Review system prompt — same as old SubagentManager.
 */
const REVIEW_SYSTEM_PROMPT = `You are a pragmatic code review agent. Your job is to evaluate whether a subtask's output meets its success criteria.

Given:
1. The original subtask description
2. The success criteria
3. The output produced

CRITICAL PRINCIPLE — OBJECTIVE EVIDENCE OVER INTERPRETATION:

If the worker's output shows OBJECTIVE EVIDENCE of success:
- HTTP 200/201 responses from curl checks
- Exit code 0 from verification commands (build, test, typecheck)
- Filesystem confirmation showing created files exist
- Service status checks showing "active" or "running"
- Plugin/theme status showing "active"
- Database queries returning expected results

Then the task SUCCEEDED, regardless of:
- File organization preferences (project root vs subdirectory)
- Code style preferences (both valid approaches)
- Whether the approach matched what you would have done
- Minor cosmetic issues (formatting, naming)
- Exact wording in output vs success criteria

A task that meets its SUCCESS CRITERIA with objective evidence has succeeded. Period.

DO NOT fail a task for:
- WordPress in project root vs wordpress/ subdirectory (both work)
- Using implementation approach A instead of B (if both work)
- Cosmetic file organization or structure
- Preference-based decisions
- Minor omissions if core functionality is verified working

ONLY fail a task if:
- Commands returned non-zero exit codes indicating actual failure
- Required files objectively don't exist
- Services fail to start or respond
- Tests fail with non-zero exit code
- Success criteria objectively not met (verified by commands, not interpretation)

CRITICAL PRINCIPLE — SUBSTANCE OVER CEREMONY:
A subtask that ran multiple tool-calling rounds, executed terminal commands, got real output from those commands,
and produced a structured summary block has DONE REAL WORK. Do not fail it because:
- It didn't run one more verification command you would have liked
- The output was truncated and you can't see every step
- Some minor criterion wasn't explicitly verified (but the underlying work was done)
- The success criteria used slightly different wording than the output

When a subtask ran real commands and those commands produced real output showing success, the task SUCCEEDED.

REVIEW CHECKLIST — You MUST evaluate ALL of these before making a judgment:

1. **Did real work happen?** Look for tool usage evidence: [Tool: ...] entries with real command output.

2. **Objective success evidence?** Look for:
   - Exit code 0 from commands
   - HTTP 200 responses
   - "active" / "running" status output
   - File existence confirmations
   - Service verification passing

3. **No user-directed instructions.** If the output contains phrases like "Please run...", "You should...",
   or any instructions directed at a human rather than a report of actions taken, mark as FAILURE.

4. **No stubs or placeholders.** Search for "// TODO", "// Implement", empty function bodies.
   If ANY are found in critical functionality, mark as FAILURE.

5. **Success criteria substantially met.** The key word is SUBSTANTIALLY — if the agent ran the right
   commands and got the right results, don't fail it for minor omissions or stylistic differences.

6. **Code correctness.** Check for missing imports, type mismatches, logic bugs.

7. **Completeness.** Are all requested files, components, and features present?

Return a JSON object:
{
  "success": true/false,
  "reason": "Specific explanation citing concrete evidence from the output.",
  "suggestions": ["Specific actionable improvement 1", "..."],
  "checklist": {
    "realWorkDone": true/false,
    "objectiveEvidence": true/false,
    "noUserDirectedInstructions": true/false,
    "noStubs": true/false,
    "criteriaMet": true/false,
    "codeCorrect": true/false,
    "complete": true/false
  }
}

${FlowCorrectionManager.CORRECTION_SIGNAL_INSTRUCTION}

Return ONLY valid JSON.`;

/**
 * Complexity-based timeout limits for ACP workers.
 * More complex tasks get more time.
 */
const TIMEOUT_BY_COMPLEXITY: Record<string, number> = {
    trivial: 120_000, // 2 min
    simple: 180_000, // 3 min
    moderate: 300_000, // 5 min
    complex: 600_000, // 10 min
    expert: 900_000, // 15 min
};

export class AcpWorkerManager {
    private readonly config = getConfig();
    private activeWorkers: Map<string, WorkerRuntime> = new Map();

    /** Track all instances for global cleanup (e.g., on extension deactivation). */
    private static instances: Set<AcpWorkerManager> = new Set();

    constructor() {
        AcpWorkerManager.instances.add(this);
    }

    /**
     * Kill all workers across all AcpWorkerManager instances.
     * Called on extension deactivation to prevent orphaned processes.
     */
    static cleanupAllInstances(): void {
        for (const instance of AcpWorkerManager.instances) {
            instance.cleanupAll();
        }
    }

    /**
     * Get count of all active workers across all instances.
     */
    static getActiveWorkerCount(): number {
        let count = 0;
        for (const instance of AcpWorkerManager.instances) {
            count += instance.activeWorkers.size;
        }
        return count;
    }

    /**
     * Find the copilot CLI executable.
     * Checks: env override → PATH → common Node version manager locations.
     */
    private findCopilotExecutable(): string {
        if (process.env.COPILOT_CLI_PATH) {
            return process.env.COPILOT_CLI_PATH;
        }

        // Try PATH first (works when nvm/volta/fnm is loaded in shell)
        try {
            const whichCmd = process.platform === 'win32' ? 'where copilot' : 'which copilot';
            const result = execSync(whichCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
            if (result) {
                return result.split('\n')[0]; // First match on Windows
            }
        } catch {
            // Not in PATH — check version manager locations
        }

        // Check common Node version manager install locations
        // VS Code's extension host often doesn't inherit shell nvm/volta/fnm setup
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (home) {
            const fs = require('fs') as typeof import('fs');
            const path = require('path') as typeof import('path');

            const candidates: string[] = [];

            // nvm (macOS/Linux): ~/.nvm/versions/node/*/bin/copilot
            const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
            const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
            try {
                const versions = fs.readdirSync(nvmVersionsDir).sort().reverse();
                for (const v of versions) {
                    candidates.push(path.join(nvmVersionsDir, v, 'bin', 'copilot'));
                }
            } catch {
                // nvm not installed
            }

            // volta: ~/.volta/bin/copilot
            candidates.push(path.join(home, '.volta', 'bin', 'copilot'));

            // fnm: ~/.local/share/fnm/node-versions/*/installation/bin/copilot
            const fnmDir = path.join(home, '.local', 'share', 'fnm', 'node-versions');
            try {
                const versions = fs.readdirSync(fnmDir).sort().reverse();
                for (const v of versions) {
                    candidates.push(path.join(fnmDir, v, 'installation', 'bin', 'copilot'));
                }
            } catch {
                // fnm not installed
            }

            // Global npm: /usr/local/bin/copilot, /opt/homebrew/bin/copilot
            candidates.push('/usr/local/bin/copilot');
            candidates.push('/opt/homebrew/bin/copilot');

            // Windows: %APPDATA%/npm/copilot.cmd
            if (process.platform === 'win32' && process.env.APPDATA) {
                candidates.push(path.join(process.env.APPDATA, 'npm', 'copilot.cmd'));
            }

            for (const candidate of candidates) {
                try {
                    fs.accessSync(candidate, fs.constants.X_OK);
                    const logger = getLogger();
                    logger.info(`[ACP] Found copilot CLI at: ${candidate}`);
                    return candidate;
                } catch {
                    // Not here, try next
                }
            }
        }

        // Last resort — will fail with a clear error when spawned
        return 'copilot';
    }

    /**
     * Get the project working directory.
     */
    private getProjectDir(subtask: Subtask): string {
        // If subtask has an isolated worktree, use that
        if (subtask.worktreePath) {
            return subtask.worktreePath;
        }
        // Otherwise use the workspace root
        const folders = vscode.workspace.workspaceFolders;
        return folders?.[0]?.uri.fsPath || process.cwd();
    }

    /**
     * Map a ModelInfo to a Copilot CLI model name.
     * The CLI uses model names like 'gpt-4o', 'claude-sonnet-4', etc.
     */
    private mapModelToCliName(modelInfo: ModelInfo): string {
        // The family field from VS Code's model API (e.g., 'gpt-4o', 'claude-3.5-sonnet')
        // needs to be mapped to Copilot CLI's accepted model names.
        const family = modelInfo.family.toLowerCase();
        const id = (modelInfo.id || '').toLowerCase();

        // Copilot CLI accepted models (from `copilot --acp --stdio --model <invalid>` error):
        // claude-sonnet-4.6, claude-sonnet-4.5, claude-haiku-4.5, claude-opus-4.6,
        // claude-opus-4.6-fast, claude-opus-4.5, claude-sonnet-4, gemini-3-pro-preview,
        // gpt-5.3-codex, gpt-5.2-codex, gpt-5.2, gpt-5.1-codex-max, gpt-5.1-codex,
        // gpt-5.1, gpt-5, gpt-5.1-codex-mini, gpt-5-mini, gpt-4.1
        const familyMap: Record<string, string> = {
            // Claude models
            'claude-sonnet-4.6': 'claude-sonnet-4.6',
            'claude-sonnet-4.5': 'claude-sonnet-4.5',
            'claude-haiku-4.5': 'claude-haiku-4.5',
            'claude-opus-4.6': 'claude-opus-4.6',
            'claude-opus-4.5': 'claude-opus-4.5',
            'claude-sonnet-4': 'claude-sonnet-4',
            // Claude family aliases (VS Code API uses different naming)
            'claude-3.5-sonnet': 'claude-sonnet-4',
            'claude-3.5-haiku': 'claude-haiku-4.5',
            // GPT models
            'gpt-5.3-codex': 'gpt-5.3-codex',
            'gpt-5.2-codex': 'gpt-5.2-codex',
            'gpt-5.2': 'gpt-5.2',
            'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
            'gpt-5.1-codex': 'gpt-5.1-codex',
            'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
            'gpt-5.1': 'gpt-5.1',
            'gpt-5': 'gpt-5',
            'gpt-5-mini': 'gpt-5-mini',
            'gpt-4.1': 'gpt-4.1',
            // Legacy model aliases → map to closest available
            'gpt-4o': 'gpt-4.1',
            'gpt-4o-mini': 'gpt-4.1',
            'gpt-4.1-mini': 'gpt-4.1',
            'gpt-4.1-nano': 'gpt-4.1',
            'o3-mini': 'gpt-5-mini',
            'o4-mini': 'gpt-5-mini',
            // Gemini
            'gemini-3-pro-preview': 'gemini-3-pro-preview',
            'gemini-2.5-pro': 'gemini-3-pro-preview',
            'gemini-2.0-flash': 'gemini-3-pro-preview',
        };

        // Try direct family match first
        if (familyMap[family]) {
            return familyMap[family];
        }

        // Try matching from the full model ID (sometimes more specific)
        for (const [key, value] of Object.entries(familyMap)) {
            if (id.includes(key) || family.includes(key)) {
                return value;
            }
        }

        // Default to gpt-4.1 as the cheapest/fastest available
        const logger = getLogger();
        logger.warn(`[ACP] Unknown model family "${family}" (id: "${id}"), defaulting to gpt-4.1`);
        return 'gpt-4.1';
    }

    /**
     * Spawn an ACP worker process and execute a task.
     * Returns when the worker completes its initial prompt.
     * The worker stays alive in idle state for potential follow-up queries.
     */
    private async spawnWorker(
        workerId: string,
        preprompt: string,
        modelName: string,
        projectDir: string,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        timeoutMs: number = 300_000,
    ): Promise<{ output: string; toolCallCount: number; stopReason: string }> {
        const logger = getLogger();

        // Pre-flight check: is the CLI available?
        const { checkCopilotCli, showCliMissingError } = await import('./copilotCliStatus');
        const cliStatus = checkCopilotCli();
        logger.info(
            `[ACP:spawnWorker] CLI status: available=${cliStatus.available}, path="${cliStatus.path || 'none'}", version="${cliStatus.version || 'unknown'}"`,
        );
        if (!cliStatus.available) {
            logger.error(`[ACP:spawnWorker] CLI NOT AVAILABLE — aborting spawn`);
            showCliMissingError(); // fire-and-forget notification
            throw new Error(
                'Copilot CLI is not installed. Run "Johann: Setup Copilot CLI" from the command palette to get started.',
            );
        }

        const executable = this.findCopilotExecutable();

        logger.info(`[ACP:spawnWorker] Executable resolved to: "${executable}"`);
        logger.info(`[ACP:spawnWorker] Args: --acp --stdio --model ${modelName}`);
        logger.info(`[ACP:spawnWorker] CWD: ${projectDir}`);
        logger.info(
            `[ACP] Spawning worker ${workerId}: ${executable} --acp --stdio --model ${modelName}`,
        );

        const workerProcess = spawn(executable, ['--acp', '--stdio', '--model', modelName], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: projectDir,
            env: {
                ...process.env,
                ELECTRON_RUN_AS_NODE: '1',
                NODE_OPTIONS: '',
            },
            detached: true, // Workers can outlive extension host
        });

        workerProcess.unref();

        logger.info(
            `[ACP:spawnWorker] Process spawned — PID: ${workerProcess.pid}, stdin: ${!!workerProcess.stdin}, stdout: ${!!workerProcess.stdout}, stderr: ${!!workerProcess.stderr}`,
        );

        if (!workerProcess.stdin || !workerProcess.stdout) {
            throw new Error('Failed to spawn copilot CLI process with piped stdio');
        }

        logger.info(`[ACP] Worker ${workerId} spawned with PID ${workerProcess.pid}`);

        // Track early exit — if the process dies before ACP connection is established,
        // we need to surface the error instead of hanging forever
        let earlyExitReject: ((err: Error) => void) | undefined;
        const earlyExitPromise = new Promise<never>((_resolve, reject) => {
            earlyExitReject = reject;
        });

        workerProcess.on('error', (err) => {
            logger.error(`[ACP:${workerId}] Process error: ${err.message}`);
            getActivityPanel().logStderr(workerId, `Process error: ${err.message}`);
            if (earlyExitReject) {
                earlyExitReject(new Error(`Copilot CLI process error: ${err.message}`));
                earlyExitReject = undefined;
            }
        });

        workerProcess.on('exit', (code, signal) => {
            if (earlyExitReject) {
                const stderrLogs = this.activeWorkers.get(workerId)?.logs.join('') || '';
                const detail = stderrLogs ? `\nStderr: ${stderrLogs.substring(0, 500)}` : '';
                logger.error(
                    `[ACP:${workerId}] Process exited early (code=${code}, signal=${signal})${detail}`,
                );
                getActivityPanel().logStderr(
                    workerId,
                    `Process exited early (code=${code}, signal=${signal})${detail}`,
                );
                earlyExitReject(
                    new Error(
                        `Copilot CLI exited unexpectedly (code=${code}, signal=${signal})${detail}`,
                    ),
                );
                earlyExitReject = undefined;
            }
        });

        // Capture stderr for diagnostics
        workerProcess.stderr?.on('data', (data) => {
            const text = data.toString();
            const runtime = this.activeWorkers.get(workerId);
            if (runtime) {
                runtime.logs.push(text);
                runtime.lastActivity = Date.now();
            }
            getActivityPanel().logStderr(workerId, text);
        });

        // Create ACP streams
        logger.info(`[ACP:spawnWorker] Creating ACP ndJsonStream...`);
        const output = Writable.toWeb(workerProcess.stdin) as WritableStream<Uint8Array>;
        const input = Readable.toWeb(workerProcess.stdout) as ReadableStream<Uint8Array>;
        const acpStream = acp.ndJsonStream(output, input);
        logger.info(`[ACP:spawnWorker] ACP stream created successfully`);

        // Collected agent messages
        const messages: string[] = [];

        // Terminal management for this worker
        let terminalCounter = 0;
        const terminals = new Map<
            string,
            {
                process: ChildProcess;
                output: string;
                exitStatus: { exitCode?: number | null; signal?: string | null } | null;
                outputByteLimit: number;
                exitPromise: Promise<{ exitCode?: number | null; signal?: string | null }>;
            }
        >();
        let toolCallCount = 0;
        let lastActivityTime = Date.now();

        // Reference to this manager for use in ACP client callbacks
        const managerRef = this;

        // Create ACP client with auto-approve for coding tools
        const acpClient: acp.Client = {
            async requestPermission(params) {
                lastActivityTime = Date.now();
                if (params.toolCall.kind && AUTO_APPROVE_TOOL_KINDS.has(params.toolCall.kind)) {
                    toolCallCount++;
                    logger.info(
                        `[ACP:${workerId}] Tool approved: ${params.toolCall.title} (${params.toolCall.kind})`,
                    );

                    const runtime = managerRef.activeWorkers.get(workerId);
                    if (runtime) {
                        runtime.outputs.push(
                            `[Tool: ${params.toolCall.kind}] ${params.toolCall.title}`,
                        );
                        runtime.lastActivity = Date.now();
                    }

                    if (stream) {
                        stream.markdown(`\n> 🔧 \`${params.toolCall.title}\`\n`);
                    }

                    // Log to activity panel
                    getActivityPanel().logTool(
                        workerId,
                        params.toolCall.kind || 'unknown',
                        params.toolCall.title || '',
                        true,
                    );

                    if (params.options.length > 0) {
                        return {
                            outcome: { outcome: 'selected', optionId: params.options[0].optionId },
                        };
                    }
                    // No options array — use standard 'allow' optionId
                    return { outcome: { outcome: 'selected', optionId: 'allow' } };
                }

                logger.warn(
                    `[ACP:${workerId}] Tool DENIED: ${params.toolCall.title} (${params.toolCall.kind})`,
                );
                getActivityPanel().logTool(
                    workerId,
                    params.toolCall.kind || 'unknown',
                    params.toolCall.title || '',
                    false,
                );
                return { outcome: { outcome: 'cancelled' } };
            },

            async sessionUpdate(params) {
                lastActivityTime = Date.now();
                const update = params.update;

                if (
                    update.sessionUpdate === 'agent_message_chunk' &&
                    update.content.type === 'text'
                ) {
                    messages.push(update.content.text);

                    const runtime = managerRef.activeWorkers.get(workerId);
                    if (runtime) {
                        runtime.outputs.push(update.content.text);
                        runtime.lastMessage = update.content.text;
                        runtime.lastActivity = Date.now();
                        runtime.progress = Math.min(90, messages.length * 3);
                    }

                    if (stream) {
                        stream.markdown(update.content.text);
                    }

                    // Log to activity panel
                    getActivityPanel().logMessage(workerId, update.content.text);
                } else if (update.sessionUpdate === 'tool_call') {
                    logger.info(`[ACP:${workerId}] Tool call: ${update.title} (${update.status})`);
                }
            },

            async readTextFile(params) {
                lastActivityTime = Date.now();
                const fs = require('fs') as typeof import('fs');
                const filePath = params.path;
                logger.info(`[ACP:${workerId}] readTextFile: ${filePath}`);
                toolCallCount++;

                getActivityPanel().logTool(workerId, 'read', filePath, true);

                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    return { content };
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.error(`[ACP:${workerId}] readTextFile failed: ${msg}`);
                    getActivityPanel().logTool(workerId, 'read', `FAILED: ${filePath}`, false);
                    return { content: `Error reading file: ${msg}` };
                }
            },

            async writeTextFile(params) {
                lastActivityTime = Date.now();
                const fs = require('fs') as typeof import('fs');
                const path = require('path') as typeof import('path');
                const filePath = params.path;
                const content = params.content;
                logger.info(
                    `[ACP:${workerId}] writeTextFile: ${filePath} (${content.length} chars)`,
                );
                toolCallCount++;

                getActivityPanel().logTool(workerId, 'write', filePath, true);

                try {
                    // Ensure parent directory exists
                    const dir = path.dirname(filePath);
                    fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(filePath, content, 'utf-8');
                    return {};
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    logger.error(`[ACP:${workerId}] writeTextFile failed: ${msg}`);
                    getActivityPanel().logTool(workerId, 'write', `FAILED: ${filePath}`, false);
                    throw new Error(`Failed to write file: ${msg}`);
                }
            },

            async createTerminal(params) {
                lastActivityTime = Date.now();
                const cp = require('child_process') as typeof import('child_process');
                const termId = `term-${++terminalCounter}`;
                const cmd = params.command;
                const args = params.args || [];
                const cwd = params.cwd || projectDir;
                const byteLimit = params.outputByteLimit || 1024 * 1024; // 1MB default

                logger.info(
                    `[ACP:${workerId}] createTerminal[${termId}]: ${cmd} ${args.join(' ')} (cwd: ${cwd})`,
                );
                toolCallCount++;
                getActivityPanel().logTool(workerId, 'terminal', `${cmd} ${args.join(' ')}`, true);

                // Build env with any extra vars
                const env = { ...process.env };
                if (params.env) {
                    for (const v of params.env) {
                        env[v.name] = v.value;
                    }
                }

                const child = cp.spawn(cmd, args, {
                    cwd,
                    env,
                    shell: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                });

                const exitPromise = new Promise<{
                    exitCode?: number | null;
                    signal?: string | null;
                }>((resolve) => {
                    child.on('exit', (code, sig) => {
                        const status = { exitCode: code, signal: sig?.toString() || null };
                        const termState = terminals.get(termId);
                        if (termState) {
                            termState.exitStatus = status;
                        }
                        resolve(status);
                    });
                    child.on('error', (err) => {
                        logger.error(`[ACP:${workerId}] terminal[${termId}] error: ${err.message}`);
                        const status = { exitCode: -1, signal: null };
                        const termState = terminals.get(termId);
                        if (termState) {
                            termState.exitStatus = status;
                        }
                        resolve(status);
                    });
                });

                const appendOutput = (chunk: Buffer) => {
                    const text = chunk.toString();
                    const termState = terminals.get(termId);
                    if (termState) {
                        termState.output += text;
                        // Truncate from beginning if over limit
                        if (termState.output.length > byteLimit) {
                            termState.output = termState.output.slice(-byteLimit);
                        }
                    }
                };

                child.stdout?.on('data', appendOutput);
                child.stderr?.on('data', appendOutput);

                terminals.set(termId, {
                    process: child,
                    output: '',
                    exitStatus: null,
                    outputByteLimit: byteLimit,
                    exitPromise,
                });

                logger.info(`[ACP:${workerId}] terminal[${termId}] spawned PID=${child.pid}`);
                return { terminalId: termId };
            },

            async terminalOutput(params) {
                lastActivityTime = Date.now();
                const termState = terminals.get(params.terminalId);
                if (!termState) {
                    logger.warn(
                        `[ACP:${workerId}] terminalOutput: unknown terminal ${params.terminalId}`,
                    );
                    return { output: '', truncated: false };
                }
                const truncated = termState.output.length >= termState.outputByteLimit;
                return {
                    output: termState.output,
                    truncated,
                    exitStatus: termState.exitStatus || undefined,
                };
            },

            async waitForTerminalExit(params) {
                lastActivityTime = Date.now();
                const termState = terminals.get(params.terminalId);
                if (!termState) {
                    logger.warn(
                        `[ACP:${workerId}] waitForTerminalExit: unknown terminal ${params.terminalId}`,
                    );
                    return { exitCode: -1, signal: null };
                }
                const result = await termState.exitPromise;
                logger.info(
                    `[ACP:${workerId}] terminal[${params.terminalId}] exited: code=${result.exitCode}, signal=${result.signal}`,
                );
                return result;
            },

            async killTerminal(params) {
                lastActivityTime = Date.now();
                const termState = terminals.get(params.terminalId);
                if (!termState) {
                    return {};
                }
                logger.info(
                    `[ACP:${workerId}] killing terminal ${params.terminalId} (PID=${termState.process.pid})`,
                );
                termState.process.kill('SIGTERM');
                // Force kill after 3s
                setTimeout(() => {
                    try {
                        termState.process.kill('SIGKILL');
                    } catch {
                        // already dead
                    }
                }, 3000);
                return {};
            },

            async releaseTerminal(params) {
                lastActivityTime = Date.now();
                const termState = terminals.get(params.terminalId);
                if (!termState) {
                    return {};
                }
                logger.info(`[ACP:${workerId}] releasing terminal ${params.terminalId}`);
                try {
                    termState.process.kill('SIGTERM');
                } catch {
                    // already dead
                }
                terminals.delete(params.terminalId);
                return {};
            },
        };

        // Create ACP connection
        logger.info(`[ACP:spawnWorker] Creating ClientSideConnection...`);
        const connection = new acp.ClientSideConnection((_agent) => acpClient, acpStream);
        logger.info(`[ACP:spawnWorker] ClientSideConnection created`);

        // Register worker runtime
        const runtime: WorkerRuntime = {
            process: workerProcess,
            connection,
            outputs: [],
            logs: [],
            progress: 0,
            lastMessage: '',
            lastActivity: Date.now(),
            startTime: Date.now(),
        };
        this.activeWorkers.set(workerId, runtime);

        // Health check interval with stall detection
        const STALL_THRESHOLD_MS = 180_000; // 3 minutes of no activity = stalled
        const healthCheck = setInterval(() => {
            const idleTime = Date.now() - lastActivityTime;
            if (idleTime > STALL_THRESHOLD_MS) {
                const stallError = new Error(
                    `ACP worker stalled: no activity for ${(idleTime / 1000).toFixed(0)}s (threshold: ${STALL_THRESHOLD_MS / 1000}s). ` +
                        `Last activity at: ${new Date(lastActivityTime).toISOString()}`,
                );
                logger.error(`[ACP:${workerId}] ${stallError.message}`);
                // Kill the worker and reject
                this.killWorker(workerId);
                if (earlyExitReject) {
                    earlyExitReject(stallError);
                }
            } else if (idleTime > 60_000) {
                logger.warn(
                    `[ACP:${workerId}] No activity for ${(idleTime / 1000).toFixed(0)}s (not stalled yet)`,
                );
            }
        }, 30_000);

        // Handle cancellation
        const cancelDisposable = token.onCancellationRequested(() => {
            logger.info(`[ACP:${workerId}] Cancellation requested, killing worker`);
            this.killWorker(workerId);
        });

        try {
            // Initialize ACP connection
            logger.info(`[ACP:${workerId}] Initializing ACP connection...`);
            await connection.initialize({
                protocolVersion: acp.PROTOCOL_VERSION,
                clientInfo: {
                    name: 'johann-orchestrator',
                    title: 'Johann Orchestrator (Fugue)',
                    version: '1.0.0',
                },
                clientCapabilities: {
                    fs: {
                        readTextFile: true,
                        writeTextFile: true,
                    },
                    terminal: true,
                },
            });

            // Create session
            logger.info(`[ACP:${workerId}] Creating ACP session...`);
            const sessionResult = await connection.newSession({
                cwd: projectDir,
                mcpServers: [],
            });
            runtime.sessionId = sessionResult.sessionId;
            logger.info(`[ACP:${workerId}] Session created: ${sessionResult.sessionId}`);

            // Send the task prompt with timeout
            logger.info(`[ACP:${workerId}] Sending task prompt...`);

            const promptPromise = connection.prompt({
                sessionId: sessionResult.sessionId,
                prompt: [{ type: 'text', text: preprompt }],
            });

            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                    reject(new Error(`ACP worker timeout: exceeded ${timeoutMs}ms`));
                }, timeoutMs);
            });

            const promptResult = await Promise.race([
                promptPromise,
                timeoutPromise,
                earlyExitPromise,
            ]);
            // If we got here, the prompt completed — clear the early exit handler
            earlyExitReject = undefined;
            logger.info(`[ACP:${workerId}] Completed with stopReason: ${promptResult.stopReason}`);

            // Mark worker as idle (persistent graph node)
            if (runtime) {
                runtime.progress = 100;
            }

            const fullOutput = messages.join('');

            return {
                output: fullOutput,
                toolCallCount,
                stopReason: promptResult.stopReason,
            };
        } finally {
            clearInterval(healthCheck);
            cancelDisposable.dispose();
            // Clean up any lingering terminals
            for (const [termId, termState] of terminals) {
                try {
                    termState.process.kill('SIGTERM');
                } catch {
                    // already dead
                }
                logger.info(`[ACP:${workerId}] cleaned up terminal ${termId}`);
            }
            terminals.clear();
        }
    }

    /**
     * Kill a running worker process.
     */
    killWorker(workerId: string): boolean {
        const runtime = this.activeWorkers.get(workerId);
        if (!runtime) {
            return false;
        }

        if (runtime.process.pid && !runtime.process.killed) {
            runtime.process.kill('SIGTERM');
            setTimeout(() => {
                if (!runtime.process.killed) {
                    runtime.process.kill('SIGKILL');
                }
            }, 2000);
        }

        this.activeWorkers.delete(workerId);
        return true;
    }

    /**
     * Kill all active workers (cleanup on extension deactivation).
     */
    cleanupAll(): void {
        for (const workerId of this.activeWorkers.keys()) {
            this.killWorker(workerId);
        }
    }

    /**
     * Execute a single subtask using an ACP worker.
     *
     * This is the main entry point called by the orchestrator.
     * Same interface as the old SubagentManager.executeSubtask().
     */
    async executeSubtask(
        subtask: Subtask,
        modelInfo: ModelInfo,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog,
        _toolToken?: vscode.ChatParticipantToolToken, // unused — ACP workers have native tool access
        ledger?: ExecutionLedger,
        skills?: Skill[],
        _messageBus?: MessageBus,
        hookRunner?: HookRunner,
        _rateLimitGuard?: RateLimitGuard, // unused — workers manage their own rate limits
        delegationGuard?: DelegationGuard,
        skillDocs?: SkillDoc[],
        priorAttempts?: Array<{ modelId: string; output: string; reason: string }>,
    ): Promise<SubtaskResult> {
        const startTime = Date.now();

        try {
            // Capture fresh workspace snapshot if ledger is available
            let dynamicContext = workspaceContext;
            if (ledger?.isReady()) {
                const snapshotDir = subtask.worktreePath || undefined;
                const freshSnapshot = await ledger.captureWorkspaceSnapshot(snapshotDir);
                const ledgerContext = ledger.buildContextForSubagent(
                    subtask.id,
                    freshSnapshot,
                    true,
                );
                dynamicContext = ledgerContext + '\n\n' + workspaceContext;
            }

            // Build the preprompt
            const preprompt = this.buildWorkerPreprompt(
                subtask,
                dependencyResults,
                dynamicContext,
                skills,
                skillDocs,
                priorAttempts,
                delegationGuard,
            );

            // Map model to CLI model name
            const cliModel = this.mapModelToCliName(modelInfo);
            const projectDir = this.getProjectDir(subtask);
            const workerId = `${subtask.id}-${Date.now()}`;

            const logger = getLogger();
            logger.info(`[ACP:executeSubtask] === STARTING SUBTASK: "${subtask.title}" ===`);
            logger.info(
                `[ACP:executeSubtask] Model from picker: family="${modelInfo.family}", id="${modelInfo.id}", name="${modelInfo.name}"`,
            );
            logger.info(`[ACP:executeSubtask] Mapped CLI model: "${cliModel}"`);
            logger.info(`[ACP:executeSubtask] Project dir: "${projectDir}"`);
            logger.info(`[ACP:executeSubtask] Worker ID: "${workerId}"`);
            logger.info(`[ACP:executeSubtask] Preprompt length: ${preprompt.length} chars`);

            // Determine timeout from complexity
            const timeoutMs =
                TIMEOUT_BY_COMPLEXITY[subtask.complexity] || TIMEOUT_BY_COMPLEXITY['moderate'];

            // Open collapsible section in chat
            if (stream) {
                stream.markdown(
                    `\n<details><summary>📋 ${subtask.title} — <code>${modelInfo.name}</code> (ACP worker)</summary>\n\n`,
                );
            }

            // Log the execution start
            if (debugLog) {
                await debugLog.logEvent(
                    'subtask-execution',
                    `[ACP] Starting worker for "${subtask.title}" with model ${cliModel} (timeout: ${timeoutMs}ms)`,
                );
            }

            // Fire before hook
            if (hookRunner) {
                await hookRunner.run('on_context_limit', {
                    subtaskId: subtask.id,
                    round: 0,
                    estimatedTokens: preprompt.length / 4,
                    contextLimit: modelInfo.model.maxInputTokens || 128_000,
                });
            }

            // Spawn and execute
            const panel = getActivityPanel();
            panel.startWorker(workerId, subtask.title, cliModel);

            // Render a log button in chat if we have a stream
            if (stream) {
                panel.renderLogButton(stream, workerId);
            }

            const result = await this.spawnWorker(
                workerId,
                preprompt,
                cliModel,
                projectDir,
                token,
                stream,
                timeoutMs,
            );

            const durationMs = Date.now() - startTime;

            // Close collapsible section
            if (stream) {
                if (result.toolCallCount > 0) {
                    stream.markdown(
                        `\n\n> **${result.toolCallCount} tool call(s)** | Stop reason: ${result.stopReason}\n`,
                    );
                }
                stream.markdown('\n\n</details>\n\n');
            }

            // Debug log
            if (debugLog) {
                await debugLog.logLLMCall({
                    timestamp: new Date(startTime).toISOString(),
                    phase: 'subtask-execution',
                    label: `[ACP] ${subtask.title}`,
                    model: cliModel,
                    promptMessages: [preprompt.substring(0, 2000) + '...'],
                    responseText: result.output.substring(0, 5000),
                    durationMs,
                });
            }

            // Refusal detection — if no tool calls and very short output
            const refusalReason = this.detectRefusal(result.output, result.toolCallCount);
            if (refusalReason) {
                if (stream) {
                    stream.markdown(`\n> 🚫 **Model refused:** ${refusalReason}\n`);
                }
                panel.finishWorker(workerId, 'failed', `Model refused: ${refusalReason}`);
                return {
                    success: false,
                    modelUsed: cliModel,
                    output: result.output,
                    reviewNotes: `Model refusal: ${refusalReason}`,
                    durationMs,
                    timestamp: new Date().toISOString(),
                };
            }

            // Journal to ledger
            if (ledger?.isReady()) {
                const journalEntry: JournalEntry = {
                    timestamp: new Date().toISOString(),
                    type: 'note',
                    description: `[ACP Worker ${workerId}] ${result.toolCallCount} tool calls, stopReason: ${result.stopReason}`,
                };
                await ledger.appendJournal(subtask.id, journalEntry);
            }

            // Parse tool responses for ground-truth verification
            const toolResults = this.parseToolResponses(result.output);

            // Check for command failures based on exit codes
            const failedCommands = toolResults.filter(
                (t) => t.tool === 'run_in_terminal' && t.exitCode !== undefined && t.exitCode !== 0,
            );

            // If we have exit codes, use them to determine success
            // Otherwise, default to true (will be reviewed)
            const hadCommandFailures = failedCommands.length > 0;

            if (hadCommandFailures && debugLog) {
                await debugLog.logEvent(
                    'subtask-execution',
                    `[ACP] Detected ${failedCommands.length} failed command(s) via exit codes`,
                );
            }

            panel.finishWorker(
                workerId,
                hadCommandFailures ? 'failed' : 'completed',
                `${result.toolCallCount} tool calls in ${(durationMs / 1000).toFixed(1)}s`,
            );

            return {
                success: !hadCommandFailures, // Ground truth from exit codes
                modelUsed: cliModel,
                output: result.output,
                reviewNotes: hadCommandFailures
                    ? `${failedCommands.length} command(s) failed with non-zero exit codes`
                    : '',
                durationMs,
                timestamp: new Date().toISOString(),
                toolResults, // Include for orchestrator verification
            };
        } catch (err) {
            const durationMs = Date.now() - startTime;
            const errorMsg = err instanceof Error ? err.message : String(err);
            const errorStack = err instanceof Error ? err.stack : '';

            const logger = getLogger();
            logger.error(`[ACP:executeSubtask] === SUBTASK FAILED: "${subtask.title}" ===`);
            logger.error(`[ACP:executeSubtask] Error: ${errorMsg}`);
            logger.error(`[ACP:executeSubtask] Stack: ${errorStack}`);
            logger.error(`[ACP:executeSubtask] Duration: ${durationMs}ms`);

            if (debugLog) {
                await debugLog.logLLMCall({
                    timestamp: new Date(startTime).toISOString(),
                    phase: 'subtask-execution',
                    label: `[ACP] ${subtask.title}`,
                    model: modelInfo.id || modelInfo.name || 'unknown',
                    promptMessages: ['(worker failed to execute)'],
                    responseText: '',
                    durationMs,
                    error: errorMsg,
                });
            }

            if (stream) {
                stream.markdown(`\n⚠️ ACP worker error: ${errorMsg}\n\n</details>\n\n`);
            }

            // Best-effort log — worker may not have been registered if spawn failed
            try {
                getActivityPanel().finishWorker(`${subtask.id}-unknown`, 'failed', errorMsg);
            } catch {
                // Activity panel logging is non-critical
            }

            return {
                success: false,
                modelUsed: modelInfo.id,
                output: '',
                reviewNotes: `ACP worker error: ${errorMsg}`,
                durationMs,
                timestamp: new Date().toISOString(),
            };
        }
    }

    /**
     * Review a subtask's output against its success criteria.
     * Uses a VS Code LanguageModelChat for review (review doesn't need tools).
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
        // If execution failed, no review needed
        if (!result.success) {
            return {
                success: false,
                reason: result.reviewNotes || 'Execution failed',
                suggestions: [],
            };
        }

        // No success criteria → assume success
        if (subtask.successCriteria.length === 0) {
            return {
                success: true,
                reason: 'No specific success criteria defined — output accepted.',
                suggestions: [],
            };
        }

        // Count tool usage from output markers
        const toolUsage = this.countToolUsage(result.output);
        const hasSummaryBlock =
            /```summary/i.test(result.output) ||
            /^\s*(?:#{1,3}\s*)?(?:COMPLETED|SUMMARY|DONE)[:\s]/im.test(result.output);

        // Auto-pass: heavy tool usage + summary block = real work confirmed
        if (toolUsage.total >= 8 && hasSummaryBlock) {
            return {
                success: true,
                reason: `Auto-approved: ${toolUsage.total} tool calls with COMPLETED summary. Real work confirmed.`,
                suggestions: [],
            };
        }

        // Smart truncation for review
        const MAX_REVIEW_LENGTH = 20000;
        let outputForReview = result.output;
        if (result.output.length > MAX_REVIEW_LENGTH) {
            const endChars = 15000;
            const startChars = 4000;
            outputForReview =
                result.output.substring(0, startChars) +
                `\n\n... [${result.output.length - startChars - endChars} chars omitted] ...\n\n` +
                result.output.substring(result.output.length - endChars);
        }

        // Build execution metadata
        const toolSummary = Array.from(toolUsage.byTool.entries())
            .map(([name, count]) => `${name} (${count}x)`)
            .join(', ');

        const metadataBlock = [
            '=== EXECUTION METADATA (AUTOGENERATED) ===',
            `Total tool calls: ${toolUsage.total}`,
            `Tools used: ${toolSummary || 'none detected'}`,
            `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
            `Output length: ${result.output.length} chars`,
            `Summary block: ${hasSummaryBlock ? 'YES' : 'NO'}`,
            `Execution backend: ACP (persistent Copilot CLI worker)`,
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

            const callStart = Date.now();
            const response = await reviewModel.sendRequest(messages, {}, token);
            let text = '';
            for await (const chunk of response.text) {
                text += chunk;
                if (stream) {
                    stream.markdown(chunk);
                }
            }

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

            if (stream) {
                stream.markdown('\n\n</details>\n\n');
            }

            const review = this.parseReviewResult(text);

            // Self-healing detection
            if (selfHealing && !review.success) {
                try {
                    const parsed = this.parseReviewJson(text);
                    if (parsed) {
                        selfHealing.detectFromReview(
                            subtask.id,
                            subtask.description,
                            parsed,
                            result.output,
                        );
                    }
                } catch {
                    // Non-critical
                }
            }

            return review;
        } catch {
            return {
                success: false,
                reason: 'Review model unavailable — output rejected by default for safety.',
                suggestions: [],
            };
        }
    }

    /**
     * Build the full preprompt for an ACP worker.
     */
    private buildWorkerPreprompt(
        subtask: Subtask,
        dependencyResults: Map<string, SubtaskResult>,
        workspaceContext: string,
        skills?: Skill[],
        skillDocs?: SkillDoc[],
        priorAttempts?: Array<{ modelId: string; output: string; reason: string }>,
        delegationGuard?: DelegationGuard,
    ): string {
        const parts: string[] = [];

        parts.push(WORKER_SYSTEM_PREFIX);

        // Delegation constraints
        if (delegationGuard) {
            const delegationPolicy = getDelegationPolicy();
            parts.push(buildDelegationConstraintBlock(delegationPolicy));
        }

        // Skill instructions (new SkillDoc system with dependency resolution)
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
        } else if (subtask.skillHint && skills) {
            const skillContent = loadSkillContent(skills, subtask.skillHint);
            if (skillContent) {
                parts.push(`=== SKILL: ${subtask.skillHint} ===`);
                parts.push(skillContent);
                parts.push('');
            }
        }

        // Workspace context
        if (workspaceContext) {
            parts.push('=== WORKSPACE CONTEXT ===');
            parts.push(workspaceContext);
            parts.push('');
        }

        // Worktree isolation instructions
        if (subtask.worktreePath) {
            parts.push('=== ISOLATED WORKING DIRECTORY ===');
            parts.push(`You are operating in a dedicated git worktree at: ${subtask.worktreePath}`);
            parts.push('This is an isolated copy of the codebase on its own branch.');
            parts.push('');
            parts.push('RULES:');
            parts.push(`1. ALL file operations MUST target paths under: ${subtask.worktreePath}`);
            parts.push(`2. ALWAYS cd to the worktree first: cd "${subtask.worktreePath}"`);
            parts.push('3. Do NOT modify files in the main workspace directory.');
            parts.push('');
        }

        // Dependency context (distilled)
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

        // Prior attempt context for retries
        if (priorAttempts && priorAttempts.length > 0) {
            parts.push('=== ⚠️ PRIOR ATTEMPT (THIS IS A RETRY) ===');
            parts.push(
                'A previous model attempted this task but failed. CONTINUE from where it left off.',
            );
            parts.push(
                'DO NOT duplicate work already completed (files, records, resources that already exist).',
            );
            parts.push('Verify what was done, fix issues, complete remaining work.');
            parts.push('');
            for (let i = 0; i < priorAttempts.length; i++) {
                const attempt = priorAttempts[i];
                parts.push(`--- Attempt ${i + 1} (${attempt.modelId}) ---`);
                parts.push(`Failure reason: ${attempt.reason}`);
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

        // The actual task
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

        parts.push('');
        parts.push(
            'REMINDER: Check the CURRENT WORKSPACE STATE above before creating files or directories.',
        );
        parts.push('If a path already exists, use it — do not create duplicates.');

        parts.push(SUMMARY_BLOCK_INSTRUCTION);
        parts.push(HIVE_SIGNAL_INSTRUCTION);

        if (subtask.dependsOn.length > 0) {
            parts.push(FlowCorrectionManager.CORRECTION_SIGNAL_INSTRUCTION);
        }

        return parts.join('\n');
    }

    /**
     * Detect model safety refusals.
     */
    private detectRefusal(output: string, toolCallCount: number): string {
        if (toolCallCount > 0) {
            return '';
        }

        const trimmed = output.trim();
        if (trimmed.length === 0) {
            return 'Model produced no output and made no tool calls';
        }

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

    /**
     * Parse tool responses from ACP worker output.
     * Extracts exit codes, commands, and file paths for ground-truth verification.
     */
    private parseToolResponses(output: string): ToolResult[] {
        const results: ToolResult[] = [];

        // Pattern: [Tool: tool_name] ... exit code X / Created: file.ts
        // Look for tool invocation markers and extract context
        const toolPattern = /\[Tool:\s*(\S+)\]([^\[]*?)(?=\[Tool:|$)/gs;
        let match: RegExpExecArray | null;

        while ((match = toolPattern.exec(output)) !== null) {
            const toolName = match[1];
            const toolContext = match[2];

            const toolResult: ToolResult = {
                tool: toolName,
            };

            // Extract exit code from terminal commands
            if (toolName === 'run_in_terminal') {
                const exitCodeMatch = toolContext.match(/exit\s+code[:\s]+(\d+)/i);
                if (exitCodeMatch) {
                    toolResult.exitCode = parseInt(exitCodeMatch[1], 10);
                }

                // Extract command
                const commandMatch = toolContext.match(/(?:Command|Running)[:\s]+`([^`]+)`/i);
                if (commandMatch) {
                    toolResult.command = commandMatch[1];
                }

                // Capture output
                toolResult.output = toolContext.trim();
            }

            // Extract file paths from file operations
            if (
                toolName === 'create_file' ||
                toolName === 'write' ||
                toolName === 'edit' ||
                toolName === 'replace_string_in_file'
            ) {
                const fileMatch = toolContext.match(/(?:file|path)[:\s]+`?([^\s`\n]+\.[a-z]+)`?/i);
                if (fileMatch) {
                    toolResult.filePath = fileMatch[1];
                }
            }

            results.push(toolResult);
        }

        return results;
    }

    /**
     * Count tool call markers in output.
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

        const roundMarkers = output.match(/\(round \d+/g);
        const roundCount = roundMarkers ? roundMarkers.length : Math.ceil(total / 2);

        return { total, byTool, roundCount };
    }

    /**
     * Parse review JSON output.
     */
    private parseReviewResult(rawOutput: string): {
        success: boolean;
        reason: string;
        suggestions: string[];
    } {
        const parsed = this.parseReviewJson(rawOutput);
        if (!parsed) {
            return {
                success: false,
                reason: 'Could not parse review output — defaulting to failure',
                suggestions: [],
            };
        }

        let success = Boolean(parsed.success);
        const checklist = parsed.checklist as Record<string, boolean> | undefined;
        if (checklist && typeof checklist === 'object') {
            const allPassed = Object.values(checklist).every((v) => v === true);
            if (!allPassed && success) {
                success = false;
                const failedItems = Object.entries(checklist)
                    .filter(([, v]) => v !== true)
                    .map(([k]) => k);
                parsed.reason = `Checklist failures: ${failedItems.join(', ')}. ${parsed.reason || ''}`;
            }
        }

        // Preserve flow-correction signals
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

    private parseReviewJson(rawOutput: string): Record<string, unknown> | undefined {
        try {
            let jsonStr = rawOutput.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                jsonStr = jsonMatch[1].trim();
            }

            try {
                return JSON.parse(jsonStr);
            } catch {
                const objMatch = rawOutput.match(/\{[\s\S]*\}/);
                if (objMatch) {
                    return JSON.parse(objMatch[0]);
                }
                return undefined;
            }
        } catch {
            return undefined;
        }
    }

    /**
     * Resolve skill with transitive dependencies.
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
