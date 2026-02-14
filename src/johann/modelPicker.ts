import * as vscode from 'vscode';
import { ModelInfo, TaskComplexity } from './types';

// ============================================================================
// MODEL PICKER — Intelligent model selection and escalation

//
// Key behaviors:
// - Discovers all available models via vscode.lm.selectChatModels()
// - Classifies models into capability tiers
// - Selects the best model for a given task complexity
// - Supports non-linear escalation (can go up OR down in capability)
// - One try per model — if it fails criteria, move to next candidate
// ============================================================================

/**
 * Known model family patterns and their approximate capability tiers.
 * Tier 1 = basic/fast, Tier 5 = frontier/most capable.
 * This mapping is used when we can't determine capability from the model metadata.
 */
const MODEL_TIER_MAP: Array<{ pattern: RegExp; tier: number; category: string }> = [
    // Tier 5 — Frontier
    { pattern: /opus/i, tier: 5, category: 'frontier' },
    { pattern: /o1-pro/i, tier: 5, category: 'frontier' },
    { pattern: /gpt-?5/i, tier: 5, category: 'frontier' },

    // Tier 4 — Advanced
    { pattern: /o1(?!-mini|-preview)/i, tier: 4, category: 'advanced' },
    { pattern: /o3(?!-mini)/i, tier: 4, category: 'advanced' },
    { pattern: /sonnet/i, tier: 4, category: 'advanced' },
    { pattern: /gpt-?4o(?!-mini)/i, tier: 4, category: 'advanced' },
    { pattern: /gemini.*pro/i, tier: 4, category: 'advanced' },
    { pattern: /codex/i, tier: 4, category: 'advanced' },

    // Tier 3 — Capable
    { pattern: /gpt-?4(?!o)/i, tier: 3, category: 'capable' },
    { pattern: /o1-preview/i, tier: 3, category: 'capable' },
    { pattern: /o3-mini/i, tier: 3, category: 'capable' },
    { pattern: /gemini.*flash/i, tier: 3, category: 'capable' },
    { pattern: /claude-3/i, tier: 3, category: 'capable' },

    // Tier 2 — Standard
    { pattern: /gpt-?4o-mini/i, tier: 2, category: 'standard' },
    { pattern: /o1-mini/i, tier: 2, category: 'standard' },
    { pattern: /haiku/i, tier: 2, category: 'standard' },
    { pattern: /gemini.*nano/i, tier: 2, category: 'standard' },

    // Tier 1 — Basic/Fast
    { pattern: /gpt-?3/i, tier: 1, category: 'basic' },
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
     * Discover and classify all available models.
     */
    async refreshModels(): Promise<ModelInfo[]> {
        const now = Date.now();
        if (this.cachedModels.length > 0 && now - this.lastRefresh < this.CACHE_TTL_MS) {
            return this.cachedModels;
        }

        const allModels = await vscode.lm.selectChatModels();
        this.cachedModels = allModels.map(model => this.classifyModel(model));
        this.lastRefresh = now;

        // Sort by tier descending (most capable first)
        this.cachedModels.sort((a, b) => b.tier - a.tier);

        return this.cachedModels;
    }

    /**
     * Classify a VS Code language model into our tier system.
     */
    private classifyModel(model: vscode.LanguageModelChat): ModelInfo {
        const id = model.id;
        const family = model.family;
        const vendor = model.vendor;
        const name = model.name;

        // Try to match against known patterns
        let tier = 3; // Default to 'capable' if unknown
        const searchStr = `${id} ${family} ${name}`;

        for (const entry of MODEL_TIER_MAP) {
            if (entry.pattern.test(searchStr)) {
                tier = entry.tier;
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
            maxInputTokens: model.maxInputTokens,
        };
    }

    /**
     * Select the best model for a given task complexity.
     * Returns the model closest to the ideal tier for the complexity level.
     */
    async selectForComplexity(
        complexity: TaskComplexity,
        excludeModelIds: string[] = []
    ): Promise<ModelInfo | undefined> {
        const models = await this.refreshModels();
        const available = models.filter(m => !excludeModelIds.includes(m.id));

        if (available.length === 0) return undefined;

        const tierConfig = COMPLEXITY_TO_TIER[complexity];

        // Find model closest to ideal tier within acceptable range
        const candidates = available.filter(
            m => m.tier >= tierConfig.min && m.tier <= tierConfig.max
        );

        if (candidates.length > 0) {
            // Sort by closeness to ideal tier
            candidates.sort((a, b) => {
                const distA = Math.abs(a.tier - tierConfig.ideal);
                const distB = Math.abs(b.tier - tierConfig.ideal);
                return distA - distB;
            });
            return candidates[0];
        }

        // If no model in range, pick the closest available model
        available.sort((a, b) => {
            const distA = Math.abs(a.tier - tierConfig.ideal);
            const distB = Math.abs(b.tier - tierConfig.ideal);
            return distA - distB;
        });

        return available[0];
    }

    /**
     * Given a failed attempt, pick the next model to try.
     * Escalation is non-linear — it picks the best UNTRIED model for the complexity.
     * If the task was too hard, it may go up. If the model was overkill
     * (sometimes large models overthink simple tasks), it may go down.
     */
    async escalate(
        complexity: TaskComplexity,
        failedModelIds: string[],
        failureReason: string
    ): Promise<ModelInfo | undefined> {
        const models = await this.refreshModels();
        const available = models.filter(m => !failedModelIds.includes(m.id));

        if (available.length === 0) return undefined;

        // Analyze the failure to decide escalation direction
        const shouldGoUp = this.shouldEscalateUp(failureReason);

        if (shouldGoUp) {
            // Pick the lowest-tier model that's ABOVE the highest failed model
            const highestFailedTier = Math.max(
                ...failedModelIds.map(id => {
                    const m = models.find(m => m.id === id);
                    return m ? m.tier : 0;
                })
            );
            const upCandidates = available.filter(m => m.tier > highestFailedTier);
            if (upCandidates.length > 0) {
                // Pick the lowest tier among up-candidates (escalate minimally)
                upCandidates.sort((a, b) => a.tier - b.tier);
                return upCandidates[0];
            }
        } else {
            // Escalate down — the model may have been overthinking
            const lowestFailedTier = Math.min(
                ...failedModelIds.map(id => {
                    const m = models.find(m => m.id === id);
                    return m ? m.tier : 5;
                })
            );
            const downCandidates = available.filter(m => m.tier < lowestFailedTier);
            if (downCandidates.length > 0) {
                // Pick the highest tier among down-candidates
                downCandidates.sort((a, b) => b.tier - a.tier);
                return downCandidates[0];
            }
        }

        // Fallback: just pick the best available untried model for this complexity
        return this.selectForComplexity(complexity, failedModelIds);
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
        const models = await this.refreshModels();
        if (models.length === 0) return 'No models available.';

        const lines = ['Available models:'];
        for (const m of models) {
            lines.push(`  [Tier ${m.tier}] ${m.name} (${m.family}) — ${m.vendor}`);
        }
        return lines.join('\n');
    }
}
