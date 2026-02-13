import * as vscode from 'vscode';
import { OrchestrationPlan, Subtask, TaskComplexity, ModelInfo } from './types';

// ============================================================================
// TASK DECOMPOSER — Breaks user requests into orchestrated subtask plans
// Inspired by OpenClaw's agent loop and session model.
//
// The decomposer uses the user's selected model (or best available) to:
// 1. Analyze the request
// 2. Determine if it's a single-agent or multi-agent task
// 3. Break it into subtasks with dependencies
// 4. Assign complexity ratings to each subtask
// 5. Define success criteria per subtask
// ============================================================================

const DECOMPOSITION_SYSTEM_PROMPT = `You are Johann, a top-level orchestration agent. Your job is to analyze a user's coding request and produce an execution plan.

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
- Use parallel execution when subtasks are independent.
- Use serial execution when subtasks have dependencies.
- Mixed strategy means some tasks can run in parallel, others must be serial.
- Keep subtask count reasonable (1-10). More subtasks = more overhead.
- Complexity ratings drive model selection:
  - trivial: formatting, renaming, simple copy-paste style tasks
  - simple: straightforward implementation, bug fixes with clear cause
  - moderate: feature implementation requiring some design decisions
  - complex: architectural changes, multi-file refactors, performance optimization
  - expert: security-critical code, complex algorithm design, system architecture

IMPORTANT: Subtask descriptions must be COMPLETE and SELF-CONTAINED. Each subtask's description
will be sent to an independent agent that has NO context from other subtasks (unless their
results are piped in). Include all necessary context in each subtask description.

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
      "description": "Complete, self-contained description/prompt for the subagent. Include ALL context needed.",
      "complexity": "trivial" | "simple" | "moderate" | "complex" | "expert",
      "dependsOn": [],
      "successCriteria": ["Criterion 1", "..."]
    }
  ]
}

Return ONLY valid JSON. No markdown, no explanations.`;

export class TaskDecomposer {
    /**
     * Decompose a user request into an orchestration plan.
     */
    async decompose(
        request: string,
        workspaceContext: string,
        memoryContext: string,
        model: vscode.LanguageModelChat,
        token: vscode.CancellationToken
    ): Promise<OrchestrationPlan> {
        const userPrompt = this.buildDecompositionPrompt(request, workspaceContext, memoryContext);

        const messages = [
            vscode.LanguageModelChatMessage.User(
                DECOMPOSITION_SYSTEM_PROMPT + '\n\n---\n\n' + userPrompt
            )
        ];

        const response = await model.sendRequest(messages, {}, token);
        let result = '';
        for await (const chunk of response.text) {
            result += chunk;
        }

        const plan = this.parsePlan(result);
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
                complexity: this.validateComplexity(raw.complexity),
                dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.map(String) : [],
                successCriteria: Array.isArray(raw.successCriteria) ? raw.successCriteria.map(String) : [],
                status: 'pending',
                attempts: 0,
                maxAttempts: 3,
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
}
