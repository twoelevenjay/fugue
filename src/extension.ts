import * as vscode from 'vscode';
import { registerJohannParticipant } from './johann/participant';
import { registerSetupCommand, showCliMissingNotification } from './johann/copilotCliStatus';
import { getActivityPanel } from './johann/workerActivityPanel';
import { createLogger as createRambleLogger, getLogger as getRambleLogger } from './ramble/logger';
import { RambleDebugConversationLog } from './ramble/debugConversationLog';
import { sendToLLMWithLogging } from './ramble/llmHelpers';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

type SessionState = 'IDLE' | 'WAITING_FOR_ANSWERS' | 'DONE';

interface ContextPacket {
    goal: string;
    currentState: string;
    constraints: string[];
    inputsArtifacts: string[];
    outputFormat: string;
    successCriteria: string[];
    nonGoals: string[];
    additionalContext: string;
    /** Potential talk-to-text transcription issues detected and how they were resolved or flagged */
    suspectedTranscriptionIssues: string[];
}

interface PendingQuestion {
    index: number;
    question: string;
    field: string;
}

interface Session {
    state: SessionState;
    rawRamble: string;
    contextPacket: ContextPacket;
    pendingQuestions: PendingQuestion[];
    questionRound: number;
    workspaceContext: string;
}

interface AnalysisResult {
    contextPacket: ContextPacket;
    missingInfo: PendingQuestion[];
    isComplete: boolean;
}

interface WorkspaceContext {
    copilotInstructions: string;
    readmes: { path: string; content: string }[];
    workspaceStructure: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const STATE_KEY = 'ramble.session';
const LAST_PROMPT_KEY = 'ramble.lastCompiledPrompt';
const WORKSPACE_CONTEXT_KEY = 'ramble.workspaceContext';
const MAX_QUESTION_ROUNDS = 3;
const MAX_README_SIZE = 5000; // Truncate large READMEs
const MAX_INSTRUCTIONS_SIZE = 10000;
const LARGE_INPUT_THRESHOLD = 8000; // Characters before chunking kicks in
const MAX_INPUT_SIZE = 100000; // Hard limit on input size
const CHUNK_SIZE = 6000; // Characters per chunk for analysis

// ============================================================================
// WORKSPACE CONTEXT GATHERING
// ============================================================================

async function findFile(pattern: string): Promise<vscode.Uri | undefined> {
    const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1);
    return files[0];
}

async function readFileContent(uri: vscode.Uri, maxSize: number): Promise<string> {
    try {
        const content = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(content).toString('utf-8');
        if (text.length > maxSize) {
            return text.substring(0, maxSize) + '\n\n[... truncated ...]';
        }
        return text;
    } catch {
        return '';
    }
}

async function getWorkspaceStructure(): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return '';
    }

    const lines: string[] = ['Workspace structure:'];

    for (const folder of workspaceFolders) {
        lines.push(`\n📁 ${folder.name}/`);

        // Get top-level directories and key files
        try {
            const entries = await vscode.workspace.fs.readDirectory(folder.uri);
            const dirs: string[] = [];
            const files: string[] = [];

            for (const [name, type] of entries) {
                if (name.startsWith('.') && name !== '.github') {
                    continue;
                }
                if (
                    name === 'node_modules' ||
                    name === 'dist' ||
                    name === 'out' ||
                    name === 'build'
                ) {
                    continue;
                }

                if (type === vscode.FileType.Directory) {
                    dirs.push(name);
                } else if (type === vscode.FileType.File) {
                    // Only include important files
                    if (
                        name.match(
                            /^(README|CHANGELOG|package\.json|tsconfig\.json|\.env\.example)$/i,
                        ) ||
                        name.endsWith('.md')
                    ) {
                        files.push(name);
                    }
                }
            }

            for (const dir of dirs.sort()) {
                lines.push(`  📁 ${dir}/`);
            }
            for (const file of files.sort()) {
                lines.push(`  📄 ${file}`);
            }
        } catch {
            // Ignore errors
        }
    }

    return lines.join('\n');
}

async function gatherWorkspaceContext(): Promise<WorkspaceContext> {
    const context: WorkspaceContext = {
        copilotInstructions: '',
        readmes: [],
        workspaceStructure: '',
    };

    // 1. Find and read .github/copilot-instructions.md
    const instructionsUri = await findFile('.github/copilot-instructions.md');
    if (instructionsUri) {
        context.copilotInstructions = await readFileContent(instructionsUri, MAX_INSTRUCTIONS_SIZE);
    }

    // 2. Also check for CLAUDE.md or other instruction files
    const claudeUri = await findFile('**/CLAUDE.md');
    if (claudeUri && !context.copilotInstructions) {
        context.copilotInstructions = await readFileContent(claudeUri, MAX_INSTRUCTIONS_SIZE);
    }

    // 3. Find READMEs in workspace root and immediate subdirectories
    const readmeFiles = await vscode.workspace.findFiles('**/README.md', '**/node_modules/**', 10);
    for (const uri of readmeFiles) {
        const relativePath = vscode.workspace.asRelativePath(uri);
        // Only include root and first-level READMEs
        if (relativePath.split('/').length <= 2) {
            const content = await readFileContent(uri, MAX_README_SIZE);
            if (content) {
                context.readmes.push({ path: relativePath, content });
            }
        }
    }

    // 4. Get workspace structure
    context.workspaceStructure = await getWorkspaceStructure();

    return context;
}

function formatWorkspaceContext(ctx: WorkspaceContext): string {
    const parts: string[] = [];

    if (ctx.copilotInstructions) {
        parts.push('=== WORKSPACE INSTRUCTIONS (.github/copilot-instructions.md) ===');
        parts.push(ctx.copilotInstructions);
        parts.push('');
    }

    if (ctx.workspaceStructure) {
        parts.push('=== WORKSPACE STRUCTURE ===');
        parts.push(ctx.workspaceStructure);
        parts.push('');
    }

    if (ctx.readmes.length > 0) {
        parts.push('=== PROJECT READMES ===');
        for (const readme of ctx.readmes) {
            parts.push(`\n--- ${readme.path} ---`);
            parts.push(readme.content);
        }
        parts.push('');
    }

    return parts.join('\n');
}

// ============================================================================
// CODEBASE ANALYSIS FOR MISSING INFO
// ============================================================================

interface ResolutionAttempt {
    question: PendingQuestion;
    resolved: boolean;
    answer?: string;
    source?: string; // 'codebase' or 'knowledge'
}

/**
 * Attempt to resolve missing information by analyzing the codebase.
 * Uses semantic and keyword search to find relevant files, then asks LLM to extract answers.
 */
async function analyzeCodebaseForMissingInfo(
    missingInfo: PendingQuestion[],
    contextPacket: ContextPacket,
    workspaceContext: string,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
    response: vscode.ChatResponseStream,
): Promise<ResolutionAttempt[]> {
    const attempts: ResolutionAttempt[] = [];

    response.markdown('🔍 Searching codebase for answers before asking questions...\n\n');

    for (const question of missingInfo) {
        if (token.isCancellationRequested) {
            break;
        }

        // Build search query from question and field
        const searchTerms = extractSearchTerms(question.question, question.field, contextPacket);

        response.markdown(
            `- Analyzing: "${question.question.substring(0, 80)}${question.question.length > 80 ? '...' : ''}"\n`,
        );

        // Search codebase
        const codebaseFindings = await searchCodebaseForAnswer(searchTerms, token);

        if (codebaseFindings.length > 0) {
            // Ask LLM to analyze findings and attempt resolution
            const resolution = await attemptCodebaseResolution(
                question,
                codebaseFindings,
                contextPacket,
                workspaceContext,
                model,
                token,
            );

            attempts.push(resolution);
        } else {
            // No codebase findings
            attempts.push({
                question,
                resolved: false,
            });
        }
    }

    response.markdown('\n');
    return attempts;
}

/**
 * Extract search terms from a question to find relevant code.
 */
function extractSearchTerms(
    question: string,
    field: string,
    contextPacket: ContextPacket,
): string[] {
    const terms: string[] = [];

    // Extract quoted terms
    const quotedMatch = question.match(/"([^"]+)"/g);
    if (quotedMatch) {
        terms.push(...quotedMatch.map((q) => q.replace(/"/g, '')));
    }

    // Extract technical terms (camelCase, PascalCase, snake_case, kebab-case)
    const techTerms = question.match(
        /\b[a-z]+[A-Z][a-zA-Z]*\b|\b[A-Z][a-z]+(?:[A-Z][a-z]+)*\b|\b[a-z]+_[a-z_]+\b|\b[a-z]+-[a-z-]+\b/g,
    );
    if (techTerms) {
        terms.push(...techTerms);
    }

    // Extract from context packet (e.g., if question is about a feature mentioned in goal/currentState)
    const contextText = `${contextPacket.goal} ${contextPacket.currentState} ${contextPacket.additionalContext}`;
    const contextWords = contextText.split(/\s+/).filter((w) => w.length > 3);
    const questionWords = question.toLowerCase().split(/\s+/);

    // Find overlapping significant words
    const overlapping = contextWords.filter((w) =>
        questionWords.some((qw) => qw.includes(w.toLowerCase()) || w.toLowerCase().includes(qw)),
    );
    terms.push(...overlapping.slice(0, 3));

    // Add the field name as a hint
    if (field && field !== 'transcription') {
        terms.push(field);
    }

    return [...new Set(terms)].filter((t) => t.length > 2);
}

/**
 * Search the codebase using semantic and grep search.
 */
async function searchCodebaseForAnswer(
    searchTerms: string[],
    token: vscode.CancellationToken,
): Promise<Array<{ path: string; content: string; source: string }>> {
    const findings = new Map<string, { path: string; content: string; source: string }>();

    if (searchTerms.length === 0) {
        return [];
    }

    // TODO: Semantic search - API not yet available in VS Code
    // const semanticQuery = searchTerms.join(' ');
    // try {
    //     const semanticResults = await vscode.lm.tools.search(semanticQuery);
    //     ...
    // } catch {
    //     // Semantic search failed, continue
    // }

    // Grep search for specific terms
    for (const term of searchTerms.slice(0, 3)) {
        if (token.isCancellationRequested) {
            break;
        }
        try {
            const files = await vscode.workspace.findFiles(
                '**/*.{ts,js,json,md,txt}',
                '**/node_modules/**',
                5,
            );

            for (const file of files) {
                const content = await readFileContent(file, 3000);
                if (content.toLowerCase().includes(term.toLowerCase())) {
                    const key = file.fsPath;
                    if (!findings.has(key)) {
                        findings.set(key, {
                            path: vscode.workspace.asRelativePath(file),
                            content,
                            source: 'grep',
                        });
                    }
                }
                if (findings.size >= 5) {
                    break;
                }
            }
        } catch {
            // Continue
        }
        if (findings.size >= 5) {
            break;
        }
    }

    return Array.from(findings.values());
}

/**
 * Ask LLM to analyze codebase findings and attempt to answer the question.
 */
async function attemptCodebaseResolution(
    question: PendingQuestion,
    findings: Array<{ path: string; content: string; source: string }>,
    contextPacket: ContextPacket,
    workspaceContext: string,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
): Promise<ResolutionAttempt> {
    const findingsText = findings
        .map((f) => `--- ${f.path} (found via ${f.source}) ---\n${f.content}`)
        .join('\n\n');

    const resolutionPrompt = `You are analyzing codebase files to answer a missing information question.

QUESTION: ${question.question}
FIELD: ${question.field}

CONTEXT FROM USER'S REQUEST:
Goal: ${contextPacket.goal}
Current State: ${contextPacket.currentState}
${contextPacket.additionalContext ? `Additional Context: ${contextPacket.additionalContext}` : ''}

CODEBASE FILES FOUND:
${findingsText}

${workspaceContext ? `WORKSPACE CONTEXT:\n${workspaceContext}\n\n` : ''}

TASK: Analyze the codebase files and determine if they contain enough information to answer the question.

CRITICAL RULES:
1. If the files clearly answer the question, provide the answer.
2. If the files provide partial information but not enough to fully answer, respond with "PARTIAL" and explain what's unclear.
3. If the files don't answer the question, respond with "UNRESOLVED".
4. DO NOT GUESS or make assumptions. Only answer if the codebase explicitly provides the information.
5. DO NOT use training knowledge here - only what's in the codebase files.

Return JSON:
{
  "resolved": true/false,
  "answer": "The answer from the codebase, or empty string if unresolved",
  "confidence": "HIGH" or "PARTIAL" or "UNRESOLVED",
  "reasoning": "Brief explanation of why you could/couldn't answer from the codebase"
}

Return ONLY valid JSON.`;

    try {
        const result = await sendToLLMWithLogging(model, resolutionPrompt, '', token, {
            phase: 'codebase-analysis',
            label: `Codebase resolution: ${question.question.substring(0, 50)}`,
        });
        const parsed = parseJSON<{
            resolved: boolean;
            answer: string;
            confidence: string;
            reasoning: string;
        }>(result);

        if (parsed && parsed.resolved && parsed.confidence === 'HIGH' && parsed.answer) {
            return {
                question,
                resolved: true,
                answer: parsed.answer,
                source: 'codebase',
            };
        }
    } catch {
        // Resolution failed
    }

    return {
        question,
        resolved: false,
    };
}

/**
 * Attempt to resolve missing information using training knowledge (only if unambiguous).
 */
async function attemptKnowledgeResolution(
    unresolvedQuestions: PendingQuestion[],
    contextPacket: ContextPacket,
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
    response: vscode.ChatResponseStream,
): Promise<ResolutionAttempt[]> {
    const attempts: ResolutionAttempt[] = [];

    if (unresolvedQuestions.length === 0) {
        return attempts;
    }

    response.markdown('🧠 Attempting knowledge resolution (only unambiguous facts)...\n\n');

    for (const question of unresolvedQuestions) {
        if (token.isCancellationRequested) {
            break;
        }

        const knowledgePrompt = `You are attempting to answer a question using ONLY your training knowledge.

QUESTION: ${question.question}
FIELD: ${question.field}

CONTEXT FROM USER'S REQUEST:
Goal: ${contextPacket.goal}
Current State: ${contextPacket.currentState}

CRITICAL RULES:
1. ONLY answer if the question asks for a FACTUAL, UNAMBIGUOUS, WIDELY-ESTABLISHED fact.
   Examples of what you CAN answer:
   - "Is React compatible with TypeScript?" → YES (unambiguous fact)
   - "What is the default port for PostgreSQL?" → 5432 (unambiguous fact)
   - "Does npm support workspaces?" → YES (unambiguous fact)

2. DO NOT answer if:
   - The question requires project-specific knowledge (file paths, variable names, architecture decisions)
   - There are multiple possible answers depending on context
   - The answer depends on versions, configurations, or implementation details
   - You are not 100% certain
   - The question involves compatibility between specific versions or less common packages

3. If you cannot answer with absolute certainty, respond with "UNRESOLVED".
4. DO NOT GUESS. DO NOT ASSUME. If in doubt, mark as UNRESOLVED.

Return JSON:
{
  "resolved": true/false,
  "answer": "The unambiguous factual answer, or empty string if unresolved",
  "certainty": "ABSOLUTE" or "UNCERTAIN",
  "reasoning": "Brief explanation"
}

Return ONLY valid JSON.`;

        try {
            const result = await sendToLLMWithLogging(model, knowledgePrompt, '', token, {
                phase: 'web-research',
                label: `Knowledge resolution: ${question.question.substring(0, 50)}`,
            });
            const parsed = parseJSON<{
                resolved: boolean;
                answer: string;
                certainty: string;
                reasoning: string;
            }>(result);

            if (parsed && parsed.resolved && parsed.certainty === 'ABSOLUTE' && parsed.answer) {
                response.markdown(
                    `  ✓ Resolved: "${question.question.substring(0, 60)}..." from training knowledge\n`,
                );
                attempts.push({
                    question,
                    resolved: true,
                    answer: parsed.answer,
                    source: 'knowledge',
                });
            } else {
                attempts.push({
                    question,
                    resolved: false,
                });
            }
        } catch {
            attempts.push({
                question,
                resolved: false,
            });
        }
    }

    response.markdown('\n');
    return attempts;
}

/**
 * Merge resolved answers into the context packet.
 */
async function mergeResolvedAnswers(
    contextPacket: ContextPacket,
    resolvedAttempts: ResolutionAttempt[],
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
): Promise<ContextPacket> {
    if (resolvedAttempts.length === 0) {
        return contextPacket;
    }

    const answersText = resolvedAttempts
        .map(
            (a) =>
                `Q: ${a.question.question}\nField: ${a.question.field}\nAnswer (from ${a.source}): ${a.answer}`,
        )
        .join('\n\n');

    const mergePrompt = `You are integrating newly discovered information into a context packet.

EXISTING CONTEXT PACKET:
${JSON.stringify(contextPacket, null, 2)}

NEWLY RESOLVED INFORMATION (from codebase analysis or factual knowledge):
${answersText}

TASK: Update the context packet by adding the new information to the appropriate fields.
- If a field was empty, fill it in
- If adding to an array (constraints, inputsArtifacts, etc.), append the new items
- If adding to additionalContext, append the new information
- Preserve all existing information
- DO NOT duplicate information

Return the updated context packet as JSON with the same structure.
Return ONLY valid JSON.`;

    try {
        const result = await sendToLLMWithLogging(model, mergePrompt, '', token, {
            phase: 'merge',
            label: `Merge ${resolvedAttempts.length} resolved answers into context packet`,
        });
        const parsed = parseJSON<ContextPacket>(result);
        if (parsed) {
            return parsed;
        }
    } catch {
        // Fallback: return original
    }

    return contextPacket;
}

// ============================================================================
// LLM INTERACTION
// ============================================================================

interface ModelCapabilities {
    supportsTools: boolean;
    modelId: string;
    modelFamily: string;
}

/**
 * Check if a model supports tool calling.
 * Returns capability info for the model.
 */
function checkModelCapabilities(model: vscode.LanguageModelChat): ModelCapabilities {
    const modelId = model.id.toLowerCase();
    const modelFamily = model.family.toLowerCase();

    // Models known to support tools
    const toolSupportedModels = ['claude', 'o1', 'o3', 'gpt-4o', 'gpt-4-turbo'];

    // Check if model family supports tools
    const supportsTools = toolSupportedModels.some(
        (supported) => modelFamily.includes(supported) || modelId.includes(supported),
    );

    return {
        supportsTools,
        modelId: model.id,
        modelFamily: model.family,
    };
}

async function getLLM(): Promise<vscode.LanguageModelChat | undefined> {
    // Get the default model (respects user's selection in VS Code)
    const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
    });

    if (models.length === 0) {
        // Fallback to any available model
        const anyModels = await vscode.lm.selectChatModels();
        return anyModels[0];
    }

    // Return the first model (user's default selection)
    return models[0];
}

async function sendToLLM(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken,
    enableTools: boolean = false,
): Promise<string> {
    // Wrapper for backward compatibility - delegates to sendToLLMWithLogging
    // Individual calls should migrate to sendToLLMWithLogging with specific phase/label
    return sendToLLMWithLogging(model, systemPrompt, userPrompt, token, {
        enableTools,
        phase: 'other',
        label: 'Legacy sendToLLM call',
    });
}

// ============================================================================
// LARGE INPUT HANDLING — Chunked analysis for big pasted feature lists
// ============================================================================

/**
 * Split a large input into manageable chunks, breaking at paragraph/section boundaries.
 * Preserves section context by including overlap between chunks.
 */
function chunkLargeInput(text: string, chunkSize: number = CHUNK_SIZE): string[] {
    if (text.length <= chunkSize) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= chunkSize) {
            chunks.push(remaining);
            break;
        }

        // Find a good break point near the chunk size
        let breakPoint = chunkSize;

        // Try to break at a double newline (paragraph boundary)
        const paragraphBreak = remaining.lastIndexOf('\n\n', chunkSize);
        if (paragraphBreak > chunkSize * 0.5) {
            breakPoint = paragraphBreak + 2;
        } else {
            // Try to break at a single newline
            const lineBreak = remaining.lastIndexOf('\n', chunkSize);
            if (lineBreak > chunkSize * 0.5) {
                breakPoint = lineBreak + 1;
            }
            // Otherwise break at chunkSize
        }

        chunks.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint);
    }

    return chunks;
}

/**
 * Analyze a large input in chunks and merge the results.
 * Each chunk is analyzed independently, then results are merged.
 */
async function analyzeChunkedInput(
    model: vscode.LanguageModelChat,
    input: string,
    workspaceContext: string,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
): Promise<AnalysisResult | null> {
    const chunks = chunkLargeInput(input);

    response.markdown(
        `Input is large (${input.length.toLocaleString()} chars) — processing in ${chunks.length} chunks to preserve all information...\n\n`,
    );

    const chunkResults: AnalysisResult[] = [];

    for (let i = 0; i < chunks.length; i++) {
        if (token.isCancellationRequested) {
            return null;
        }

        response.markdown(`Processing chunk ${i + 1}/${chunks.length}...\n`);

        const chunkPrompt = `You are analyzing CHUNK ${i + 1} of ${chunks.length} of a large user request.

IMPORTANT: Extract ALL distinct features, requirements, details, and information from this chunk.
Do NOT summarize or abbreviate — your job is to ensure ZERO information loss.
Another pass will merge all chunks, so capture everything faithfully.

${chunks.length > 1 ? `This is part ${i + 1} of ${chunks.length}. The user's full request was split into chunks. Extract everything from THIS chunk.` : ''}`;

        const analysisPrompt = getAnalysisPrompt(workspaceContext);
        const fullPrompt = analysisPrompt + '\n\n' + chunkPrompt;

        try {
            const result = await sendToLLMWithLogging(model, fullPrompt, chunks[i], token, {
                enableTools: true, // Enable web search for chunk analysis
                phase: 'analysis',
                label: `Chunk ${i + 1}/${chunks.length} analysis`,
            });
            const parsed = parseJSON<AnalysisResult>(result);
            if (parsed) {
                chunkResults.push(parsed);
            }
        } catch (err) {
            response.markdown(
                `Warning: Chunk ${i + 1} analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}\n`,
            );
        }
    }

    if (chunkResults.length === 0) {
        return null;
    }

    // If only one chunk, return directly
    if (chunkResults.length === 1) {
        return chunkResults[0];
    }

    // Merge all chunk results
    response.markdown(`Merging ${chunkResults.length} chunk results...\n\n`);
    return mergeChunkResults(model, chunkResults, workspaceContext, token);
}

/**
 * Merge multiple analysis results from chunks into a single unified result.
 */
async function mergeChunkResults(
    model: vscode.LanguageModelChat,
    chunkResults: AnalysisResult[],
    workspaceContext: string,
    token: vscode.CancellationToken,
): Promise<AnalysisResult | null> {
    const mergePrompt = `You are merging multiple analysis results from chunks of a large user request into a single unified context packet.

CRITICAL RULES:
1. PRESERVE ALL DISTINCT INFORMATION from every chunk — do not drop, summarize, or abbreviate
2. DEDUPLICATE: If the same fact appears in multiple chunks, keep ONE instance
3. MERGE RELATED: Combine related information from different chunks into coherent sections
4. PRESERVE ALL: features, examples, requirements, constraints, technical details, relationships
5. Maintain all arrays (constraints, successCriteria, inputsArtifacts, etc.) with ALL items from ALL chunks
6. Combine additionalContext from all chunks
7. The merged result should be COMPLETE — reading it should give the full picture

${workspaceContext ? `WORKSPACE CONTEXT:\n${workspaceContext}\n\n---\n\n` : ''}Here are the analysis results from ${chunkResults.length} chunks:

${chunkResults.map((r, i) => `=== CHUNK ${i + 1} RESULT ===\n${JSON.stringify(r.contextPacket, null, 2)}`).join('\n\n')}

Merge these into a SINGLE JSON result with the same structure:
{
  "contextPacket": { ... merged context packet with ALL information from ALL chunks ... },
  "missingInfo": [ ... any remaining questions that couldn't be answered from any chunk ... ],
  "isComplete": true/false
}

Return ONLY valid JSON.`;

    try {
        const result = await sendToLLMWithLogging(model, mergePrompt, '', token, {
            phase: 'merge',
            label: `Merge ${chunkResults.length} chunk results`,
        });
        return parseJSON<AnalysisResult>(result);
    } catch {
        // Fallback: manually merge the chunk results
        return manualMergeChunks(chunkResults);
    }
}

/**
 * Fallback manual merge when LLM merge fails.
 */
function manualMergeChunks(chunkResults: AnalysisResult[]): AnalysisResult {
    const merged: ContextPacket = createEmptyContextPacket();
    const allMissing: PendingQuestion[] = [];

    for (const chunk of chunkResults) {
        const cp = chunk.contextPacket;
        if (cp.goal && !merged.goal) {
            merged.goal = cp.goal;
        } else if (cp.goal) {
            merged.goal += ' ' + cp.goal;
        }

        if (cp.currentState) {
            merged.currentState += (merged.currentState ? '\n' : '') + cp.currentState;
        }
        merged.constraints.push(...cp.constraints);
        merged.inputsArtifacts.push(...cp.inputsArtifacts);
        if (cp.outputFormat && !merged.outputFormat) {
            merged.outputFormat = cp.outputFormat;
        }
        merged.successCriteria.push(...cp.successCriteria);
        merged.nonGoals.push(...cp.nonGoals);
        if (cp.additionalContext) {
            merged.additionalContext +=
                (merged.additionalContext ? '\n\n' : '') + cp.additionalContext;
        }
        merged.suspectedTranscriptionIssues.push(...(cp.suspectedTranscriptionIssues || []));

        if (chunk.missingInfo) {
            allMissing.push(...chunk.missingInfo);
        }
    }

    // Deduplicate arrays
    merged.constraints = [...new Set(merged.constraints)];
    merged.inputsArtifacts = [...new Set(merged.inputsArtifacts)];
    merged.successCriteria = [...new Set(merged.successCriteria)];
    merged.nonGoals = [...new Set(merged.nonGoals)];
    merged.suspectedTranscriptionIssues = [...new Set(merged.suspectedTranscriptionIssues)];

    return {
        contextPacket: merged,
        missingInfo: allMissing,
        isComplete: allMissing.length === 0,
    };
}

// ============================================================================
// ANALYSIS PROMPTS
// ============================================================================
//
// DESIGN PHILOSOPHY (Updated February 2026):
// These prompts use a SYSTEMATIC, CHECKLIST-BASED approach to question generation
// rather than relying on implicit model reasoning. This ensures consistent behavior
// across different model families:
//
// - Orchestration-optimized models (e.g., GPT-5.3 Codex) follow explicit steps
// - Reasoning-heavy models (e.g., Opus 4.5/4.6) maintain quality with structure
// - All models benefit from concrete examples and filtering criteria
//
// Key improvements:
// 1. Explicit 5-step process for identifying ambiguities
// 2. Concrete checklist of ambiguity categories with examples
// 3. Clear filtering rules for what NOT to ask
// 4. Good vs. bad question examples showing specific, contextual phrasing
// 5. Mechanical criteria for determining isComplete
//
// See docs/RAMBLE-IMPROVEMENTS.md for full rationale and testing recommendations.

function getAnalysisPrompt(workspaceContext: string): string {
    return `You are a prompt analysis assistant. Your job is to PRESERVE ALL FACTS from a user's rambling request while organizing them into a structured format. You remove filler words, not information.

THIS IS A SYSTEMATIC, MECHANICAL PROCESS — NOT CREATIVE REASONING:
This task involves following explicit checklists and criteria. You do not need to "understand" deeply or reason creatively. Follow the steps methodically:
1. Extract all distinct facts into the context packet (mechanical organization)
2. Apply the ambiguity checklist to identify potential questions (pattern matching)
3. Filter questions using explicit criteria (rule application)
4. Format questions with specific, contextual language (template application)

IMPORTANT — TALK-TO-TEXT AWARENESS:
The user is very likely dictating via a talk-to-text system (e.g., Wispr Flow). This means:
- The input will read like natural speech: rambling, stream-of-consciousness, with filler words.
- Talk-to-text systems frequently introduce TRANSCRIPTION ERRORS:
  • Homophones and near-homophones (e.g., "Johan" vs "Johann", "your" vs "you're", "their" vs "there")
  • Mangled technical terms (e.g., "typescript" → "type script", "GitHub" → "get hub")
  • Proper names and brand names may be wrong (e.g., a library called "Prisma" transcribed as "prism")
  • Words that sound similar but mean different things in context
  • Repeated or phantom words inserted by the STT engine

When you detect a potential transcription discrepancy:
1. FIRST — Check the WORKSPACE CONTEXT below. If a word looks like a mangled version of a file name, folder, package, variable, or project name that exists in the workspace, silently resolve it to the correct term and note the correction in "suspectedTranscriptionIssues".
2. SECOND — Use your training knowledge. If a technical term, library name, or well-known concept is clearly misspelled/misheard, silently resolve it and note the correction.
3. LAST RESORT — If you CANNOT confidently resolve the discrepancy from the codebase or your knowledge, DO NOT GUESS. Instead, add it as a follow-up question in "missingInfo" with field "transcription" so the user can clarify.

Examples:
- User says "the yohan agent" but workspace has a folder called "johann" → resolve to "johann", note in suspectedTranscriptionIssues: "Resolved 'yohan' → 'johann' (matches workspace folder src/johann/)"
- User says "we're using prism for the database" and package.json has "prisma" → resolve to "Prisma", note the correction
- User says "the flack API" and you're unsure if they mean Flask or Flack → ask in missingInfo: "You mentioned 'flack API' — did you mean Flask (Python web framework) or something else?"

${
    workspaceContext
        ? `IMPORTANT - WORKSPACE CONTEXT:
The user is working in a specific workspace. Use this context to understand references like project names, paths, and terminology. This is your PRIMARY source for resolving potential transcription errors:

${workspaceContext}

---

`
        : ''
}Analyze the user's request and return a JSON object with this EXACT structure:
{
  "contextPacket": {
    "goal": "The main goal/objective. Preserve all specifics mentioned - if they said 'hooks inspired by WordPress action and filter hooks', include that exact framing.",
    "currentState": "COMPREHENSIVE description of current state. Include ALL mentioned: what exists, relationships between systems, what APIs are built, what's missing.",
    "constraints": ["Array of ALL constraints, requirements, architectural decisions, and rules mentioned - err on the side of including too much"],
    "inputsArtifacts": ["Array of ACTUAL files, repos, and artifacts that EXIST in the user's workspace and are relevant to the task. Use the WORKSPACE CONTEXT to identify real paths. DO NOT list files from external systems, reference material, or example architectures the user described — those belong in additionalContext instead."],
    "outputFormat": "What format they need the output in (code, docs, analysis, etc.) - or empty string if not mentioned",
    "successCriteria": ["Array of success criteria or what 'done' looks like - or empty array if not mentioned"],
    "nonGoals": ["Things explicitly mentioned as out of scope"],
    "additionalContext": "ALL other relevant context - examples given, analogies used (like WordPress), technical concepts explained (action hooks vs filter hooks), relationships between components, lifecycle concepts, etc. BE THOROUGH.",
    "suspectedTranscriptionIssues": ["Array of transcription issues detected and how they were resolved. Format: 'Resolved X → Y (reason)' for auto-resolved, or empty if none found. Unresolvable issues go in missingInfo instead."]
  },
  "missingInfo": [
    {
      "index": 1,
      "question": "A specific, contextual question about what's missing",
      "field": "Which field this would fill (goal, outputFormat, successCriteria, constraint, transcription, etc.)"
    }
  ],
  "isComplete": true/false
}

CRITICAL RULES - PRESERVE ALL DISTINCT INFORMATION:
1. PRESERVE ALL DISTINCT FACTS - If the user mentioned "action hooks and filter hooks inspired by WordPress", that concept must appear. If they mentioned "Pre-Backend, Mid-Backend, Post-Backend", those must appear.
2. PRESERVE RELATIONSHIPS - If user explains how System A relates to System B (e.g., "shell provides hooks API to boilerplate"), that relationship must be captured.
3. PRESERVE EXAMPLES - If user gave examples (HID devices, webcam, digital scale, convention panels), include ALL of them.
4. PRESERVE TECHNICAL CONCEPTS - If user explained a concept (action hooks = execute code at lifecycle point, filter hooks = pass value through for modification), preserve that explanation.
5. USE THE WORKSPACE CONTEXT - Resolve aliases/keys to full paths when referenced. Also use it to catch and correct talk-to-text errors on project-specific terms.
6. OK TO CONDENSE:
   - Deduplicate: If the same fact is mentioned twice, keep one instance
   - Organize: If fragments about the same topic are scattered, merge them together
   - Paraphrase: "sometimes, always, most of the time" → "frequently"
   - Remove filler: um, uh, you know, like, basically
   - Fix obvious STT artifacts: "type script" → "TypeScript", "get hub" → "GitHub" (note in suspectedTranscriptionIssues)
7. DO NOT REMOVE: distinct facts, examples, analogies, relationships, technical concepts, or anything that adds context - even if it could be stated more briefly.

WEB SEARCH - RESEARCH BEFORE ASKING:
You have access to web search via the vscode_search tool. BEFORE asking the user a question, check if you can answer it yourself via internet research.

WHEN TO SEARCH THE WEB:
✓ External APIs, services, or libraries (documentation, capabilities, endpoints, authentication methods)
✓ Technical specifications (browser support, system requirements, compatibility matrices)
✓ Current versions, release status, or recent changes (e.g., "is React 19 stable?")
✓ Public service capabilities (e.g., "does Stripe support recurring billing with variable amounts?")
✓ Framework features or best practices (e.g., "Next.js App Router data fetching patterns")
✓ Third-party integrations (e.g., "Twilio SMS API rate limits")

WHEN NOT TO SEARCH:
✗ Questions about the user's specific codebase, business logic, or internal systems (check workspace context instead)
✗ Subjective preferences ("should I use X or Y?" - ask the user)
✗ Project-specific constraints or requirements (ask the user)
✗ Information you can confidently answer from your training data (common programming concepts, well-known patterns)
✗ User's personal goals or priorities

FORMAT SEARCH QUERIES:
- Be specific and technical: "Stripe Checkout Session API payment methods"
- Not generic: "how does stripe work"
- Include version if mentioned: "Next.js 14 server actions error handling"
- Target official docs or technical references

EXAMPLE WORKFLOW:
User says: "I want to integrate the Twilio API for SMS notifications"
❌ DON'T immediately ask: "What Twilio features do you need?"
✓ DO: Search "Twilio SMS API capabilities" → learn it supports sending, receiving, status callbacks
✓ THEN ask specific questions based on findings: "Twilio supports sending SMS, receiving replies, and status webhooks. Do you need all three, or just one-way notifications?"

After searching, incorporate findings into your contextPacket and only ask about aspects you couldn't resolve.

CRITICAL RULES - GENERATING CLARIFYING QUESTIONS:
Follow this SYSTEMATIC PROCESS to identify what questions to ask:

STEP 1 - IDENTIFY AMBIGUITIES (check each category):
a) **Multiple interpretations**: Does any part of the request have 2+ valid interpretations?
   - Example: "update the dashboard" → which dashboard? (user dashboard, admin panel, analytics view)
   - Example: "add authentication" → OAuth, JWT, session-based, API keys, or combination?

b) **Vague scope boundaries**: Where exactly does the work start/stop?
   - Example: "integrate payment processing" → full checkout flow or just payment capture? refunds? webhooks?
   - Example: "improve performance" → optimize what specific bottleneck? [page load, API response, database queries]

c) **Underspecified behavior**: How should edge cases or alternatives be handled?
   - Example: "validate user input" → what happens on validation failure? [show errors inline, redirect, modal]
   - Example: "sync data between systems" → real-time or batch? conflict resolution strategy?

d) **Missing critical context for decision-making**: What information would materially change the implementation approach?
   - Example: "add search functionality" → full-text search across 1K records or faceted search across millions?
   - Example: User mentions "integrate with the API" without specifying WHICH API (internal vs external, REST vs GraphQL)

e) **Contradictory statements**: Did user say things that conflict?
   - Example: "keep it simple" but then describes 8 complex integration points
   - Example: "don't change the data model" but requests features that require new relationships

f) **Unclear pronouns or references**: "Add it to that system" - what is "it" and "that system"?
   - Only ask if you truly can't resolve from context

STEP 2 - FILTER OUT NON-QUESTIONS:
DO NOT ask about:
- Things clearly implied by context ("implement feature X" → obviously need code + tests)
- Standard practices (file extensions, common patterns)
- Details typically decided during implementation (exact variable names, folder structure for new features)
- Information that will be automatically resolved (framework compatibility checks, codebase searches)
- Clarifications where any reasonable choice would work fine

STEP 3 - CRAFT SPECIFIC, CONTEXTUAL QUESTIONS:
For each ambiguity that passed Step 2:
✓ GOOD: Grounded in their specific request
  "You mentioned updating the user profile page - should this include avatar upload or just text fields?"
  "The notification system you described - should it support email, in-app, or both?"

✗ BAD: Generic or detached from their context
  "What features do you want?"
  "What programming language?"
  "How should this work?"

STEP 4 - EXAMPLES OF GOOD VS BAD QUESTIONS:

EXAMPLE 1 - User says: "Add a settings page"
❌ BAD: "What should the settings page include?" (too generic)
✓ GOOD: "You mentioned a settings page - should it manage user preferences, system configuration, or both? Are there specific settings you need (e.g., notifications, privacy, integrations)?"

EXAMPLE 2 - User says: "Make the app work offline"
❌ BAD: "How should offline mode work?" (too broad)
✓ GOOD: "For offline functionality - should users be able to create/edit data offline (requires conflict resolution) or just view previously loaded data?"

EXAMPLE 3 - User says: "Refactor the authentication code"
❌ BAD: "Why do you want to refactor it?" (questioning their intent)
✓ GOOD: "You mentioned refactoring authentication - are you aiming to add new auth methods (OAuth, SSO), improve security, or simplify the code structure?"

EXAMPLE 4 - User mentions "the API" without clarification
❌ BAD: "What API?" (too terse)
✓ GOOD: "You referenced 'the API' - did you mean the internal backend API at /api/v1, or are you integrating with an external third-party API?"

EXAMPLE 5 - User says: "Build a recommendation system"
❌ BAD: "What algorithm should we use?" (implementation detail)
✓ GOOD: "For recommendations - are you thinking simple collaborative filtering based on user behavior, or do you need real-time personalization with ML models? This affects whether we need external services or can handle it in-app."

STEP 5 - DETERMINE isComplete:
Set "isComplete": false if ANY of these are true:
- The goal itself is ambiguous (could be interpreted 2+ fundamentally different ways)
- Multiple valid implementation approaches exist and user's preference would significantly change the work
- You identified critical missing context using the checklist in Step 1
- There are unresolved transcription errors that affect meaning

Set "isComplete": true if:
- You have a clear, singular understanding of what they want
- Any remaining uncertainties are normal implementation details
- You could write a comprehensive prompt that would lead to good results

CRITICAL RULES - CONSERVATIVE APPROACH:
8. BE CONSERVATIVE about marking complete with weak context. After you extract the context packet, the system will automatically:
   - Search the codebase for answers (files, source code, configs)
   - Attempt to resolve using certain, unambiguous factual knowledge
   - ONLY ask the user as a last resort
9. However, DO ask about genuine ambiguities that change the implementation approach — don't assume you know what they meant.
10. Questions must be SPECIFIC to their request, not generic. BAD: "What language?" GOOD: "You mentioned the authentication system - does it use JWT or session-based tokens?"
11. DO NOT ask about:
   - File extensions or programming languages if detectable from context
   - Framework compatibility (this will be checked via knowledge resolution)
   - Standard configurations or defaults
   - Implementation details that are typically decided during coding
   - Version numbers unless critical to the task
12. If the output format is implied (e.g., "implement hooks" implies code + documentation), fill it in - don't ask.
13. DO NOT GUESS on ambiguous transcription issues — those SHOULD go in missingInfo with field "transcription".
14. Return ONLY valid JSON, no markdown, no explanations.

REMEMBER: Your job is to identify GENUINE ambiguities that would lead to different implementation approaches. Use the systematic checklist above - don't rely on intuition alone. The user wants thorough context engineering, not minimal interruptions at the cost of clarity.`;
}

function getCompilePrompt(workspaceContext: string): string {
    return `You are a prompt engineering expert. Your job is to take a context packet and compile it into an ideal, structured prompt for an AI coding assistant.

CRITICAL: PRESERVE ALL DISTINCT INFORMATION from the context packet. Your job is to format, organize, and present clearly. Every distinct fact, example, relationship, and technical concept must appear in the compiled prompt. You may paraphrase for clarity, but do not omit information.

TALK-TO-TEXT NOTE: The context packet was extracted from talk-to-text input. Any transcription corrections are noted in "suspectedTranscriptionIssues". Use the CORRECTED terms throughout the compiled prompt (not the original misheard versions). Do not mention the transcription issues in the compiled prompt itself — they have already been resolved.

${
    workspaceContext
        ? `WORKSPACE CONTEXT (include relevant parts in the compiled prompt):
${workspaceContext}

---

`
        : ''
}The compiled prompt should:
1. Start with a clear role definition
2. Include relevant workspace context (paths, project structure, conventions)
3. State the goal precisely - preserve all specifics from the context packet
4. Provide COMPREHENSIVE context about current state - include ALL relationships, systems, and architecture details
5. List ALL constraints and requirements - do not summarize these
6. Preserve ALL examples given (devices, use cases, analogies like WordPress)
7. Include ALL technical concepts explained (e.g., action hooks vs filter hooks definitions)
8. Specify the expected output format
9. Include success criteria
10. Be structured for maximum clarity and actionability

DO NOT:
- Omit distinct facts to make it shorter
- Summarize multiple examples into a generic category (keep each example)
- Remove technical explanations, analogies, or concept definitions
- Lose the relationships between systems/components
- Include raw transcription errors — always use the corrected terms

Return ONLY the compiled prompt text, no explanations or meta-commentary. The prompt should be ready to copy-paste to another AI assistant.`;
}

function getMergePrompt(workspaceContext: string): string {
    return `You are merging user answers into an existing context packet. Integrate new information from answers while deduplicating any redundancy.

IMPORTANT — THIS IS AN ITERATIVE PROCESS:
You are in a MULTI-ROUND conversation. If the user's answers reveal NEW ambiguities, incomplete information, or additional questions, you SHOULD ask follow-up questions. Do not prematurely mark as complete just because you received answers. The goal is thorough context engineering, and that may require multiple rounds of clarification.

TALK-TO-TEXT AWARENESS: The user's answers are likely dictated via talk-to-text and may contain transcription errors. Apply the same rules as the initial analysis:
- Cross-reference any unfamiliar terms against the WORKSPACE CONTEXT to catch mangled project names, file paths, or technical terms.
- Use your training knowledge to resolve well-known misspellings of libraries, frameworks, or concepts.
- If you resolve a transcription issue, add it to the "suspectedTranscriptionIssues" array.
- If you CANNOT confidently resolve a term, add a follow-up question to "missingInfo" with field "transcription".
- NEVER guess — ask when uncertain.

${
    workspaceContext
        ? `WORKSPACE CONTEXT:
${workspaceContext}

---

`
        : ''
}Previous context packet:
{CONTEXT_PACKET}

Questions that were asked:
{QUESTIONS}

User's answers:
{ANSWERS}

CRITICAL RULES FOR MERGING:
1. PRESERVE ALL DISTINCT FACTS from the previous context packet
2. ADD new information from answers to the appropriate fields
3. DEDUPLICATE: If new info repeats something already captured, don't duplicate it
4. ORGANIZE: Merge related fragments together for clarity
5. If an answer provides examples, add ALL distinct examples
6. If an answer explains a concept, preserve that explanation
7. Use the workspace context to resolve any project names or paths mentioned
8. Carry forward all existing "suspectedTranscriptionIssues" and add any new ones found in the answers

CRITICAL - DETERMINING IF MORE QUESTIONS ARE NEEDED:
After merging the answers, re-evaluate using the SAME SYSTEMATIC PROCESS from the initial analysis:

STEP 1 - RE-CHECK FOR REMAINING AMBIGUITIES:
a) **Multiple interpretations**: Are there still parts with 2+ valid interpretations?
b) **Vague scope boundaries**: Is it now clear where the work starts/stops?
c) **Underspecified behavior**: Are edge cases and alternatives now clear?
d) **Missing critical context**: Is there information that would materially change the implementation?
e) **New ambiguities**: Did the answers introduce new unclear references or contradictions?

STEP 2 - GENERATE FOLLOW-UP QUESTIONS IF NEEDED:
Be LIBERAL about asking follow-ups when answers create new questions:
- If the user's answer revealed NEW ambiguities or complexity
- If the answer was vague or opened more questions than it answered
- If there's still a meaningful choice between implementation approaches
- If the answer introduced new concepts that need clarification
- If the answer said "both" or "all" but didn't specify how they interact

Examples showing when to ask follow-ups:
  - User answered "both email and in-app" for notifications → NOW ask: "Should email notifications be real-time or batched (daily digest)? Should users be able to configure notification preferences?"
  - User answered "integrate with external API" → NOW ask: "Which specific API are you integrating with? Do you have authentication credentials? What data are you sync'ing?"
  - User answered "make it faster" → NOW ask: "You mentioned performance - are you concerned about page load time, API response time, or database query performance?"
  - User answered "yes, add authentication" → NOW ask: "What type of authentication - OAuth with specific providers (Google, GitHub), JWT tokens, or session-based?"

STEP 3 - DON'T OVER-ASK (but err on the side of asking):
- If you now have enough context to write a clear, actionable prompt with no ambiguity, mark as complete
- Don't ask about details that became obvious from the answers
- Don't ask implementation details that are decided during coding
- But DO ask if there's still meaningful architectural or scope ambiguity
- When in doubt, ask one more targeted question rather than risk building the wrong thing

STEP 4 - SET isComplete:
REMINDER: You can ask up to 3 rounds of questions total. If this answer created new ambiguities or was incomplete, mark as false to ask another round. Don't rush to complete - iterate until you have clarity.

Set "isComplete": false if:
- Significant ambiguities remain even after these answers
- New critical questions emerged from the answers
- The user's answers were too vague and you still have 2+ valid interpretations

Set "isComplete": true if:
- You now have a clear, actionable understanding
- Any remaining uncertainties are normal implementation details
- You can now write a comprehensive prompt that would lead to good results

Return this exact JSON structure:
{
  "contextPacket": { ... context packet with all previous content PLUS new information from answers, including suspectedTranscriptionIssues array ... },
  "missingInfo": [ ... any remaining questions using the systematic analysis above, or empty array if complete ... ],
  "isComplete": true/false
}

Return ONLY valid JSON.`;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function createEmptyContextPacket(): ContextPacket {
    return {
        goal: '',
        currentState: '',
        constraints: [],
        inputsArtifacts: [],
        outputFormat: '',
        successCriteria: [],
        nonGoals: [],
        additionalContext: '',
        suspectedTranscriptionIssues: [],
    };
}

function createEmptySession(): Session {
    return {
        state: 'IDLE',
        rawRamble: '',
        contextPacket: createEmptyContextPacket(),
        pendingQuestions: [],
        questionRound: 0,
        workspaceContext: '',
    };
}

function parseJSON<T>(text: string): T | null {
    let jsonStr = text.trim();

    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    }

    try {
        return JSON.parse(jsonStr) as T;
    } catch {
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (objMatch) {
            try {
                return JSON.parse(objMatch[0]) as T;
            } catch {
                return null;
            }
        }
        return null;
    }
}

function looksLikeNewRequest(text: string, session?: Session): boolean {
    const trimmed = text.trim();
    const lines = trimmed.split('\n').filter((l) => l.trim());
    if (lines.length === 0) {
        return false;
    }

    const firstLine = lines[0].trim();

    // If we're waiting for answers, be VERY conservative about treating input as a new request.
    // Only reset if the user explicitly says "start over", "new request", "forget that", etc.
    if (session?.state === 'WAITING_FOR_ANSWERS') {
        const explicitResetPatterns = [
            /^(start over|reset|new request|forget (that|this)|scratch that|never\s?mind|cancel)/i,
            /^(actually,?\s+(i want|i need|let'?s|forget))/i,
        ];
        for (const pattern of explicitResetPatterns) {
            if (pattern.test(firstLine)) {
                return true;
            }
        }
        // Everything else while WAITING_FOR_ANSWERS is treated as answers, even long text.
        return false;
    }

    // For IDLE/DONE sessions, use normal detection
    const answerPattern = /^(A\d+[:.]\s*|^\d+[).:]?\s*)/i;
    if (answerPattern.test(firstLine)) {
        return false;
    }

    const newRequestIndicators = [
        /^(i want|i need|please|help me|create|build|implement|fix|refactor|add|remove|change|update|use your|analyze|design|we need|we have|we are)/i,
        /^(can you|could you|would you|how do i|how can i|what is|let's|lets)/i,
    ];

    for (const pattern of newRequestIndicators) {
        if (pattern.test(firstLine)) {
            return true;
        }
    }

    // Long messages from IDLE/DONE are likely new requests
    if (trimmed.length > 300) {
        return true;
    }

    if (lines.length > 5) {
        return true;
    }

    return false;
}

function formatContextPacketMarkdown(packet: ContextPacket): string {
    const lines: string[] = [];

    lines.push('## Extracted Context Packet\n');
    lines.push(`**Goal:** ${packet.goal}\n`);

    if (packet.currentState) {
        lines.push(`**Current State:** ${packet.currentState}\n`);
    }

    if (packet.constraints.length > 0) {
        lines.push('**Constraints:**');
        for (const c of packet.constraints) {
            lines.push(`- ${c}`);
        }
        lines.push('');
    }

    if (packet.inputsArtifacts.length > 0) {
        lines.push('**Inputs/Artifacts:**');
        for (const i of packet.inputsArtifacts) {
            lines.push(`- ${i}`);
        }
        lines.push('');
    }

    if (packet.outputFormat) {
        lines.push(`**Output Format:** ${packet.outputFormat}\n`);
    }

    if (packet.successCriteria.length > 0) {
        lines.push('**Success Criteria:**');
        for (const sc of packet.successCriteria) {
            lines.push(`- ${sc}`);
        }
        lines.push('');
    }

    if (packet.nonGoals.length > 0) {
        lines.push('**Non-Goals:**');
        for (const ng of packet.nonGoals) {
            lines.push(`- ${ng}`);
        }
        lines.push('');
    }

    if (packet.additionalContext) {
        lines.push(`**Additional Context:** ${packet.additionalContext}\n`);
    }

    if (packet.suspectedTranscriptionIssues && packet.suspectedTranscriptionIssues.length > 0) {
        lines.push('**Talk-to-Text Corrections:**');
        for (const issue of packet.suspectedTranscriptionIssues) {
            lines.push(`- ${issue}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

// ============================================================================
// CHAT PARTICIPANT HANDLER
// ============================================================================

// ============================================================================
// STARTUP CLEANUP — Kill orphaned ACP workers from previous sessions
// ============================================================================

/**
 * On activation, check for orphaned `copilot --acp --stdio` processes
 * that survived a previous VS Code crash or force-quit.
 * Kills them silently unless there are many, in which case it notifies.
 */
function cleanupOrphanedWorkers(): void {
    try {
        const { execSync } = require('child_process') as typeof import('child_process');
        const platform = process.platform;

        let pids: number[] = [];

        if (platform === 'win32') {
            // Windows: wmic or tasklist
            try {
                const out = execSync(
                    'wmic process where "commandline like \'%copilot%--acp%--stdio%\'" get processid /format:list',
                    { encoding: 'utf-8', timeout: 5000 },
                );
                pids = out
                    .split('\n')
                    .filter((l) => l.startsWith('ProcessId='))
                    .map((l) => parseInt(l.split('=')[1], 10))
                    .filter((n) => !isNaN(n));
            } catch {
                // wmic not available on newer Windows — try powershell
                try {
                    const out = execSync(
                        'powershell -Command "Get-Process | Where-Object {$_.CommandLine -like \'*copilot*--acp*--stdio*\'} | Select-Object -ExpandProperty Id"',
                        { encoding: 'utf-8', timeout: 5000 },
                    );
                    pids = out
                        .split('\n')
                        .map((l) => parseInt(l.trim(), 10))
                        .filter((n) => !isNaN(n));
                } catch {
                    // Give up on Windows detection
                }
            }
        } else {
            // macOS / Linux: pgrep
            try {
                const out = execSync('pgrep -f "copilot.*--acp.*--stdio"', {
                    encoding: 'utf-8',
                    timeout: 5000,
                });
                pids = out
                    .split('\n')
                    .map((l) => parseInt(l.trim(), 10))
                    .filter((n) => !isNaN(n));
            } catch {
                // pgrep returns exit 1 when no matches — that's fine
            }
        }

        if (pids.length === 0) {
            return;
        }

        // Kill them
        let killed = 0;
        for (const pid of pids) {
            try {
                process.kill(pid, 'SIGTERM');
                killed++;
            } catch {
                // Process already gone or permission denied
            }
        }

        if (killed > 0) {
            console.warn(
                `[Fugue] Cleaned up ${killed} orphaned ACP worker(s) from a previous session.`,
            );

            // Force-kill any that didn't respond to SIGTERM after 3s
            setTimeout(() => {
                for (const pid of pids) {
                    try {
                        // Check if still alive
                        process.kill(pid, 0);
                        // Still alive — SIGKILL
                        process.kill(pid, 'SIGKILL');
                    } catch {
                        // Already dead — good
                    }
                }
            }, 3000);

            // Notify if there were many — might indicate a problem
            if (killed >= 3) {
                vscode.window.showWarningMessage(
                    `Johann cleaned up ${killed} orphaned worker processes from a previous session.`,
                );
            }
        }
    } catch {
        // Entire cleanup failed — non-critical, don't block activation
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.warn('Fugue for GitHub Copilot activated');

    // Initialize Ramble logger
    const rambleLogger = createRambleLogger(undefined, 'debug');
    context.subscriptions.push(rambleLogger);
    rambleLogger.info('Ramble logging initialized');

    // Register Copilot CLI setup command and check availability
    registerSetupCommand(context);
    // Non-blocking — shows a warning if CLI is missing, doesn't block activation
    showCliMissingNotification();

    // Kill any orphaned ACP workers from a previous session (crash, force-quit, etc.)
    cleanupOrphanedWorkers();

    // Register the copy command
    const copyCommand = vscode.commands.registerCommand('ramble.copyLast', async () => {
        const lastPrompt = context.workspaceState.get<string>(LAST_PROMPT_KEY);
        if (lastPrompt) {
            await vscode.env.clipboard.writeText(lastPrompt);
            vscode.window.showInformationMessage('Compiled prompt copied to clipboard!');
        } else {
            vscode.window.showWarningMessage('No compiled prompt available yet.');
        }
    });

    context.subscriptions.push(copyCommand);

    // Register send to Johann command
    const sendToJohannCommand = vscode.commands.registerCommand('ramble.sendToJohann', async () => {
        const lastPrompt = context.workspaceState.get<string>(LAST_PROMPT_KEY);
        if (lastPrompt) {
            await vscode.commands.executeCommand('workbench.action.chat.open', {
                query: `@johann ${lastPrompt}`,
            });
        } else {
            vscode.window.showWarningMessage('No compiled prompt available yet.');
        }
    });

    context.subscriptions.push(sendToJohannCommand);

    // Register send to Copilot command
    const sendToCopilotCommand = vscode.commands.registerCommand(
        'ramble.sendToCopilot',
        async () => {
            const lastPrompt = context.workspaceState.get<string>(LAST_PROMPT_KEY);
            if (lastPrompt) {
                await vscode.commands.executeCommand('workbench.action.chat.open', {
                    query: lastPrompt,
                });
            } else {
                vscode.window.showWarningMessage('No compiled prompt available yet.');
            }
        },
    );

    context.subscriptions.push(sendToCopilotCommand);

    // Register refresh context command
    const refreshCommand = vscode.commands.registerCommand('ramble.refreshContext', async () => {
        const workspaceCtx = await gatherWorkspaceContext();
        const formatted = formatWorkspaceContext(workspaceCtx);
        await context.workspaceState.update(WORKSPACE_CONTEXT_KEY, formatted);
        vscode.window.showInformationMessage('Workspace context refreshed!');
    });

    context.subscriptions.push(refreshCommand);

    // Register the chat participant
    const participant = vscode.chat.createChatParticipant(
        'ramble',
        async (
            request: vscode.ChatRequest,
            chatContext: vscode.ChatContext,
            response: vscode.ChatResponseStream,
            token: vscode.CancellationToken,
        ) => {
            const logger = getRambleLogger();

            // Try to create debug log - but don't fail if it doesn't work
            let debugLog: RambleDebugConversationLog | undefined;
            try {
                debugLog = new RambleDebugConversationLog(true);
                await debugLog.initialize();
            } catch (err) {
                logger.warn('Failed to initialize debug log', {
                    error: err instanceof Error ? err.message : String(err),
                });
                debugLog = undefined;
            }

            const userMessage = request.prompt.trim();

            logger.info('Ramble chat request received', {
                messageLength: userMessage.length,
                sessionId: debugLog?.getSessionId() || 'no-session',
            });

            // Explicit reset command
            if (
                userMessage.toLowerCase() === 'reset' ||
                userMessage.toLowerCase() === 'start over'
            ) {
                logger.info('Session reset requested');
                await debugLog?.logEvent('other', 'User requested session reset');
                await context.workspaceState.update(STATE_KEY, createEmptySession());
                response.markdown(
                    "Session reset. Send me your request and I'll compile it into a structured prompt.\n",
                );
                await debugLog?.finalize('reset');
                return;
            }

            // Refresh context command
            if (
                userMessage.toLowerCase() === 'refresh' ||
                userMessage.toLowerCase() === 'refresh context'
            ) {
                logger.info('Workspace context refresh requested');
                await debugLog?.logEvent('other', 'User requested workspace context refresh');
                response.markdown('Refreshing workspace context...\n');
                const workspaceCtx = await gatherWorkspaceContext();
                const formatted = formatWorkspaceContext(workspaceCtx);
                await context.workspaceState.update(WORKSPACE_CONTEXT_KEY, formatted);
                response.markdown('✅ Workspace context refreshed! Found:\n');
                response.markdown(
                    `- Copilot instructions: ${workspaceCtx.copilotInstructions ? 'Yes' : 'No'}\n`,
                );
                response.markdown(`- READMEs: ${workspaceCtx.readmes.length}\n`);
                response.markdown(
                    `- Workspace folders: ${vscode.workspace.workspaceFolders?.length || 0}\n`,
                );
                await debugLog?.finalize('completed');
                return;
            }

            // Get LLM - use the model selected by user in chat, or fallback
            const model = request.model || (await getLLM());
            if (!model) {
                logger.error('No language model available');
                await debugLog?.logEvent('other', 'Failed: No language model available');
                response.markdown(
                    '**Error:** No language model available. Please ensure Copilot is active.\n',
                );
                await debugLog?.finalize('failed', 'No language model available');
                return;
            }

            // Check model capabilities
            const capabilities = checkModelCapabilities(model);
            logger.debug('Using language model', {
                modelId: model.id,
                supportsTools: capabilities.supportsTools,
            });
            await debugLog?.logEvent(
                'other',
                `Using model: ${model.id} (tools: ${capabilities.supportsTools ? 'yes' : 'no'})`,
            );

            // Get or gather workspace context
            let workspaceContext = context.workspaceState.get<string>(WORKSPACE_CONTEXT_KEY);
            if (!workspaceContext) {
                response.markdown('Gathering workspace context (first run)...\n\n');
                const workspaceCtx = await gatherWorkspaceContext();
                workspaceContext = formatWorkspaceContext(workspaceCtx);
                await context.workspaceState.update(WORKSPACE_CONTEXT_KEY, workspaceContext);
            }

            // Load or create session
            let session = context.workspaceState.get<Session>(STATE_KEY) || createEmptySession();
            session.workspaceContext = workspaceContext;

            // Check if new request while waiting for answers
            if (
                session.state === 'WAITING_FOR_ANSWERS' &&
                looksLikeNewRequest(userMessage, session)
            ) {
                session = createEmptySession();
                session.workspaceContext = workspaceContext;
            }

            // WAITING_FOR_ANSWERS: Process user answers
            if (session.state === 'WAITING_FOR_ANSWERS') {
                response.markdown('Processing your answers...\n\n');

                const mergePromptTemplate = getMergePrompt(workspaceContext);
                const mergePrompt = mergePromptTemplate
                    .replace('{CONTEXT_PACKET}', JSON.stringify(session.contextPacket, null, 2))
                    .replace(
                        '{QUESTIONS}',
                        session.pendingQuestions
                            .map((q) => `Q${q.index}: ${q.question}`)
                            .join('\n'),
                    )
                    .replace('{ANSWERS}', userMessage);

                try {
                    const mergeResult = await sendToLLMWithLogging(model, mergePrompt, '', token, {
                        enableTools: true, // Enable tools for follow-up research
                        debugLog,
                        phase: 'merge',
                        label: 'Merge user answers into context packet',
                        questionRound: session.questionRound,
                    });
                    const parsed = parseJSON<AnalysisResult>(mergeResult);

                    if (!parsed) {
                        response.markdown(
                            '**Error:** Failed to process your answers. Please try again or type `reset` to start over.\n',
                        );
                        return;
                    }

                    session.contextPacket = parsed.contextPacket;

                    // Validate and filter missingInfo — drop any entries with undefined fields
                    const validMissingInfo = (parsed.missingInfo || [])
                        .filter(
                            (q): q is PendingQuestion =>
                                q !== null &&
                                q !== undefined &&
                                typeof q.question === 'string' &&
                                q.question.length > 0 &&
                                typeof q.field === 'string' &&
                                q.field.length > 0,
                        )
                        .map((q, idx) => ({
                            ...q,
                            index: typeof q.index === 'number' ? q.index : idx + 1,
                        }));

                    // 3-TIER RESOLUTION: Try to resolve missing info before asking user
                    if (
                        !parsed.isComplete &&
                        validMissingInfo.length > 0 &&
                        session.questionRound < MAX_QUESTION_ROUNDS
                    ) {
                        // Tier 1: Codebase analysis
                        const codebaseAttempts = await analyzeCodebaseForMissingInfo(
                            validMissingInfo,
                            session.contextPacket,
                            workspaceContext,
                            model,
                            token,
                            response,
                        );

                        // Merge resolved answers into context packet
                        const codebaseResolved = codebaseAttempts.filter((a) => a.resolved);
                        if (codebaseResolved.length > 0) {
                            response.markdown(
                                `✓ Resolved ${codebaseResolved.length} question(s) from codebase\n\n`,
                            );
                            // Update context packet with resolved answers
                            session.contextPacket = await mergeResolvedAnswers(
                                session.contextPacket,
                                codebaseResolved,
                                model,
                                token,
                            );
                        }

                        // Tier 2: Knowledge resolution (for unresolved questions only)
                        const unresolvedAfterCodebase = codebaseAttempts
                            .filter((a) => !a.resolved)
                            .map((a) => a.question);

                        let stillUnresolved = unresolvedAfterCodebase;
                        if (unresolvedAfterCodebase.length > 0) {
                            const knowledgeAttempts = await attemptKnowledgeResolution(
                                unresolvedAfterCodebase,
                                session.contextPacket,
                                model,
                                token,
                                response,
                            );

                            const knowledgeResolved = knowledgeAttempts.filter((a) => a.resolved);
                            if (knowledgeResolved.length > 0) {
                                response.markdown(
                                    `✓ Resolved ${knowledgeResolved.length} question(s) from training knowledge\n\n`,
                                );
                                session.contextPacket = await mergeResolvedAnswers(
                                    session.contextPacket,
                                    knowledgeResolved,
                                    model,
                                    token,
                                );
                            }

                            stillUnresolved = knowledgeAttempts
                                .filter((a) => !a.resolved)
                                .map((a) => a.question);
                        }

                        // Tier 3: Ask user (only for still unresolved)
                        if (stillUnresolved.length > 0) {
                            session.pendingQuestions = stillUnresolved.map((q, idx) => ({
                                ...q,
                                index: idx + 1,
                            }));
                            session.questionRound++;
                            session.state = 'WAITING_FOR_ANSWERS';
                            await context.workspaceState.update(STATE_KEY, session);

                            response.markdown('I still need a few clarifications:\n\n');
                            for (const q of session.pendingQuestions) {
                                response.markdown(`**Q${q.index}:** ${q.question}\n\n`);
                            }
                            return;
                        }

                        // All questions resolved! Continue to compilation
                    }

                    // Complete - compile the prompt
                    response.markdown('All information gathered. Compiling your prompt...\n\n');

                    const compileSystemPrompt = getCompilePrompt(workspaceContext);
                    const compileUserPrompt = `Context Packet:\n${JSON.stringify(session.contextPacket, null, 2)}\n\nOriginal Request:\n${session.rawRamble}`;
                    const compiledPrompt = await sendToLLMWithLogging(
                        model,
                        compileSystemPrompt,
                        compileUserPrompt,
                        token,
                        {
                            debugLog,
                            phase: 'compilation',
                            label: 'Final prompt compilation (IDLE state)',
                            questionRound: session.questionRound,
                        },
                    );

                    await context.workspaceState.update(LAST_PROMPT_KEY, compiledPrompt);
                    session.state = 'DONE';
                    await context.workspaceState.update(STATE_KEY, session);

                    response.markdown(formatContextPacketMarkdown(session.contextPacket));
                    response.markdown(
                        '\n---\n\n## Compiled Prompt\n\n```text\n' + compiledPrompt + '\n```\n\n',
                    );
                    response.button({
                        command: 'ramble.copyLast',
                        title: '📋 Copy prompt',
                    });
                    response.button({
                        command: 'ramble.sendToJohann',
                        title: '🤖 Send to @johann',
                    });
                    response.button({
                        command: 'ramble.sendToCopilot',
                        title: '💬 Send to Copilot',
                    });
                    return { metadata: { compiled: true, prompt: compiledPrompt } };
                } catch (err) {
                    response.markdown(
                        `**Error:** ${err instanceof Error ? err.message : 'Unknown error'}\n`,
                    );
                    return;
                }
            }

            // NEW REQUEST: Analyze the user request
            session = createEmptySession();
            session.rawRamble = userMessage;
            session.workspaceContext = workspaceContext;
            session.state = 'IDLE';

            // Check input size and warn if extremely large
            if (userMessage.length > MAX_INPUT_SIZE) {
                response.markdown(
                    `⚠️ Input is very large (${userMessage.length.toLocaleString()} chars). Truncating to ${MAX_INPUT_SIZE.toLocaleString()} chars to stay within processing limits.\n\n`,
                );
                session.rawRamble = userMessage.substring(0, MAX_INPUT_SIZE);
            }

            response.markdown('Analyzing your request...\n\n');

            try {
                let parsed: AnalysisResult | null;

                // Use chunked analysis for large inputs
                if (session.rawRamble.length > LARGE_INPUT_THRESHOLD) {
                    parsed = await analyzeChunkedInput(
                        model,
                        session.rawRamble,
                        workspaceContext,
                        response,
                        token,
                    );
                } else {
                    const analysisPrompt = getAnalysisPrompt(workspaceContext);
                    const analysisResult = await sendToLLMWithLogging(
                        model,
                        analysisPrompt,
                        session.rawRamble,
                        token,
                        {
                            enableTools: true, // Enable web search for analysis
                            debugLog,
                            phase: 'analysis',
                            label: 'Initial request analysis',
                        },
                    );

                    parsed = parseJSON<AnalysisResult>(analysisResult);

                    if (!parsed) {
                        response.markdown(
                            '**Error:** Failed to analyze your request. Please try again.\n',
                        );
                        response.markdown(
                            '\n*Debug info:*\n```\n' + analysisResult.substring(0, 500) + '\n```\n',
                        );
                        return;
                    }
                }

                if (!parsed) {
                    response.markdown(
                        '**Error:** Failed to analyze your request. Please try again.\n',
                    );
                    return;
                }

                session.contextPacket = parsed.contextPacket;

                // Show what was extracted
                response.markdown(formatContextPacketMarkdown(parsed.contextPacket));

                // Validate missingInfo — drop entries with undefined/empty fields
                const validMissing = (parsed.missingInfo || [])
                    .filter(
                        (q): q is PendingQuestion =>
                            q !== null &&
                            q !== undefined &&
                            typeof q.question === 'string' &&
                            q.question.length > 0 &&
                            typeof q.field === 'string' &&
                            q.field.length > 0,
                    )
                    .map((q, idx) => ({
                        ...q,
                        index: typeof q.index === 'number' ? q.index : idx + 1,
                    }));

                // 3-TIER RESOLUTION: Try to resolve missing info before asking user
                if (!parsed.isComplete && validMissing.length > 0) {
                    response.markdown('\n---\n\n');

                    // Tier 1: Codebase analysis
                    const codebaseAttempts = await analyzeCodebaseForMissingInfo(
                        validMissing,
                        session.contextPacket,
                        workspaceContext,
                        model,
                        token,
                        response,
                    );

                    // Merge resolved answers into context packet
                    const codebaseResolved = codebaseAttempts.filter((a) => a.resolved);
                    if (codebaseResolved.length > 0) {
                        response.markdown(
                            `✓ Resolved ${codebaseResolved.length} question(s) from codebase\n\n`,
                        );
                        session.contextPacket = await mergeResolvedAnswers(
                            session.contextPacket,
                            codebaseResolved,
                            model,
                            token,
                        );
                    }

                    // Tier 2: Knowledge resolution (for unresolved questions only)
                    const unresolvedAfterCodebase = codebaseAttempts
                        .filter((a) => !a.resolved)
                        .map((a) => a.question);

                    let stillUnresolved = unresolvedAfterCodebase;
                    if (unresolvedAfterCodebase.length > 0) {
                        const knowledgeAttempts = await attemptKnowledgeResolution(
                            unresolvedAfterCodebase,
                            session.contextPacket,
                            model,
                            token,
                            response,
                        );

                        const knowledgeResolved = knowledgeAttempts.filter((a) => a.resolved);
                        if (knowledgeResolved.length > 0) {
                            response.markdown(
                                `✓ Resolved ${knowledgeResolved.length} question(s) from training knowledge\n\n`,
                            );
                            session.contextPacket = await mergeResolvedAnswers(
                                session.contextPacket,
                                knowledgeResolved,
                                model,
                                token,
                            );
                        }

                        stillUnresolved = knowledgeAttempts
                            .filter((a) => !a.resolved)
                            .map((a) => a.question);
                    }

                    // Tier 3: Ask user (only for still unresolved)
                    if (stillUnresolved.length > 0) {
                        session.pendingQuestions = stillUnresolved.map((q, idx) => ({
                            ...q,
                            index: idx + 1,
                        }));
                        session.questionRound = 1;
                        session.state = 'WAITING_FOR_ANSWERS';
                        await context.workspaceState.update(STATE_KEY, session);

                        response.markdown('**I still need a few clarifications:**\n\n');
                        for (const q of session.pendingQuestions) {
                            response.markdown(`**Q${q.index}:** ${q.question}\n\n`);
                        }
                        response.markdown(
                            "\nJust reply with your answers - I'll figure out which question each answer is for.\n",
                        );
                        return;
                    }

                    // All questions resolved! Continue to compilation
                    response.markdown('✓ All questions resolved automatically!\n\n');
                }

                // Complete - compile immediately
                response.markdown('\n---\n\nCompiling your prompt...\n\n');

                const compileSystemPrompt = getCompilePrompt(workspaceContext);
                const compileUserPrompt = `Context Packet:\n${JSON.stringify(session.contextPacket, null, 2)}\n\nOriginal Request:\n${session.rawRamble}`;
                const compiledPrompt = await sendToLLMWithLogging(
                    model,
                    compileSystemPrompt,
                    compileUserPrompt,
                    token,
                    {
                        debugLog,
                        phase: 'compilation',
                        label: 'Final prompt compilation',
                        questionRound: session.questionRound,
                    },
                );

                await context.workspaceState.update(LAST_PROMPT_KEY, compiledPrompt);
                session.state = 'DONE';
                await context.workspaceState.update(STATE_KEY, session);

                logger.info('Prompt compiled successfully', {
                    promptLength: compiledPrompt.length,
                    questionRounds: session.questionRound,
                });
                await debugLog?.logEvent('compilation', 'Compilation completed successfully');
                await debugLog?.finalize('completed');

                response.markdown('## Compiled Prompt\n\n```text\n' + compiledPrompt + '\n```\n\n');
                response.button({
                    command: 'ramble.copyLast',
                    title: '📋 Copy prompt',
                });
                response.button({
                    command: 'ramble.sendToJohann',
                    title: '🤖 Send to @johann',
                });
                response.button({
                    command: 'ramble.sendToCopilot',
                    title: '💬 Send to Copilot',
                });

                return { metadata: { compiled: true, prompt: compiledPrompt } };
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';
                logger.error('Error during prompt compilation', { error: errorMessage });
                await debugLog?.logEvent('other', `Error: ${errorMessage}`);
                await debugLog?.finalize('failed', errorMessage);
                response.markdown(`**Error:** ${errorMessage}\n`);
            }
        },
    );

    // Note: Followup provider removed - buttons are now shown after prompt compilation instead

    context.subscriptions.push(participant);

    // Register Johann orchestration agent
    const johannDisposables = registerJohannParticipant(context);
    for (const d of johannDisposables) {
        context.subscriptions.push(d);
    }

    // Register stop-all-workers command
    const stopAllCmd = vscode.commands.registerCommand('johann.stopAllWorkers', async () => {
        const { AcpWorkerManager } = await import('./johann/acpWorkerManager');
        const count = AcpWorkerManager.getActiveWorkerCount();
        if (count === 0) {
            vscode.window.showInformationMessage('No active Johann workers.');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            `Stop ${count} active worker(s)? Running tasks will be lost.`,
            { modal: true },
            'Stop All',
        );
        if (confirm === 'Stop All') {
            AcpWorkerManager.cleanupAllInstances();
            vscode.window.showInformationMessage(`Stopped ${count} worker(s).`);
        }
    });
    context.subscriptions.push(stopAllCmd);

    // Ensure workers are cleaned up when VS Code closes
    context.subscriptions.push({
        dispose() {
            // Dynamic import to avoid circular dependency issues at startup
            try {
                const { AcpWorkerManager } = require('./johann/acpWorkerManager');
                AcpWorkerManager.cleanupAllInstances();
            } catch {
                // Extension already partially torn down — try brute force
                try {
                    const { execSync } = require('child_process');
                    execSync('pkill -f "copilot.*--acp.*--stdio" 2>/dev/null || true');
                } catch (_e) {
                    // Best effort
                }
            }
            getActivityPanel().dispose();
        },
    });

    console.warn('Johann orchestration agent activated');
}

export function deactivate() {
    // Primary cleanup happens via context.subscriptions disposables above.
    // This is a fallback for any edge cases.
    try {
        const { AcpWorkerManager } = require('./johann/acpWorkerManager');
        AcpWorkerManager.cleanupAllInstances();
    } catch {
        // Already cleaned up
    }
}
