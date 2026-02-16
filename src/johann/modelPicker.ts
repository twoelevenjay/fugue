import * as vscode from 'vscode';
import { ModelInfo, TaskComplexity, TaskType } from './types';
import { getConfig } from './config';
import { MODEL_SELECTION_GUIDE, TASK_TO_MODEL_ROUTING, TASK_TYPE_PATTERNS } from './modelSelectionGuide';
import { getMultiPassStrategy, shouldUseMultiPass } from './multiPassStrategies';

// ============================================================================
// MODEL PICKER — Intelligent model selection and escalation
//
// Key behaviors:
// - Discovers all available models via vscode.lm.selectChatModels()
// - Classifies models into cost tiers (0× free → 3× premium)
// - Prioritizes free (0×) models for appropriate tasks
// - Uses task type + complexity for intelligent routing
// - Supports non-linear escalation with cost awareness
// - Blocks Opus unless explicitly enabled
// ============================================================================

/**
 * Known model family patterns with cost multipliers and capability tiers.
 * Cost: 0 = free, 0.25-0.33 = cheap premium, 1 = standard premium, 3+ = Opus
 * Tier: 1 = basic/fast, 5 = frontier/most capable
 */
const MODEL_TIER_MAP: Array<{ 
    pattern: RegExp; 
    tier: number; 
    cost: number;
    category: string;
    family: string;
}> = [
    // === FREE MODELS (0×) — Default tier ===
    { pattern: /gpt-5.*mini/i, tier: 2, cost: 0, category: 'free', family: 'gpt-5-mini' },
    { pattern: /gpt-4\.1/i, tier: 3, cost: 0, category: 'free', family: 'gpt-4.1' },
    { pattern: /gpt-4o(?!-mini)/i, tier: 3, cost: 0, category: 'free', family: 'gpt-4o' },
    { pattern: /raptor.*mini/i, tier: 1, cost: 0, category: 'free', family: 'raptor-mini' },
    
    // === CHEAP PREMIUM (0.25× - 0.33×) ===
    { pattern: /grok.*fast/i, tier: 2, cost: 0.25, category: 'cheap-premium', family: 'grok-fast' },
    { pattern: /haiku/i, tier: 2, cost: 0.33, category: 'cheap-premium', family: 'claude-haiku' },
    { pattern: /gemini.*flash/i, tier: 3, cost: 0.33, category: 'cheap-premium', family: 'gemini-flash' },
    { pattern: /gpt-5\.1.*codex.*mini/i, tier: 3, cost: 0.33, category: 'cheap-premium', family: 'gpt-5.1-codex-mini' },
    
    // === STANDARD PREMIUM (1×) ===
    { pattern: /sonnet.*4\.5/i, tier: 4, cost: 1, category: 'standard-premium', family: 'claude-sonnet-4.5' },
    { pattern: /sonnet.*4(?!\.)/i, tier: 4, cost: 1, category: 'standard-premium', family: 'claude-sonnet-4' },
    { pattern: /gemini.*2\.5.*pro/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gemini-2.5-pro' },
    { pattern: /gemini.*3.*pro/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gemini-3-pro' },
    { pattern: /gpt-5\.3.*codex/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5.3-codex' },
    { pattern: /gpt-5\.2.*codex/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5.2-codex' },
    { pattern: /gpt-5\.1.*codex(?!.*mini)/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5.1-codex' },
    { pattern: /gpt-5\.2(?!.*codex)/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5.2' },
    { pattern: /gpt-5\.1(?!.*codex)/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5.1' },
    { pattern: /gpt-5(?!\.|\-)/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5' }, // Legacy, retiring soon
    { pattern: /gpt-5-codex/i, tier: 4, cost: 1, category: 'standard-premium', family: 'gpt-5-codex' }, // Legacy
    
    // === OPUS (3× - 10×) — Emergency only ===
    { pattern: /opus.*4\.6/i, tier: 5, cost: 3, category: 'opus', family: 'claude-opus-4.6' },
    { pattern: /opus.*4\.5/i, tier: 5, cost: 3, category: 'opus', family: 'claude-opus-4.5' },
    { pattern: /opus.*4\.1/i, tier: 5, cost: 10, category: 'opus', family: 'claude-opus-4.1' }, // Legacy, very expensive
    { pattern: /o1-pro/i, tier: 5, cost: 3, category: 'opus', family: 'o1-pro' },
];

/**
 * Maps task complexity to the ideal model tier and acceptable range.
 */
const COMPLEXITY_TO_TIER: Record<TaskComplexity, { ideal: number; min: number; max: number }> = {
    trivial: { ideal: 1, min: 1, max: 2 },
    simple:  { ideal: 2, min: 1, max: 3 },
    moderate: { ideal: 3, min: 2, max: 4 },
    complex: { ideal: 4, min: 3, max: 5 },
    expert:  { ideal: 5, min: 4, max: 5 },
};

export class ModelPicker {
    private cachedModels: ModelInfo[] = [];
    private lastRefresh: number = 0;
    private readonly CACHE_TTL_MS = 60_000; // Refresh model list every 60s

    /**
     * Check if a model is allowed based on configuration settings.
     * Checks both blockedModels patterns AND the allowOpusEscalation gate.
     */
    private isModelAllowed(modelInfo: ModelInfo): boolean {
        const config = getConfig();
        const searchStr = `${modelInfo.id} ${modelInfo.family} ${modelInfo.name}`.toLowerCase();

        // Gate 1: Block Opus models unless explicitly enabled.
        // Opus models have costMultiplier >= 3 (category 'opus' in MODEL_TIER_MAP).
        // This prevents Opus from appearing in available models, being selected
        // for any complexity level, or showing up in model summaries.
        if (modelInfo.costMultiplier >= 3 && !(config.allowOpusEscalation ?? false)) {
            return false;
        }

        // Gate 2: Check blocked models list (takes precedence over everything else)
        if (config.blockedModels.length > 0) {
            for (const pattern of config.blockedModels) {
                try {
                    const regex = new RegExp(pattern, 'i');
                    if (regex.test(searchStr)) {
                        return false; // Model is blocked
                    }
                } catch {
                    // Invalid regex, skip
                }
            }
        }

        // No blocked match = allowed
        return true;
    }

    /**
     * Discover and classify all available models.
        * Filters models based on configuration (blockedModels).
     */
    async refreshModels(): Promise<ModelInfo[]> {
        const now = Date.now();
        if (this.cachedModels.length > 0 && now - this.lastRefresh < this.CACHE_TTL_MS) {
            return this.cachedModels;
        }

        const allModels = await vscode.lm.selectChatModels();
        const classified = allModels.map(model => this.classifyModel(model));
        
        // Filter based on configuration
        this.cachedModels = classified.filter(m => this.isModelAllowed(m));
        this.lastRefresh = now;

        // Sort by tier descending (most capable first)
        this.cachedModels.sort((a, b) => b.tier - a.tier);

        return this.cachedModels;
    }

    /**
     * Classify a VS Code language model into our tier system with cost awareness.
     */
    private classifyModel(model: vscode.LanguageModelChat): ModelInfo {
        const id = model.id;
        const family = model.family;
        const vendor = model.vendor;
        const name = model.name;

        // Try to match against known patterns
        let tier = 3; // Default to 'capable' if unknown
        let costMultiplier = 1; // Default to standard premium cost
        const searchStr = `${id} ${family} ${name}`;

        for (const entry of MODEL_TIER_MAP) {
            if (entry.pattern.test(searchStr)) {
                tier = entry.tier;
                costMultiplier = entry.cost;
                break;
            }
        }

        return {
            model,
            vendor,
            family,
            id,
            name,
            tier,
            costMultiplier,
            maxInputTokens: model.maxInputTokens,
        };
    }

    /**
     * Detect task type from a task description or user request.
     * Uses pattern matching against known task indicators.
     */
    detectTaskType(description: string): TaskType {
        const lowerDesc = description.toLowerCase();

        // Check each task type's patterns
        for (const [taskType, patterns] of Object.entries(TASK_TYPE_PATTERNS)) {
            for (const pattern of patterns) {
                if (pattern.test(lowerDesc)) {
                    return taskType as TaskType;
                }
            }
        }

        // Default: if we can't detect, treat as 'generate' (most common case)
        return 'generate';
    }

    /**
     * Select the best model for a specific task type and complexity.
     * This is the main entry point for task-aware model selection.
     * 
     * Prioritizes free (0×) models first, then escalates through cost tiers
     * only if the task complexity and type require it.
     * 
     * If modelPickerEnabled is false, returns the fixed model instead.
     */
    async selectForTask(
        taskType: TaskType,
        complexity: TaskComplexity,
        excludeModelIds: string[] = []
    ): Promise<ModelInfo | undefined> {
        const config = getConfig();
        
        // If picker is disabled, use fixed model
        if (!config.modelPickerEnabled) {
            return this.getFixedModel();
        }

        const models = await this.refreshModels();
        const available = models.filter(m => !excludeModelIds.includes(m.id));

        if (available.length === 0) return undefined;

        // Get routing recommendation for this task type
        const routing = TASK_TO_MODEL_ROUTING[taskType];
        if (!routing) {
            // Fallback to complexity-based selection
            return this.selectForComplexity(complexity, excludeModelIds);
        }

        // Find models matching the preferred cost tier
        const preferredCost = routing.preferredCost;
        let candidates = available.filter(m => m.costMultiplier === preferredCost);

        // If no models at preferred cost, try escalating according to routing rule
        if (candidates.length === 0 && routing.escalateTo.length > 0) {
            if (complexity === 'complex' || complexity === 'expert') {
                // For hard tasks, escalate to next cost tier
                const nextCost = this.getNextCostTier(preferredCost);
                candidates = available.filter(m => m.costMultiplier === nextCost);
            }
        }

        // If still no candidates, fall back to any available model at preferred cost or lower
        if (candidates.length === 0) {
            candidates = available.filter(m => m.costMultiplier <= preferredCost);
        }

        // If STILL no candidates, just use any available model (last resort)
        if (candidates.length === 0) {
            candidates = available;
        }

        // Among candidates, pick the one with appropriate tier for complexity
        const tierConfig = COMPLEXITY_TO_TIER[complexity];
        candidates.sort((a, b) => {
            // Primary: closeness to ideal tier
            const distA = Math.abs(a.tier - tierConfig.ideal);
            const distB = Math.abs(b.tier - tierConfig.ideal);
            if (distA !== distB) return distA - distB;
            
            // Secondary: prefer lower cost
            return a.costMultiplier - b.costMultiplier;
        });

        return candidates[0];
    }

    /**
     * Get the next cost tier for escalation.
     * 0 → 0.33 → 1 → 3
     */
    private getNextCostTier(currentCost: number): number {
        if (currentCost === 0) return 0.33;
        if (currentCost <= 0.33) return 1;
        if (currentCost === 1) return 3;
        return 3; // Already at max
    }

    /**
     * Select the best model for a given task complexity.
     * Returns the model closest to the ideal tier for the complexity level.
     * Prioritizes free (0×) models when appropriate.
     * 
     * If modelPickerEnabled is false, returns the fixed model instead.
     */
    async selectForComplexity(
        complexity: TaskComplexity,
        excludeModelIds: string[] = []
    ): Promise<ModelInfo | undefined> {
        const config = getConfig();
        
        // If picker is disabled, use fixed model
        if (!config.modelPickerEnabled) {
            return this.getFixedModel();
        }

        const models = await this.refreshModels();
        const available = models.filter(m => !excludeModelIds.includes(m.id));

        if (available.length === 0) return undefined;

        const tierConfig = COMPLEXITY_TO_TIER[complexity];

        // Find model closest to ideal tier within acceptable range
        // Prioritize lower cost when tier is equal
        const candidates = available.filter(
            m => m.tier >= tierConfig.min && m.tier <= tierConfig.max
        );

        if (candidates.length > 0) {
            // Sort by closeness to ideal tier, then by cost
            candidates.sort((a, b) => {
                const distA = Math.abs(a.tier - tierConfig.ideal);
                const distB = Math.abs(b.tier - tierConfig.ideal);
                if (distA !== distB) return distA - distB;
                
                // Prefer lower cost when tier distance is equal
                return a.costMultiplier - b.costMultiplier;
            });
            return candidates[0];
        }

        // If no model in range, pick the closest available model
        available.sort((a, b) => {
            const distA = Math.abs(a.tier - tierConfig.ideal);
            const distB = Math.abs(b.tier - tierConfig.ideal);
            if (distA !== distB) return distA - distB;
            
            return a.costMultiplier - b.costMultiplier;
        });

        return available[0];
    }

    /**
     * Given a failed attempt, pick the next model to try.
     * Escalation is cost-aware and follows the 0× → 0.33× → 1× → 3× path.
     * 
     * Never auto-selects Opus (cost 3+) unless explicitly enabled via config.
     * 
     * If modelPickerEnabled is false, always returns the fixed model.
     */
    async escalate(
        complexity: TaskComplexity,
        failedModelIds: string[],
        failureReason: string
    ): Promise<ModelInfo | undefined> {
        const config = getConfig();
        
        // If picker is disabled, escalation is not possible - return fixed model
        if (!config.modelPickerEnabled) {
            return this.getFixedModel();
        }

        const models = await this.refreshModels();
        const available = models.filter(m => !failedModelIds.includes(m.id));

        if (available.length === 0) return undefined;

        // Get cost of highest failed model
        const failedModels = failedModelIds
            .map(id => models.find(m => m.id === id))
            .filter((m): m is ModelInfo => m !== undefined);
        
        const highestFailedCost = failedModels.length > 0
            ? Math.max(...failedModels.map(m => m.costMultiplier))
            : 0;

        // Analyze the failure to decide escalation direction
        const shouldGoUp = this.shouldEscalateUp(failureReason);

        if (shouldGoUp) {
            // Escalate up: next cost tier
            const nextCost = this.getNextCostTier(highestFailedCost);
            
            // IMPORTANT: Block Opus (3+) unless explicitly enabled
            const allowOpus = config.allowOpusEscalation ?? false;
            if (nextCost >= 3 && !allowOpus) {
                // Don't escalate to Opus - return best non-Opus model
                const nonOpusCandidates = available.filter(m => m.costMultiplier < 3);
                if (nonOpusCandidates.length === 0) {
                    // No non-Opus models available
                    return undefined;
                }
                // Pick best non-Opus model for this complexity
                return this.selectFromCandidates(nonOpusCandidates, complexity);
            }

            // Find models at next cost tier
            let upCandidates = available.filter(m => m.costMultiplier === nextCost);
            
            // If no models at exact cost, try any higher cost up to next tier
            if (upCandidates.length === 0) {
                upCandidates = available.filter(m => 
                    m.costMultiplier > highestFailedCost && 
                    m.costMultiplier <= nextCost
                );
            }

            if (upCandidates.length > 0) {
                return this.selectFromCandidates(upCandidates, complexity);
            }
        } else {
            // Escalate down — the model may have been overthinking
            const lowestFailedCost = failedModels.length > 0
                ? Math.min(...failedModels.map(m => m.costMultiplier))
                : 3;

            const downCandidates = available.filter(m => m.costMultiplier < lowestFailedCost);
            if (downCandidates.length > 0) {
                return this.selectFromCandidates(downCandidates, complexity);
            }
        }

        // Fallback: just pick the best available untried model for this complexity
        return this.selectForComplexity(complexity, failedModelIds);
    }

    /**
     * Select best model from a set of candidates based on complexity.
     */
    private selectFromCandidates(candidates: ModelInfo[], complexity: TaskComplexity): ModelInfo {
        const tierConfig = COMPLEXITY_TO_TIER[complexity];
        
        candidates.sort((a, b) => {
            // Primary: closeness to ideal tier
            const distA = Math.abs(a.tier - tierConfig.ideal);
            const distB = Math.abs(b.tier - tierConfig.ideal);
            if (distA !== distB) return distA - distB;
            
            // Secondary: prefer lower cost
            return a.costMultiplier - b.costMultiplier;
        });

        return candidates[0];
    }

    /**
     * Heuristic: should we escalate up or down based on the failure reason?
     */
    private shouldEscalateUp(failureReason: string): boolean {
        const downIndicators = [
            /too verbose/i,
            /over.?engineer/i,
            /too complex/i,
            /overthink/i,
            /hallucin/i,
            /off.?topic/i,
            /wrong approach entirely/i,
        ];

        for (const pattern of downIndicators) {
            if (pattern.test(failureReason)) {
                return false;
            }
        }

        // Default: escalate up (task was too hard for the model)
        return true;
    }

    /**
     * Get the fixed model specified in configuration.
     * Falls back to first available allowed model if fixedModel is not set or not found.
     */
    private async getFixedModel(): Promise<ModelInfo | undefined> {
        const config = getConfig();
        const models = await this.refreshModels();

        if (models.length === 0) return undefined;

        // If fixedModel is specified, try to find it
        if (config.fixedModel) {
            const fixedPattern = config.fixedModel.toLowerCase();
            const match = models.find(m => 
                m.id.toLowerCase().includes(fixedPattern) ||
                m.family.toLowerCase().includes(fixedPattern) ||
                m.name.toLowerCase().includes(fixedPattern)
            );
            if (match) return match;
        }

        // Fallback: return first available allowed model
        return models[0];
    }

    /**
     * Get a specific model by ID.
     */
    async getModel(modelId: string): Promise<ModelInfo | undefined> {
        const models = await this.refreshModels();
        return models.find(m => m.id === modelId);
    }

    /**
     * Get all available models, sorted by tier.
     */
    async getAllModels(): Promise<ModelInfo[]> {
        return this.refreshModels();
    }

    /**
     * Get a human-readable summary of available models.
     */
    async getModelSummary(): Promise<string> {
        const config = getConfig();
        const models = await this.refreshModels();
        
        const lines: string[] = [];
        
        // Model picker status
        if (!config.modelPickerEnabled) {
            lines.push('🔒 **Model picker is DISABLED**');
            lines.push(`Fixed model: ${config.fixedModel || '(first available)'}`);
            lines.push('');
        } else {
            lines.push('✅ **Model picker is ENABLED**');
            lines.push('');
        }
        
        // Opus status
        if (config.allowOpusEscalation) {
            lines.push('⚡ **Opus escalation:** ENABLED (3×+ cost models available)');
        } else {
            lines.push('🔒 **Opus escalation:** DISABLED (Opus/O1-Pro models hidden)');
        }
        lines.push('');

        // Model restrictions
        if (config.blockedModels.length > 0) {
            lines.push(`🚫 **Blocked models:** ${config.blockedModels.join(', ')}`);
            lines.push('');
        }
        
        if (config.blockedModels.length === 0 && !config.allowOpusEscalation) {
            lines.push('ℹ️ No additional model restrictions (Opus blocked by default)');
            lines.push('');
        } else if (config.blockedModels.length === 0 && config.allowOpusEscalation) {
            lines.push('ℹ️ No model restrictions — all discovered models allowed (including Opus)');
            lines.push('');
        }
        
        // Available models
        if (models.length === 0) {
            lines.push('⚠️ **No models available** (check your restrictions or install more models)');
            return lines.join('\n');
        }
        
        lines.push(`**Available models (${models.length}):**`);
        for (const m of models) {
            lines.push(`  [Tier ${m.tier}] ${m.name} (${m.family}) — ${m.vendor}`);
        }
        
        return lines.join('\n');
    }

    /**
     * Get a diagnostic report showing which models are blocked/allowed.
     * Useful for debugging why certain models aren't available.
     */
    async getModelDiagnostics(): Promise<string> {
        const config = getConfig();
        const allModels = await vscode.lm.selectChatModels();
        const classified = allModels.map(model => this.classifyModel(model));
        
        const lines: string[] = ['=== Model Diagnostics ===', ''];
        
        // Configuration summary
        lines.push('**Configuration:**');
        lines.push(`- Model Picker: ${config.modelPickerEnabled ? 'Enabled' : 'Disabled'}`);
        lines.push(`- Fixed Model: ${config.fixedModel || '(not set)'}`);
        lines.push(`- Opus Escalation: ${config.allowOpusEscalation ? 'ENABLED' : 'DISABLED (default)'}`);
        lines.push(`- Blocked Patterns: ${config.blockedModels.length > 0 ? config.blockedModels.join(', ') : '(none)'}`);
        lines.push('');
        
        // Model availability
        lines.push('**All Discovered Models:**');
        for (const m of classified) {
            const allowed = this.isModelAllowed(m);
            const status = allowed ? '✅ ALLOWED' : '🚫 BLOCKED';
            lines.push(`  ${status} [Tier ${m.tier}] ${m.name} (${m.family})`);
        }
        
        const allowedCount = classified.filter(m => this.isModelAllowed(m)).length;
        lines.push('');
        lines.push(`**Summary:** ${allowedCount}/${classified.length} models available to Johann`);
        
        return lines.join('\n');
    }

    /**
     * Check if a task should use multi-pass execution.
     * This is exported for use by the orchestrator.
     */
    shouldUseMultiPassForTask(taskType: TaskType, complexity: TaskComplexity): boolean {
        return shouldUseMultiPass(taskType, complexity);
    }

    /**
     * Get the recommended multi-pass strategy for a task.
     * Returns null if single-pass is recommended.
     */
    getMultiPassStrategyForTask(taskType: TaskType) {
        return getMultiPassStrategy(taskType);
    }
}
