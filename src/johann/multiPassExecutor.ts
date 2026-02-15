// ============================================================================
// MULTI-PASS EXECUTOR — Execute multi-pass strategies with deterministic aggregation
//
// Handles:
// - Sequential execution of multi-pass workflows
// - Model selection for each pass based on target cost
// - Structured output parsing (JSON schemas)
// - Deterministic aggregation (voting, tool checks, rubrics)
// - Escalation when verifiers detect uncertainty
// ============================================================================

import * as vscode from 'vscode';
import { TaskComplexity, TaskType } from './types';
import { ModelPicker } from './modelPicker';
import { JohannLogger, getLogger } from './logger';
import {
    MultiPassStrategy,
    MultiPassStep,
    ConsistencySample,
    CritiqueIssue,
    ReviewFinding,
    voteOnConsistency,
    verifyRevisionAddressesIssues,
    deduplicateReviewFindings,
} from './multiPassStrategies';

/**
 * Result from executing a single pass.
 */
export interface PassResult {
    /** The pass that was executed */
    step: MultiPassStep;
    /** Model used for this pass */
    modelId: string;
    /** Raw output from the model */
    rawOutput: string;
    /** Parsed structured output (if applicable) */
    structuredOutput?: any;
    /** Whether this pass succeeded */
    success: boolean;
    /** Error message if failed */
    error?: string;
}

/**
 * Result from executing a full multi-pass strategy.
 */
export interface MultiPassResult {
    /** The strategy that was executed */
    strategy: MultiPassStrategy;
    /** Results from each pass */
    passResults: PassResult[];
    /** Final aggregated output */
    finalOutput: string;
    /** Whether the strategy succeeded */
    success: boolean;
    /** Whether we should escalate to premium model */
    shouldEscalate: boolean;
    /** Reason for escalation (if applicable) */
    escalationReason?: string;
    /** Metadata about the execution */
    metadata: {
        totalPasses: number;
        modelsUsed: string[];
        totalCost: number; // Sum of cost multipliers
        timeMs: number;
    };
}

export class MultiPassExecutor {
    private logger: JohannLogger;
    private modelPicker: ModelPicker;

    constructor(logger: JohannLogger, modelPicker: ModelPicker) {
        this.logger = logger;
        this.modelPicker = modelPicker;
    }

    /**
     * Execute a multi-pass strategy.
     */
    async execute(
        strategy: MultiPassStrategy,
        taskType: TaskType,
        complexity: TaskComplexity,
        context: {
            taskDescription: string;
            relevantFiles?: Array<{ path: string; content: string }>;
            previousAttempts?: string[];
        }
    ): Promise<MultiPassResult> {
        const startTime = Date.now();
        const passResults: PassResult[] = [];
        const modelsUsed: string[] = [];
        let totalCost = 0;

        this.logger.info(`Executing multi-pass strategy: ${strategy.type}`);

        try {
            // Execute each pass in sequence
            for (let i = 0; i < strategy.passes.length; i++) {
                const step = strategy.passes[i];
                
                // Skip aggregate steps (deterministic, no LLM call)
                if (step.role === 'aggregate') {
                    continue;
                }

                this.logger.debug(`Executing pass ${i + 1}/${strategy.passes.length}: ${step.role}`);

                const passResult = await this.executePass(
                    step,
                    taskType,
                    complexity,
                    context,
                    passResults // Previous pass results for context
                );

                passResults.push(passResult);
                modelsUsed.push(passResult.modelId);
                
                // Get cost of model used
                const modelInfo = await this.modelPicker.getModel(passResult.modelId);
                if (modelInfo) {
                    totalCost += modelInfo.costMultiplier;
                }

                if (!passResult.success) {
                    // Pass failed - stop execution
                    return {
                        strategy,
                        passResults,
                        finalOutput: '',
                        success: false,
                        shouldEscalate: true,
                        escalationReason: `Pass ${step.role} failed: ${passResult.error}`,
                        metadata: {
                            totalPasses: passResults.length,
                            modelsUsed,
                            totalCost,
                            timeMs: Date.now() - startTime,
                        },
                    };
                }
            }

            // All passes completed - run aggregation
            const aggregationResult = await this.aggregate(strategy, passResults);

            return {
                strategy,
                passResults,
                finalOutput: aggregationResult.output,
                success: aggregationResult.success,
                shouldEscalate: aggregationResult.shouldEscalate,
                escalationReason: aggregationResult.escalationReason,
                metadata: {
                    totalPasses: passResults.length,
                    modelsUsed,
                    totalCost,
                    timeMs: Date.now() - startTime,
                },
            };
        } catch (error) {
            this.logger.error('Multi-pass execution failed', { error: String(error) });
            return {
                strategy,
                passResults,
                finalOutput: '',
                success: false,
                shouldEscalate: true,
                escalationReason: `Execution error: ${error}`,
                metadata: {
                    totalPasses: passResults.length,
                    modelsUsed,
                    totalCost,
                    timeMs: Date.now() - startTime,
                },
            };
        }
    }

    /**
     * Execute a single pass.
     */
    private async executePass(
        step: MultiPassStep,
        taskType: TaskType,
        complexity: TaskComplexity,
        context: {
            taskDescription: string;
            relevantFiles?: Array<{ path: string; content: string }>;
            previousAttempts?: string[];
        },
        previousResults: PassResult[]
    ): Promise<PassResult> {
        // Select model for this pass based on target cost
        const modelInfo = await this.selectModelForPass(step, taskType, complexity);
        
        if (!modelInfo) {
            return {
                step,
                modelId: 'none',
                rawOutput: '',
                success: false,
                error: 'No model available for this pass',
            };
        }

        // Build prompt for this pass
        const prompt = this.buildPromptForPass(step, context, previousResults);

        // Call the model
        try {
            const messages = [
                vscode.LanguageModelChatMessage.User(prompt),
            ];

            const chatResponse = await modelInfo.model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
            
            let rawOutput = '';
            for await (const fragment of chatResponse.text) {
                rawOutput += fragment;
            }

            // Parse structured output if expected
            let structuredOutput: any = undefined;
            if (step.outputFormat === 'json' && step.jsonSchema) {
                try {
                    // Try to extract JSON from markdown code blocks
                    const jsonMatch = rawOutput.match(/```json\s*\n([\s\S]*?)\n```/);
                    const jsonStr = jsonMatch ? jsonMatch[1] : rawOutput;
                    structuredOutput = JSON.parse(jsonStr.trim());
                } catch (parseError) {
                    this.logger.warn(`Failed to parse JSON output from ${step.role} pass`);
                    // Continue anyway - we have raw output
                }
            }

            return {
                step,
                modelId: modelInfo.id,
                rawOutput,
                structuredOutput,
                success: true,
            };
        } catch (error) {
            this.logger.error(`Pass ${step.role} failed`, { error: String(error) });
            return {
                step,
                modelId: modelInfo.id,
                rawOutput: '',
                success: false,
                error: String(error),
            };
        }
    }

    /**
     * Select the best model for a pass based on target cost.
     */
    private async selectModelForPass(
        step: MultiPassStep,
        taskType: TaskType,
        complexity: TaskComplexity
    ): Promise<any> {
        const models = await this.modelPicker.getAllModels();
        
        // Filter to models at or near target cost
        const targetCost = step.targetCost;
        const candidates = models.filter(m => 
            m.costMultiplier >= targetCost && 
            m.costMultiplier <= targetCost + 0.33 // Allow slightly higher cost
        );

        if (candidates.length === 0) {
            // Fallback to any 0× model
            return models.find(m => m.costMultiplier === 0);
        }

        // Pick the model closest to target cost with appropriate tier
        return candidates[0];
    }

    /**
     * Build prompt for a specific pass.
     */
    private buildPromptForPass(
        step: MultiPassStep,
        context: {
            taskDescription: string;
            relevantFiles?: Array<{ path: string; content: string }>;
            previousAttempts?: string[];
        },
        previousResults: PassResult[]
    ): string {
        const parts: string[] = [];

        // Task context
        parts.push(`# Task: ${context.taskDescription}\n`);

        // Previous pass outputs (for critique, revise, repair roles)
        if (step.role === 'critique' || step.role === 'revise' || step.role === 'repair') {
            const previousPass = previousResults[previousResults.length - 1];
            if (previousPass) {
                parts.push(`\n## Previous Output:\n\`\`\`\n${previousPass.rawOutput}\n\`\`\`\n`);
            }
        }

        // Relevant files
        if (context.relevantFiles && context.relevantFiles.length > 0) {
            parts.push('\n## Relevant Files:\n');
            for (const file of context.relevantFiles.slice(0, 3)) { // Limit to 3 files
                parts.push(`\n### ${file.path}\n\`\`\`\n${file.content.slice(0, 2000)}\n\`\`\`\n`);
            }
        }

        // Previous attempts (if retrying)
        if (context.previousAttempts && context.previousAttempts.length > 0) {
            parts.push('\n## Previous Attempts:\n');
            context.previousAttempts.forEach((attempt, i) => {
                parts.push(`\nAttempt ${i + 1}:\n${attempt}\n`);
            });
        }

        // Step-specific instruction
        parts.push(`\n## Your Task (${step.role}):\n${step.instruction}\n`);

        // Output format requirements
        if (step.outputFormat === 'json' && step.jsonSchema) {
            parts.push(`\n## Required Output Format:\nProvide your response as a JSON object matching this schema:\n\`\`\`json\n${JSON.stringify(step.jsonSchema, null, 2)}\n\`\`\`\n`);
        } else if (step.outputFormat === 'structured-list') {
            parts.push(`\n## Required Output Format:\nProvide a structured list with clear sections and bullet points.\n`);
        }

        return parts.join('');
    }

    /**
     * Aggregate results from all passes.
     */
    private async aggregate(
        strategy: MultiPassStrategy,
        passResults: PassResult[]
    ): Promise<{
        output: string;
        success: boolean;
        shouldEscalate: boolean;
        escalationReason?: string;
    }> {
        const aggregator = strategy.aggregator;

        switch (aggregator.type) {
            case 'majority-vote':
                return this.aggregateMajorityVote(passResults, aggregator.config as Record<string, any>);
            
            case 'critic-fixes':
                return this.aggregateCriticFixes(passResults, aggregator.config as Record<string, any>);
            
            case 'rubric-score':
                return this.aggregateRubricScore(passResults, aggregator.config as Record<string, any>);
            
            case 'tool-oracle':
                // Tool verification is handled separately (needs external tool calls)
                return {
                    output: passResults[passResults.length - 1].rawOutput,
                    success: true,
                    shouldEscalate: false,
                };
            
            default:
                // Default: return last pass output
                return {
                    output: passResults[passResults.length - 1].rawOutput,
                    success: true,
                    shouldEscalate: false,
                };
        }
    }

    /**
     * Aggregate using majority voting (self-consistency).
     */
    private aggregateMajorityVote(
        passResults: PassResult[],
        config?: Record<string, any>
    ): {
        output: string;
        success: boolean;
        shouldEscalate: boolean;
        escalationReason?: string;
    } {
        const samples: ConsistencySample[] = passResults
            .filter(r => r.structuredOutput)
            .map(r => r.structuredOutput as ConsistencySample);

        if (samples.length === 0) {
            return {
                output: '',
                success: false,
                shouldEscalate: true,
                escalationReason: 'No valid samples for voting',
            };
        }

        const minimumAgreement = config?.minimumAgreement ?? 0.5;
        const confidenceWeight = config?.confidenceWeight ?? 0.3;

        const vote = voteOnConsistency(samples, minimumAgreement, confidenceWeight);

        if (!vote) {
            return {
                output: '',
                success: false,
                shouldEscalate: true,
                escalationReason: `No majority consensus (min ${minimumAgreement * 100}% agreement required)`,
            };
        }

        // Format output with voting results
        const output = [
            `## Consensus Answer\n${vote.consensus}\n`,
            `\n**Confidence:** ${(vote.confidence * 100).toFixed(0)}%`,
            `\n**Supporting Evidence:**`,
            ...vote.evidence.slice(0, 5).map(e => `- ${e}`),
        ].join('\n');

        // Escalate if confidence is low even with consensus
        const shouldEscalate = vote.confidence < 0.6;
        const escalationReason = shouldEscalate 
            ? `Consensus found but confidence is low (${(vote.confidence * 100).toFixed(0)}%)`
            : undefined;

        return {
            output,
            success: true,
            shouldEscalate,
            escalationReason,
        };
    }

    /**
     * Aggregate using critic-fixes pattern.
     */
    private aggregateCriticFixes(
        passResults: PassResult[],
        config?: Record<string, any>
    ): {
        output: string;
        success: boolean;
        shouldEscalate: boolean;
        escalationReason?: string;
    } {
        if (passResults.length < 3) {
            return {
                output: '',
                success: false,
                shouldEscalate: true,
                escalationReason: 'Not enough passes for critic-fixes pattern (need draft, critique, revise)',
            };
        }

        const draft = passResults[0].rawOutput;
        const critiqueOutput = passResults[1].rawOutput;
        const revision = passResults[2].rawOutput;

        // Parse critique to extract must-fix issues
        // Simple heuristic: look for "must-fix" or "MUST-FIX" sections
        const mustFixMatches = critiqueOutput.match(/must-fix[:\s]+([\s\S]*?)(?=nice-to-have|$)/i);
        const mustFixText = mustFixMatches ? mustFixMatches[1] : '';
        
        // Count number of must-fix issues (approximation)
        const mustFixCount = (mustFixText.match(/^[-*]\s+/gm) || []).length;

        // Check if revision addresses issues
        const requireAllAddressed = config?.requireAllMustFixAddressed ?? true;
        
        // Simple check: does revision mention critical terms from critique?
        const criticalTerms = mustFixText.toLowerCase().match(/\b\w{5,}\b/g)?.slice(0, 10) || [];
        const addressedCount = criticalTerms.filter(term => 
            revision.toLowerCase().includes(term)
        ).length;
        
        const addressedRatio = criticalTerms.length > 0 
            ? addressedCount / criticalTerms.length 
            : 1;

        if (requireAllAddressed && addressedRatio < 0.7) {
            return {
                output: revision,
                success: true,
                shouldEscalate: true,
                escalationReason: `Revision may not address all must-fix issues (${(addressedRatio * 100).toFixed(0)}% coverage)`,
            };
        }

        // Escalate if too many must-fix issues found
        if (mustFixCount > 5) {
            return {
                output: revision,
                success: true,
                shouldEscalate: true,
                escalationReason: `High number of must-fix issues (${mustFixCount})`,
            };
        }

        return {
            output: revision,
            success: true,
            shouldEscalate: false,
        };
    }

    /**
     * Aggregate using rubric scoring.
     */
    private aggregateRubricScore(
        passResults: PassResult[],
        config?: Record<string, any>
    ): {
        output: string;
        success: boolean;
        shouldEscalate: boolean;
        escalationReason?: string;
    } {
        if (passResults.length < 2) {
            return {
                output: '',
                success: false,
                shouldEscalate: true,
                escalationReason: 'Not enough passes for rubric pattern (need extract, score)',
            };
        }

        const scoreResult = passResults[1];
        if (!scoreResult.structuredOutput) {
            return {
                output: scoreResult.rawOutput,
                success: true,
                shouldEscalate: false,
            };
        }

        const findings = scoreResult.structuredOutput as ReviewFinding[];
        const minimumConfidence = config?.minimumConfidence ?? 0.7;
        const escalateOnCritical = config?.escalateOnCritical ?? true;

        const deduplicated = deduplicateReviewFindings(findings, minimumConfidence);

        // Check for critical findings
        const criticalFindings = deduplicated.filter(f => f.severity === 'critical');
        const shouldEscalate = escalateOnCritical && criticalFindings.length > 0;
        const escalationReason = shouldEscalate
            ? `Found ${criticalFindings.length} critical issue(s) requiring review`
            : undefined;

        // Format output
        const output = this.formatReviewFindings(deduplicated);

        return {
            output,
            success: true,
            shouldEscalate,
            escalationReason,
        };
    }

    /**
     * Format review findings as readable output.
     */
    private formatReviewFindings(findings: ReviewFinding[]): string {
        if (findings.length === 0) {
            return '✅ No issues found.';
        }

        const lines: string[] = ['## Code Review Findings\n'];

        const bySeverity = {
            critical: findings.filter(f => f.severity === 'critical'),
            warning: findings.filter(f => f.severity === 'warning'),
            info: findings.filter(f => f.severity === 'info'),
        };

        for (const [severity, items] of Object.entries(bySeverity)) {
            if (items.length === 0) continue;

            const icon = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
            lines.push(`\n### ${icon} ${severity.toUpperCase()} (${items.length})\n`);

            for (const finding of items) {
                lines.push(`**${finding.file}:${finding.line}** — ${finding.ruleId}`);
                lines.push(`${finding.description}`);
                if (finding.suggestedFix) {
                    lines.push(`*Suggested fix:* ${finding.suggestedFix}`);
                }
                lines.push(`*Confidence: ${(finding.confidence * 100).toFixed(0)}%*\n`);
            }
        }

        return lines.join('\n');
    }
}
