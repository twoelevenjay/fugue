import * as vscode from 'vscode';
import * as path from 'path';
import { registerJohannParticipant } from './johann/participant';

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
    if (!workspaceFolders) return '';

    const lines: string[] = ['Workspace structure:'];
    
    for (const folder of workspaceFolders) {
        lines.push(`\n📁 ${folder.name}/`);
        
        // Get top-level directories and key files
        try {
            const entries = await vscode.workspace.fs.readDirectory(folder.uri);
            const dirs: string[] = [];
            const files: string[] = [];
            
            for (const [name, type] of entries) {
                if (name.startsWith('.') && name !== '.github') continue;
                if (name === 'node_modules' || name === 'dist' || name === 'out' || name === 'build') continue;
                
                if (type === vscode.FileType.Directory) {
                    dirs.push(name);
                } else if (type === vscode.FileType.File) {
                    // Only include important files
                    if (name.match(/^(README|CHANGELOG|package\.json|tsconfig\.json|\.env\.example)$/i) ||
                        name.endsWith('.md')) {
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
// LLM INTERACTION
// ============================================================================

async function getLLM(): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: 'gpt-4o'
    });
    
    if (models.length === 0) {
        const anyModels = await vscode.lm.selectChatModels();
        return anyModels[0];
    }
    
    return models[0];
}

async function sendToLLM(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userPrompt: string,
    token: vscode.CancellationToken
): Promise<string> {
    const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt + '\n\n---\n\n' + userPrompt)
    ];
    
    const response = await model.sendRequest(messages, {}, token);
    
    let result = '';
    for await (const chunk of response.text) {
        result += chunk;
    }
    
    return result;
}

// ============================================================================
// ANALYSIS PROMPTS
// ============================================================================

function getAnalysisPrompt(workspaceContext: string): string {
    return `You are a prompt analysis assistant. Your job is to PRESERVE ALL FACTS from a user's rambling request while organizing them into a structured format. You remove filler words, not information.

${workspaceContext ? `IMPORTANT - WORKSPACE CONTEXT:
The user is working in a specific workspace. Use this context to understand references like project names, paths, and terminology:

${workspaceContext}

---

` : ''}Analyze the user's request and return a JSON object with this EXACT structure:
{
  "contextPacket": {
    "goal": "The main goal/objective. Preserve all specifics mentioned - if they said 'hooks inspired by WordPress action and filter hooks', include that exact framing.",
    "currentState": "COMPREHENSIVE description of current state. Include ALL mentioned: what exists, relationships between systems, what APIs are built, what's missing.",
    "constraints": ["Array of ALL constraints, requirements, architectural decisions, and rules mentioned - err on the side of including too much"],
    "inputsArtifacts": ["Array of ALL files, repos, systems, folders, or artifacts mentioned - USE FULL PATHS from workspace context when referenced by name/alias"],
    "outputFormat": "What format they need the output in (code, docs, analysis, etc.) - or empty string if not mentioned",
    "successCriteria": ["Array of success criteria or what 'done' looks like - or empty array if not mentioned"],
    "nonGoals": ["Things explicitly mentioned as out of scope"],
    "additionalContext": "ALL other relevant context - examples given, analogies used (like WordPress), technical concepts explained (action hooks vs filter hooks), relationships between components, lifecycle concepts, etc. BE THOROUGH."
  },
  "missingInfo": [
    {
      "index": 1,
      "question": "A specific, contextual question about what's missing",
      "field": "Which field this would fill (goal, outputFormat, successCriteria, constraint, etc.)"
    }
  ],
  "isComplete": true/false
}

CRITICAL RULES - PRESERVE ALL DISTINCT INFORMATION:
1. PRESERVE ALL DISTINCT FACTS - If the user mentioned "action hooks and filter hooks inspired by WordPress", that concept must appear. If they mentioned "Pre-Backend, Mid-Backend, Post-Backend", those must appear.
2. PRESERVE RELATIONSHIPS - If user explains how System A relates to System B (e.g., "shell provides hooks API to boilerplate"), that relationship must be captured.
3. PRESERVE EXAMPLES - If user gave examples (HID devices, webcam, digital scale, convention panels), include ALL of them.
4. PRESERVE TECHNICAL CONCEPTS - If user explained a concept (action hooks = execute code at lifecycle point, filter hooks = pass value through for modification), preserve that explanation.
5. USE THE WORKSPACE CONTEXT - Resolve aliases/keys to full paths when referenced.
6. OK TO CONDENSE:
   - Deduplicate: If the same fact is mentioned twice, keep one instance
   - Organize: If fragments about the same topic are scattered, merge them together
   - Paraphrase: "sometimes, always, most of the time" → "frequently"
   - Remove filler: um, uh, you know, like, basically
7. DO NOT REMOVE: distinct facts, examples, analogies, relationships, technical concepts, or anything that adds context - even if it could be stated more briefly.
8. Only add to missingInfo if information is GENUINELY unclear or missing and cannot be inferred.
9. Questions must be SPECIFIC to their request, not generic.
10. If the output format is implied (e.g., "implement hooks" implies code + documentation), fill it in.
11. isComplete should be true if you have enough info to write a good prompt.
12. DO NOT ask about file extensions, programming languages, or obvious technical details.
13. Return ONLY valid JSON, no markdown, no explanations.`;
}

function getCompilePrompt(workspaceContext: string): string {
    return `You are a prompt engineering expert. Your job is to take a context packet and compile it into an ideal, structured prompt for an AI coding assistant.

CRITICAL: PRESERVE ALL DISTINCT INFORMATION from the context packet. Your job is to format, organize, and present clearly. Every distinct fact, example, relationship, and technical concept must appear in the compiled prompt. You may paraphrase for clarity, but do not omit information.

${workspaceContext ? `WORKSPACE CONTEXT (include relevant parts in the compiled prompt):
${workspaceContext}

---

` : ''}The compiled prompt should:
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

Return ONLY the compiled prompt text, no explanations or meta-commentary. The prompt should be ready to copy-paste to another AI assistant.`;
}

function getMergePrompt(workspaceContext: string): string {
    return `You are merging user answers into an existing context packet. Integrate new information from answers while deduplicating any redundancy.

${workspaceContext ? `WORKSPACE CONTEXT:
${workspaceContext}

---

` : ''}Previous context packet:
{CONTEXT_PACKET}

Questions that were asked:
{QUESTIONS}

User's answers:
{ANSWERS}

CRITICAL RULES:
1. PRESERVE ALL DISTINCT FACTS from the previous context packet
2. ADD new information from answers to the appropriate fields
3. DEDUPLICATE: If new info repeats something already captured, don't duplicate it
4. ORGANIZE: Merge related fragments together for clarity
5. If an answer provides examples, add ALL distinct examples
6. If an answer explains a concept, preserve that explanation
7. Use the workspace context to resolve any project names or paths mentioned
8. Only mark as incomplete if genuinely critical information is still missing

Return this exact JSON structure:
{
  "contextPacket": { ... context packet with all previous content PLUS new information from answers ... },
  "missingInfo": [ ... any remaining questions, or empty array if complete ... ],
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

function looksLikeNewRequest(text: string): boolean {
    const trimmed = text.trim();
    
    if (trimmed.length > 150) {
        return true;
    }
    
    const lines = trimmed.split('\n').filter(l => l.trim());
    if (lines.length === 0) return false;
    
    const firstLine = lines[0].trim();
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
    
    if (lines.length > 3) {
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

    return lines.join('\n');
}

// ============================================================================
// CHAT PARTICIPANT HANDLER
// ============================================================================

export function activate(context: vscode.ExtensionContext) {
    console.log('Ramble for GitHub Copilot activated');

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

    // Register refresh context command
    const refreshCommand = vscode.commands.registerCommand('ramble.refreshContext', async () => {
        const workspaceCtx = await gatherWorkspaceContext();
        const formatted = formatWorkspaceContext(workspaceCtx);
        await context.workspaceState.update(WORKSPACE_CONTEXT_KEY, formatted);
        vscode.window.showInformationMessage('Workspace context refreshed!');
    });

    context.subscriptions.push(refreshCommand);

    // Register the chat participant
    const participant = vscode.chat.createChatParticipant('ramble', async (
        request: vscode.ChatRequest,
        chatContext: vscode.ChatContext,
        response: vscode.ChatResponseStream,
        token: vscode.CancellationToken
    ) => {
        const userMessage = request.prompt.trim();

        // Explicit reset command
        if (userMessage.toLowerCase() === 'reset' || userMessage.toLowerCase() === 'start over') {
            await context.workspaceState.update(STATE_KEY, createEmptySession());
            response.markdown('Session reset. Send me your request and I\'ll compile it into a structured prompt.\n');
            return;
        }

        // Refresh context command
        if (userMessage.toLowerCase() === 'refresh' || userMessage.toLowerCase() === 'refresh context') {
            response.markdown('Refreshing workspace context...\n');
            const workspaceCtx = await gatherWorkspaceContext();
            const formatted = formatWorkspaceContext(workspaceCtx);
            await context.workspaceState.update(WORKSPACE_CONTEXT_KEY, formatted);
            response.markdown('✅ Workspace context refreshed! Found:\n');
            response.markdown(`- Copilot instructions: ${workspaceCtx.copilotInstructions ? 'Yes' : 'No'}\n`);
            response.markdown(`- READMEs: ${workspaceCtx.readmes.length}\n`);
            response.markdown(`- Workspace folders: ${vscode.workspace.workspaceFolders?.length || 0}\n`);
            return;
        }

        // Get LLM
        const model = await getLLM();
        if (!model) {
            response.markdown('**Error:** No language model available. Please ensure Copilot is active.\n');
            return;
        }

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
        if (session.state === 'WAITING_FOR_ANSWERS' && looksLikeNewRequest(userMessage)) {
            session = createEmptySession();
            session.workspaceContext = workspaceContext;
        }

        // WAITING_FOR_ANSWERS: Process user answers
        if (session.state === 'WAITING_FOR_ANSWERS') {
            response.markdown('Processing your answers...\n\n');

            const mergePromptTemplate = getMergePrompt(workspaceContext);
            const mergePrompt = mergePromptTemplate
                .replace('{CONTEXT_PACKET}', JSON.stringify(session.contextPacket, null, 2))
                .replace('{QUESTIONS}', session.pendingQuestions.map(q => `Q${q.index}: ${q.question}`).join('\n'))
                .replace('{ANSWERS}', userMessage);

            try {
                const mergeResult = await sendToLLM(model, mergePrompt, '', token);
                const parsed = parseJSON<AnalysisResult>(mergeResult);

                if (!parsed) {
                    response.markdown('**Error:** Failed to process your answers. Please try again or type `reset` to start over.\n');
                    return;
                }

                session.contextPacket = parsed.contextPacket;

                if (!parsed.isComplete && parsed.missingInfo.length > 0 && session.questionRound < MAX_QUESTION_ROUNDS) {
                    session.pendingQuestions = parsed.missingInfo;
                    session.questionRound++;
                    session.state = 'WAITING_FOR_ANSWERS';
                    await context.workspaceState.update(STATE_KEY, session);

                    response.markdown('Thanks! A few more clarifications needed:\n\n');
                    for (const q of parsed.missingInfo) {
                        response.markdown(`**Q${q.index}:** ${q.question}\n\n`);
                    }
                    return;
                }

                // Complete - compile the prompt
                response.markdown('All information gathered. Compiling your prompt...\n\n');

                const compileSystemPrompt = getCompilePrompt(workspaceContext);
                const compileUserPrompt = `Context Packet:\n${JSON.stringify(session.contextPacket, null, 2)}\n\nOriginal Request:\n${session.rawRamble}`;
                const compiledPrompt = await sendToLLM(model, compileSystemPrompt, compileUserPrompt, token);

                await context.workspaceState.update(LAST_PROMPT_KEY, compiledPrompt);
                session.state = 'DONE';
                await context.workspaceState.update(STATE_KEY, session);

                response.markdown(formatContextPacketMarkdown(session.contextPacket));
                response.markdown('\n---\n\n## Compiled Prompt\n\n```text\n' + compiledPrompt + '\n```\n\n');
                response.button({
                    command: 'ramble.copyLast',
                    title: 'Copy compiled prompt',
                });
                return;

            } catch (err) {
                response.markdown(`**Error:** ${err instanceof Error ? err.message : 'Unknown error'}\n`);
                return;
            }
        }

        // NEW REQUEST: Analyze the ramble
        session = createEmptySession();
        session.rawRamble = userMessage;
        session.workspaceContext = workspaceContext;
        session.state = 'IDLE';

        response.markdown('Analyzing your request...\n\n');

        try {
            const analysisPrompt = getAnalysisPrompt(workspaceContext);
            const analysisResult = await sendToLLM(model, analysisPrompt, userMessage, token);
            const parsed = parseJSON<AnalysisResult>(analysisResult);

            if (!parsed) {
                response.markdown('**Error:** Failed to analyze your request. Please try again.\n');
                response.markdown('\n*Debug info:*\n```\n' + analysisResult.substring(0, 500) + '\n```\n');
                return;
            }

            session.contextPacket = parsed.contextPacket;

            // Show what was extracted
            response.markdown(formatContextPacketMarkdown(parsed.contextPacket));

            if (!parsed.isComplete && parsed.missingInfo.length > 0) {
                session.pendingQuestions = parsed.missingInfo;
                session.questionRound = 1;
                session.state = 'WAITING_FOR_ANSWERS';
                await context.workspaceState.update(STATE_KEY, session);

                response.markdown('\n---\n\n**I need a few clarifications:**\n\n');
                for (const q of parsed.missingInfo) {
                    response.markdown(`**Q${q.index}:** ${q.question}\n\n`);
                }
                response.markdown('\nJust reply with your answers - I\'ll figure out which question each answer is for.\n');
                return;
            }

            // Complete - compile immediately
            response.markdown('\n---\n\nCompiling your prompt...\n\n');

            const compileSystemPrompt = getCompilePrompt(workspaceContext);
            const compileUserPrompt = `Context Packet:\n${JSON.stringify(session.contextPacket, null, 2)}\n\nOriginal Request:\n${session.rawRamble}`;
            const compiledPrompt = await sendToLLM(model, compileSystemPrompt, compileUserPrompt, token);

            await context.workspaceState.update(LAST_PROMPT_KEY, compiledPrompt);
            session.state = 'DONE';
            await context.workspaceState.update(STATE_KEY, session);

            response.markdown('## Compiled Prompt\n\n```text\n' + compiledPrompt + '\n```\n\n');
            response.button({
                command: 'ramble.copyLast',
                title: 'Copy compiled prompt',
            });

        } catch (err) {
            response.markdown(`**Error:** ${err instanceof Error ? err.message : 'Unknown error'}\n`);
        }
    });

    context.subscriptions.push(participant);

    // Register Johann orchestration agent
    const johannDisposables = registerJohannParticipant(context);
    for (const d of johannDisposables) {
        context.subscriptions.push(d);
    }

    console.log('Johann orchestration agent activated');
}

export function deactivate() {
    // Clean up if needed
}
