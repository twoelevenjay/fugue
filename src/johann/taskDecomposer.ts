import * as vscode from 'vscode';
import { OrchestrationPlan, Subtask, TaskComplexity, TaskType, ModelInfo } from './types';
import { withRetry, PLANNING_RETRY_POLICY, classifyError, extractErrorMessage } from './retry';
import { DebugConversationLog } from './debugConversationLog';
import { SessionPersistence } from './sessionPersistence';

// ============================================================================
// TASK DECOMPOSER — Breaks user requests into orchestrated subtask plans
//
// The decomposer uses the user's selected model (or best available) to:
// 1. Analyze the request
// 2. Determine if it's a single-agent or multi-agent task
// 3. Break it into subtasks with dependencies
// 4. Assign complexity ratings to each subtask
// 5. Define success criteria per subtask
// ============================================================================

const DECOMPOSITION_SYSTEM_PROMPT = `You are Johann, a top-level orchestration agent. Your job is to analyze a user's coding request and produce an execution plan.

## Architecture

Each subtask you create will be executed as a **separate GitHub Copilot session** with **full tool access** — file creation, terminal commands, code editing, workspace navigation. The sessions already know how to do everything. Your job is to write precise prompts that steer them.

You must decide:
1. Can this be handled by a SINGLE agent, or should it be broken into MULTIPLE subtasks?
2. For each subtask, what is its complexity? (trivial, simple, moderate, complex, expert)
3. What are the dependencies between subtasks?
4. What is the execution strategy? (serial, parallel, or mixed)
5. What are the success criteria for each subtask and the overall plan?

RULES:
- If the task is straightforward (e.g., "fix this bug", "add a button"), use a SINGLE subtask. Not everything needs decomposition.
- If the task is complex (e.g., "refactor this module and add tests and update docs"), break it into logical subtasks.
- Each subtask should be a self-contained unit of work that produces a verifiable result.
- **Use parallel execution** when subtasks are independent. If tasks 2, 3, and 4 all only depend on task 1, they should run in parallel after task 1 completes.
- Use serial execution only when subtasks have strict sequential dependencies.
- Mixed strategy means some tasks can run in parallel, others must be serial.
- Keep subtask count reasonable (1-10). More subtasks = more overhead.

## Subtask Descriptions — AGENTIC EXECUTION ONLY

CRITICAL RULES FOR SUBTASK DESCRIPTIONS:

**Subtask descriptions are COMMAND PROMPTS for autonomous agents, NOT instructions for the user.**

1. **NEVER write descriptions that tell the USER to do something.** Phrases like "Please run...", "You should...", "The user needs to...", "Ask the user to...", "Tell the user..." are STRICTLY FORBIDDEN.

2. **ALWAYS write descriptions that tell the AGENT to DO something.** Use imperative commands: "Run \`ddev start\`", "Create the file...", "Install dependencies with...", "Check if Docker is running and start it if not..."

3. **Agents have FULL AUTONOMY.** They can run terminal commands, create files, edit code, start services, check system state — everything. If Docker isn't running, the agent can launch it. If DDEV isn't started, the agent can start it. If dependencies aren't installed, the agent can install them.

WRONG (user-directed):
❌ "description": "Please run \`ddev start\` to start the DDEV environment"
❌ "description": "Ask the user to ensure Docker Desktop is running"
❌ "description": "Tell the user to run \`npm install\`"

RIGHT (agent-directed):
✅ "description": "Check if DDEV is running with \`ddev describe\`. If not running, execute \`ddev start\` to start the DDEV environment. Wait for startup confirmation."
✅ "description": "Check if Docker Desktop is running with \`docker info\`. If not, launch /Applications/Docker.app (macOS) or equivalent. Wait for Docker daemon to be ready."
✅ "description": "Run \`npm install\` to install dependencies. Verify package-lock.json was updated successfully."

CRITICAL: Subtask descriptions are the PROMPTS sent to Copilot sessions. They must:

1. **Be COMPLETE and SELF-CONTAINED.** Each session has NO context from other subtasks (unless their results are piped in as dependency context). Include all necessary file paths, type definitions, conventions, and context in each description.

2. **Instruct the agent to USE TOOLS.** Explicitly tell the agent to create files, run commands, etc. Do NOT write descriptions that ask for prose or code blocks — ask for actual workspace changes.

3. **Specify exact file paths.** Don't say "create a component" — say "create \`src/components/Header.tsx\`".

4. **Include interfaces and types** that the subtask's code needs to implement, especially when the types are defined by a dependency.

5. **Avoid indefinite foreground commands.** If a subtask needs to validate a dev server/watch process, instruct the agent to run it in background mode with a bounded wait/check, then continue. Do NOT require commands that run forever in foreground.

## Complexity Ratings (drive model selection)
- trivial: formatting, renaming, simple copy-paste style tasks
- simple: straightforward implementation, bug fixes with clear cause
- moderate: feature implementation requiring some design decisions
- complex: architectural changes, multi-file refactors, performance optimization
- expert: security-critical code, complex algorithm design, system architecture

## Task Type (drives model routing — set this so the model picker can choose the cheapest capable model)
- generate: code generation, scaffolding, boilerplate
- refactor: code transformations, renames, moves
- test: test generation and writing
- debug: debugging, fixing failures, error analysis
- review: code review, security, edge cases
- spec: planning, documentation, communication
- edit: small edits, formatting, single functions
- design: architecture decisions, multi-file design
- complex-refactor: large-scale refactors requiring deep reasoning

## Environment Awareness
The workspace context you receive may include a DETECTED ENVIRONMENT CAPABILITIES section listing what development tools are available (DDEV, Docker, npm, WordPress/WP-CLI, etc.). When planning subtasks:

1. **Use the exact commands listed.** If DDEV is detected, use \`ddev exec\`, \`ddev wp\`, \`ddev mysql\` — do NOT tell the agent to install standalone MySQL, WP-CLI, or other tools that DDEV already provides.
2. **Include environment commands in subtask descriptions.** Instead of "Start the development environment", write "Run \`ddev start\` to start the DDEV containers. Verify with \`ddev describe\` that all services are healthy."
3. **Reference detected capabilities by name.** If Docker Compose is detected, reference \`docker compose up -d\` explicitly. If npm is detected with scripts, name the specific scripts (e.g., \`npm run build\`, \`npm run dev\`).
4. **Plan for containerized environments.** In DDEV/Docker setups, commands run INSIDE containers. Use \`ddev exec npm install\` not just \`npm install\`. Use \`ddev mysql\` not \`mysql\`.

## Resilient Subtask Planning
Each subtask should be RESILIENT to common failure modes:

1. **File discovery, not assumptions.** Instead of "Read the file at /path/to/foo.txt", write "Find the configuration file (check common locations: .ddev/config.yaml, .env, config/). Read it to determine..."
2. **Fallback strategies.** Instead of "Run \`npm run build\`", write "Run \`npm run build\`. If it fails, check the error output, fix the issue, and retry."
3. **Cross-task artifact naming.** When Task A creates output that Task B needs, specify the EXACT path: "Write the status report to \`./project-status.txt\`" — then Task B's description says "Read \`./project-status.txt\` created by Task 1."
4. **Bounded operations.** Never create subtasks that require infinite foreground processes. For dev servers: "Start the dev server in background mode, wait 10 seconds, then verify it's running with a curl request."

## Multi-Pass Execution
Set "useMultiPass": true when a subtask benefits from a structured implement→verify→fix loop.
Good candidates for multi-pass:
- Tasks that generate code AND need compilation/test verification
- Complex refactors across multiple files
- Any task where "write it, then check it compiles, then fix issues" is the natural workflow
Do NOT enable multi-pass for: documentation, spec writing, small edits, or trivial tasks.

Return a JSON object with this EXACT structure:
{
  "summary": "Brief summary of the overall plan",
  "strategy": "serial" | "parallel" | "mixed",
  "overallComplexity": "trivial" | "simple" | "moderate" | "complex" | "expert",
  "successCriteria": ["Overall success criterion 1", "..."],
  "subtasks": [
    {
      "id": "task-1",
      "title": "Short title",
      "description": "Complete, self-contained prompt for the Copilot session. Include ALL context, file paths, and explicit instructions to use tools.",
      "taskType": "generate" | "refactor" | "test" | "debug" | "review" | "spec" | "edit" | "design" | "complex-refactor",
      "complexity": "trivial" | "simple" | "moderate" | "complex" | "expert",
      "useMultiPass": false,
      "dependsOn": [],
      "successCriteria": ["Criterion 1", "..."]
    }
  ]
}

Return ONLY valid JSON. No markdown, no explanations.`;

export class TaskDecomposer {
    /**
     * Decompose a user request into an orchestration plan.
     * Streams the planning output live to the response stream
     * AND to disk via SessionPersistence (if provided).
     */
    async decompose(
        request: string,
        workspaceContext: string,
        memoryContext: string,
        model: vscode.LanguageModelChat,
        token: vscode.CancellationToken,
        stream?: vscode.ChatResponseStream,
        debugLog?: DebugConversationLog,
        persist?: SessionPersistence
    ): Promise<OrchestrationPlan> {
        const userPrompt = this.buildDecompositionPrompt(request, workspaceContext, memoryContext);

        const fullPrompt = DECOMPOSITION_SYSTEM_PROMPT + '\n\n---\n\n' + userPrompt;
        const messages = [
            vscode.LanguageModelChatMessage.User(fullPrompt)
        ];

        if (stream) {
            stream.markdown('<details><summary>🧠 Planning thought process</summary>\n\n');
        }

        const plan = await withRetry(
            async () => {
                const callStart = Date.now();
                const response = await model.sendRequest(messages, {}, token);
                let result = '';
                for await (const chunk of response.text) {
                    result += chunk;
                    if (stream) {
                        stream.markdown(chunk);
                    }
                    // Stream plan chunks to disk as they arrive
                    if (persist) {
                        await persist.appendPlanStream(chunk);
                    }
                }

                // Debug log the planning call
                if (debugLog) {
                    await debugLog.logLLMCall({
                        timestamp: new Date(callStart).toISOString(),
                        phase: 'planning',
                        label: 'Task decomposition',
                        model: model.id || model.name || 'unknown',
                        promptMessages: [fullPrompt],
                        responseText: result,
                        durationMs: Date.now() - callStart,
                    });
                }

                return this.parsePlan(result);
            },
            PLANNING_RETRY_POLICY,
            token,
            (attempt, maxRetries, error, delayMs) => {
                if (stream) {
                    stream.markdown(
                        `\n\n> ⚠️ **${error.category} error** during planning (attempt ${attempt}/${maxRetries}): ` +
                        `${error.message.substring(0, 150)}\n> Retrying in ${(delayMs / 1000).toFixed(1)}s...\n\n`
                    );
                }
            }
        );

        if (stream) {
            stream.markdown('\n\n</details>\n\n');
        }

        return plan;
    }

    /**
     * Build the full prompt for decomposition including workspace and memory context.
     */
    private buildDecompositionPrompt(
        request: string,
        workspaceContext: string,
        memoryContext: string
    ): string {
        const parts: string[] = [];

        if (workspaceContext) {
            parts.push('=== WORKSPACE CONTEXT ===');
            parts.push(workspaceContext);
            parts.push('');
        }

        if (memoryContext) {
            parts.push('=== PREVIOUS SESSION MEMORY ===');
            parts.push(memoryContext);
            parts.push('');
        }

        parts.push('=== USER REQUEST ===');
        parts.push(request);

        return parts.join('\n');
    }

    /**
     * Parse the LLM output into an OrchestrationPlan.
     */
    private parsePlan(rawOutput: string): OrchestrationPlan {
        let jsonStr = rawOutput.trim();

        // Strip markdown code fences if present
        const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1].trim();
        }

        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(jsonStr);
        } catch {
            // Try to extract JSON object
            const objMatch = rawOutput.match(/\{[\s\S]*\}/);
            if (objMatch) {
                try {
                    parsed = JSON.parse(objMatch[0]);
                } catch {
                    // Fall back to a single-subtask plan
                    return this.createFallbackPlan(rawOutput);
                }
            } else {
                return this.createFallbackPlan(rawOutput);
            }
        }

        // Validate and construct the plan
        const subtasks: Subtask[] = [];
        const rawSubtasks = (parsed.subtasks as Array<Record<string, unknown>>) || [];

        for (const raw of rawSubtasks) {
            subtasks.push({
                id: String(raw.id || `task-${subtasks.length + 1}`),
                title: String(raw.title || 'Untitled subtask'),
                description: String(raw.description || ''),
                taskType: this.validateTaskType(raw.taskType),
                complexity: this.validateComplexity(raw.complexity),
                dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
                successCriteria: Array.isArray(raw.successCriteria) ? raw.successCriteria.map(String) : [],
                status: 'pending',
                attempts: 0,
                maxAttempts: 3,
                useMultiPass: raw.useMultiPass === true,
            });
        }

        // If no subtasks were parsed, create fallback
        if (subtasks.length === 0) {
            return this.createFallbackPlan(rawOutput);
        }

        return {
            summary: String(parsed.summary || 'Orchestration plan'),
            subtasks,
            strategy: this.validateStrategy(parsed.strategy),
            successCriteria: Array.isArray(parsed.successCriteria)
                ? parsed.successCriteria.map(String)
                : [],
            overallComplexity: this.validateComplexity(parsed.overallComplexity),
        };
    }

    /**
     * Create a fallback single-subtask plan when decomposition fails.
     */
    private createFallbackPlan(originalRequest: string): OrchestrationPlan {
        return {
            summary: 'Direct execution (decomposition fallback)',
            strategy: 'serial',
            overallComplexity: 'moderate',
            successCriteria: ['Task completed successfully'],
            subtasks: [
                {
                    id: 'task-1',
                    title: 'Execute request',
                    description: originalRequest,
                    complexity: 'moderate',
                    dependsOn: [],
                    successCriteria: ['Task completed successfully'],
                    status: 'pending',
                    attempts: 0,
                    maxAttempts: 3,
                },
            ],
        };
    }

    private validateComplexity(value: unknown): TaskComplexity {
        const valid: TaskComplexity[] = ['trivial', 'simple', 'moderate', 'complex', 'expert'];
        if (typeof value === 'string' && valid.includes(value as TaskComplexity)) {
            return value as TaskComplexity;
        }
        return 'moderate';
    }

    private validateStrategy(value: unknown): 'serial' | 'parallel' | 'mixed' {
        const valid = ['serial', 'parallel', 'mixed'];
        if (typeof value === 'string' && valid.includes(value)) {
            return value as 'serial' | 'parallel' | 'mixed';
        }
        return 'serial';
    }

    private validateTaskType(value: unknown): TaskType | undefined {
        const valid: TaskType[] = [
            'generate', 'refactor', 'test', 'debug', 'review',
            'spec', 'edit', 'design', 'complex-refactor',
        ];
        if (typeof value === 'string' && valid.includes(value as TaskType)) {
            return value as TaskType;
        }
        return undefined; // Let the model picker detect it from description
    }
}
