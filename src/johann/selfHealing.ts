/**
 * selfHealing.ts — Self-Healing Pattern Detection
 *
 * When Johann discovers a failure pattern (e.g., non-agentic behavior),
 * it should autonomously create a skill to prevent that pattern from
 * recurring in future runs.
 *
 * This is triggered when:
 * - Review phase detects a known anti-pattern (checklist failure)
 * - Subtask fails with a pattern that could be prevented
 * - Merge phase detects systematic issues
 *
 * The flow:
 * 1. Detect failure pattern from review checklist
 * 2. Create a targeted skill to prevent it
 * 3. Save to local skills
 * 4. Offer to promote to global
 *
 * This makes Johann self-improving — each mistake becomes permanent knowledge.
 */

import { SkillDoc } from './skillTypes';
import { LocalSkillStore } from './skillStore';
import { SkillValidator } from './skillValidator';
import { getLogger } from './logger';

// ============================================================================
// Failure Pattern Types
// ============================================================================

/**
 * Known failure patterns that can be prevented with skills.
 */
export type FailurePatternType =
    | 'non-agentic-behavior' // Subagent told user to do something instead of doing it
    | 'stub-placeholder' // Subagent used TODO/placeholder comments
    | 'missing-implementation' // Subagent created skeleton without real logic
    | 'incorrect-imports' // Subagent used wrong import paths
    | 'missing-error-handling' // Subagent omitted error handling
    | 'incomplete-task'; // Subagent only partially completed task

export interface DetectedFailure {
    /** Type of failure detected */
    type: FailurePatternType;
    /** Subtask ID where failure occurred */
    subtaskId: string;
    /** Subtask description */
    description: string;
    /** Evidence from the review (specific phrases, code patterns, etc.) */
    evidence: string[];
    /** The checklist field that failed (if from review checklist) */
    checklistField?: string;
}

// ============================================================================
// Self-Healing Detector
// ============================================================================

export class SelfHealingDetector {
    private logger = getLogger();
    private detectedFailures: DetectedFailure[] = [];

    /**
     * Analyze a review result to detect failure patterns.
     * Call this after each subtask review.
     */
    detectFromReview(
        subtaskId: string,
        description: string,
        reviewResult: any, // The parsed review JSON
        output: string,
    ): DetectedFailure[] {
        const checklist = reviewResult.checklist;
        if (!checklist) {
            return [];
        }

        const detected: DetectedFailure[] = [];

        // Check for non-agentic behavior
        if (checklist.noUserDirectedInstructions === false) {
            const evidence = this.extractUserDirectedPhrases(output);
            const failure: DetectedFailure = {
                type: 'non-agentic-behavior',
                subtaskId,
                description,
                evidence,
                checklistField: 'noUserDirectedInstructions',
            };
            this.detectedFailures.push(failure);
            detected.push(failure);
        }

        // Check for stubs/placeholders
        if (checklist.noStubs === false) {
            const evidence = this.extractStubPatterns(output);
            const failure: DetectedFailure = {
                type: 'stub-placeholder',
                subtaskId,
                description,
                evidence,
                checklistField: 'noStubs',
            };
            this.detectedFailures.push(failure);
            detected.push(failure);
        }

        // Check for incomplete work
        if (checklist.realWorkDone === false) {
            const failure: DetectedFailure = {
                type: 'incomplete-task',
                subtaskId,
                description,
                evidence: ['No actual workspace changes detected'],
                checklistField: 'realWorkDone',
            };
            this.detectedFailures.push(failure);
            detected.push(failure);
        }

        return detected;
    }

    /**
     * Extract user-directed phrases from output.
     */
    private extractUserDirectedPhrases(output: string): string[] {
        const patterns = [
            /please run[^\n]{0,100}/gi,
            /you should[^\n]{0,100}/gi,
            /you need to[^\n]{0,100}/gi,
            /make sure to[^\n]{0,100}/gi,
            /ask (?:the )?user to[^\n]{0,100}/gi,
            /tell (?:the )?user to[^\n]{0,100}/gi,
        ];

        const evidence: string[] = [];
        for (const pattern of patterns) {
            const matches = output.match(pattern);
            if (matches) {
                evidence.push(...matches.slice(0, 3)); // Max 3 examples per pattern
            }
        }
        return evidence;
    }

    /**
     * Extract stub/placeholder patterns from output.
     */
    private extractStubPatterns(output: string): string[] {
        const patterns = [
            /\/\/\s*TODO[^\n]{0,100}/gi,
            /\/\/\s*FIXME[^\n]{0,100}/gi,
            /\/\/\s*Implement[^\n]{0,100}/gi,
            /\/\*\s*Placeholder\s*\*\//gi,
            /return\s+(?:null|undefined|0|false|''|"");?\s*\/\//gi,
        ];

        const evidence: string[] = [];
        for (const pattern of patterns) {
            const matches = output.match(pattern);
            if (matches) {
                evidence.push(...matches.slice(0, 3));
            }
        }
        return evidence;
    }

    /**
     * Get all detected failures in this run.
     */
    getDetectedFailures(): DetectedFailure[] {
        return this.detectedFailures;
    }

    /**
     * Create a skill from a detected failure pattern.
     * Returns the created skill, or undefined if creation failed.
     */
    async createSkillFromFailure(
        failure: DetectedFailure,
        localStore: LocalSkillStore,
        validator: SkillValidator,
    ): Promise<SkillDoc | undefined> {
        const generator = SKILL_GENERATORS[failure.type];
        if (!generator) {
            this.logger.warn(`No skill generator for failure type: ${failure.type}`);
            return undefined;
        }

        const draft = generator(failure);

        // Validate the skill
        const validation = validator.validate(draft);
        if (!validation.valid) {
            this.logger.warn(
                `Generated skill failed validation for ${failure.type}: ${validation.errors.join('; ')}`,
            );
            return undefined;
        }

        // Set hash and save
        draft.metadata.content_hash = validator.computeHash(draft);
        await localStore.saveSkill(draft);

        this.logger.info(
            `Self-healing: created skill "${draft.metadata.slug}" to prevent ${failure.type}`,
        );

        return draft;
    }

    /**
     * Reset detected failures (call at start of run).
     */
    reset(): void {
        this.detectedFailures = [];
    }
}

// ============================================================================
// Skill Generators for Each Failure Type
// ============================================================================

type SkillGenerator = (failure: DetectedFailure) => SkillDoc;

const SKILL_GENERATORS: Record<FailurePatternType, SkillGenerator> = {
    'non-agentic-behavior': (failure) => ({
        schema_version: 'johann.skill.v1',
        metadata: {
            slug: 'enforce-agentic-execution',
            version: '1.0.0',
            title: 'Enforce Agentic Execution (No User-Directed Instructions)',
            description:
                'Prevents subagents from telling the user to do things instead of doing them autonomously',
            tags: ['self-healing', 'agentic', 'execution', 'quality'],
            scope: 'local',
            origin: 'autonomous',
            created_at: new Date().toISOString(),
        },
        applies_to: {
            task_types: ['generate', 'refactor', 'test', 'debug', 'edit', 'design'],
            keywords: [
                'run',
                'start',
                'install',
                'configure',
                'setup',
                'launch',
                'execute',
                'command',
                'service',
                'docker',
                'ddev',
            ],
        },
        instruction: {
            body: `**CRITICAL: You are a FULLY AUTONOMOUS agent. Your job is to DO things, not tell the user what to do.**

## The Problem This Skill Prevents

This skill was created because a subagent returned user-directed instructions instead of taking autonomous action. Evidence:

${failure.evidence.map((e) => `- "${e}"`).join('\n')}

## Your Responsibility

When a task requires running a command, starting a service, checking system state, or any other action:
- **YOU RUN IT** — don't tell the user to run it
- **YOU CHECK IT** — don't ask the user to check it
- **YOU FIX IT** — don't suggest the user fix it

## Forbidden Output Patterns

NEVER output any of these phrases:
- "Please run..."
- "You should..."
- "You need to..."
- "Make sure to..."
- "Ask the user to..."
- "Tell [someone] to..."
- "The user must/should..."

If you find yourself generating these phrases, STOP and revise to use your tools instead.

## Examples

❌ WRONG (user-directed):
"Please run \`ddev start\` to start the DDEV environment."

✅ RIGHT (agentic):
"Running \`ddev start\` to start the DDEV environment..."
[Uses run_in_terminal tool to execute the command]
"✅ DDEV environment started successfully."

❌ WRONG:
"You need to install dependencies with npm install."

✅ RIGHT:
"Installing dependencies..."
[Uses run_in_terminal to execute npm install]
"✅ Dependencies installed successfully."

## Implementation

When this skill is active:
1. Before responding, scan your output for forbidden phrases
2. If any are found, revise to use tools instead
3. Actually execute commands using run_in_terminal
4. Actually create files using file creation tools
5. Actually make changes using editing tools
6. Report what you DID, not what should be done`,
            steps: [
                'Scan task description for actions that need to be taken',
                'Use tools to perform those actions autonomously',
                'Verify actions completed successfully',
                'Report results with evidence of what was done',
            ],
        },
        security: {
            allowed_tools: ['run_in_terminal', 'create_file', 'replace_string_in_file'],
            allowed_file_patterns: ['**/*'],
            max_instruction_chars: 8000,
        },
        history: {
            total_uses: 1,
            runs_used_in: 1,
            recent_run_ids: [],
            unused_run_streak: 0,
        },
    }),

    'stub-placeholder': (failure) => ({
        schema_version: 'johann.skill.v1',
        metadata: {
            slug: 'no-stubs-or-placeholders',
            version: '1.0.0',
            title: 'Prevent Stub/Placeholder Code',
            description:
                'Ensures all code is fully implemented without TODO comments or placeholder patterns',
            tags: ['self-healing', 'quality', 'implementation'],
            scope: 'local',
            origin: 'autonomous',
            created_at: new Date().toISOString(),
        },
        applies_to: {
            task_types: ['generate', 'refactor', 'edit'],
            keywords: ['function', 'class', 'component', 'implementation', 'logic'],
        },
        instruction: {
            body: `**Every function must be FULLY IMPLEMENTED. No stubs, no placeholders, no TODO comments.**

## The Problem This Skill Prevents

Detected stub/placeholder patterns:
${failure.evidence.map((e) => `- ${e}`).join('\n')}

## Prohibited Patterns

- \`// TODO\` or \`// FIXME\` comments
- Empty function bodies
- Functions that only return dummy values (\`return null;\`, \`return 0;\`)
- Comments like "Implement logic here"
- Placeholder components or modules

## Implementation Standard

Every function/method must:
1. Have complete working logic
2. Handle edge cases
3. Include proper error handling
4. Return meaningful values based on inputs
5. Match the documented interface/signature

Before submitting code, verify NO placeholder patterns exist.`,
        },
        security: {
            allowed_tools: [],
            allowed_file_patterns: ['**/*.ts', '**/*.js', '**/*.tsx', '**/*.jsx', '**/*.py'],
            max_instruction_chars: 8000,
        },
        history: {
            total_uses: 1,
            runs_used_in: 1,
            recent_run_ids: [],
            unused_run_streak: 0,
        },
    }),

    'incomplete-task': (_failure) => ({
        schema_version: 'johann.skill.v1',
        metadata: {
            slug: 'verify-task-completion',
            version: '1.0.0',
            title: 'Verify Complete Task Execution',
            description: 'Ensures all required files are created and all steps are completed',
            tags: ['self-healing', 'completeness', 'verification'],
            scope: 'local',
            origin: 'autonomous',
            created_at: new Date().toISOString(),
        },
        applies_to: {
            task_types: ['generate', 'refactor', 'test', 'edit'],
            keywords: ['create', 'implement', 'build', 'setup'],
        },
        instruction: {
            body: `**Before completing, verify ALL task requirements are met.**

Checklist:
- [ ] All requested files created
- [ ] All functions implemented
- [ ] All tests passing
- [ ] All dependencies installed
- [ ] All configurations set

Do not return until checklist is complete.`,
        },
        security: {
            allowed_tools: [],
            allowed_file_patterns: ['**/*'],
            max_instruction_chars: 8000,
        },
        history: {
            total_uses: 1,
            runs_used_in: 1,
            recent_run_ids: [],
            unused_run_streak: 0,
        },
    }),

    // Not yet implemented — throw so corrupt skills are never saved
    'missing-implementation': () => {
        throw new Error('Skill generator for missing-implementation not yet implemented');
    },
    'incorrect-imports': () => {
        throw new Error('Skill generator for incorrect-imports not yet implemented');
    },
    'missing-error-handling': () => {
        throw new Error('Skill generator for missing-error-handling not yet implemented');
    },
};
