import * as vscode from 'vscode';
import {
    BOOTSTRAP_TEMPLATES,
    SUBAGENT_BOOTSTRAP_FILES,
    PRIVATE_BOOTSTRAP_FILES,
} from './templates';

// ============================================================================
// BOOTSTRAP LOADER — Loads and manages workspace bootstrap files
//
// Inspired by OpenClaw's bootstrap-files.ts:
// - On first run, copies templates into .vscode/johann/
// - Loads all bootstrap files at every agent run
// - Injects into system prompt under "# Project Context"
// - Subagents get reduced set (AGENTS.md + TOOLS.md only)
// - Files capped at configurable max chars to avoid context overflow
// - Detects first run via presence of BOOTSTRAP.md
// ============================================================================

export interface BootstrapFile {
    /** Filename (e.g., 'SOUL.md') */
    name: string;
    /** Full file content */
    content: string;
    /** Whether this file existed before (false = just created from template) */
    existed: boolean;
}

export interface BootstrapContext {
    /** All loaded bootstrap files */
    files: BootstrapFile[];
    /** Whether this is a first run (BOOTSTRAP.md present) */
    isFirstRun: boolean;
    /** The workspace directory URI */
    workspaceDir: vscode.Uri;
}

/** Default max total chars for bootstrap context injection */
const DEFAULT_MAX_BOOTSTRAP_CHARS = 15000;

/**
 * Get the Johann workspace directory URI.
 */
export function getJohannWorkspaceUri(): vscode.Uri | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return undefined;
    return vscode.Uri.joinPath(folders[0].uri, '.vscode', 'johann');
}

/**
 * Ensure the Johann workspace directory and subdirectories exist.
 */
async function ensureDirectories(baseUri: vscode.Uri): Promise<void> {
    const dirs = [
        baseUri,
        vscode.Uri.joinPath(baseUri, 'memory'),
        vscode.Uri.joinPath(baseUri, 'sessions'),
        vscode.Uri.joinPath(baseUri, 'skills'),
        vscode.Uri.joinPath(baseUri, 'registry'),
    ];

    for (const dir of dirs) {
        try {
            await vscode.workspace.fs.createDirectory(dir);
        } catch {
            // Already exists
        }
    }
}

/**
 * Check if a file exists.
 */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

/**
 * Read a file's content, returning empty string if not found.
 */
async function readFileContent(uri: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

/**
 * Write content to a file.
 */
async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
    const encoder = new TextEncoder();
    await vscode.workspace.fs.writeFile(uri, encoder.encode(content));
}

/**
 * Initialize the bootstrap workspace on first run.
 * Copies template files into .vscode/johann/ if they don't exist.
 * Returns true if this was a first run (BOOTSTRAP.md was created).
 *
 * IMPORTANT: BOOTSTRAP.md is a one-shot sentinel. Once `completeBootstrap()`
 * deletes it, it must NOT be re-created. We detect a true first run by
 * checking whether the Johann directory itself existed before this call.
 */
export async function initializeBootstrapWorkspace(
    baseUri: vscode.Uri
): Promise<boolean> {
    // Check if the Johann directory already exists BEFORE ensuring dirs.
    // If it exists, this is NOT a first run — even if BOOTSTRAP.md is gone.
    const dirAlreadyExists = await fileExists(baseUri);

    await ensureDirectories(baseUri);

    let isFirstRun = false;

    for (const [filename, template] of Object.entries(BOOTSTRAP_TEMPLATES)) {
        // Skip re-creating BOOTSTRAP.md once the workspace is established.
        // It's a one-shot sentinel that gets deleted by completeBootstrap().
        if (filename === 'BOOTSTRAP.md' && dirAlreadyExists) {
            continue;
        }

        const fileUri = vscode.Uri.joinPath(baseUri, filename);
        const exists = await fileExists(fileUri);

        if (!exists) {
            await writeFile(fileUri, template);
            if (filename === 'BOOTSTRAP.md') {
                isFirstRun = true;
            }
        }
    }

    // Create .gitignore for the johann directory (don't track sessions)
    const gitignoreUri = vscode.Uri.joinPath(baseUri, '.gitignore');
    if (!(await fileExists(gitignoreUri))) {
        await writeFile(gitignoreUri, [
            '# Johann workspace',
            'sessions/',
            'registry/',
            '*.sqlite',
            '',
        ].join('\n'));
    }

    return isFirstRun;
}

/**
 * Delete the BOOTSTRAP.md file after onboarding is complete.
 */
export async function completeBootstrap(baseUri: vscode.Uri): Promise<void> {
    const bootstrapUri = vscode.Uri.joinPath(baseUri, 'BOOTSTRAP.md');
    try {
        await vscode.workspace.fs.delete(bootstrapUri);
    } catch {
        // Already deleted
    }
}

/**
 * Load all bootstrap files from the workspace.
 * Creates missing files from templates automatically.
 */
export async function loadBootstrapFiles(
    baseUri: vscode.Uri
): Promise<BootstrapContext> {
    // Ensure workspace exists and templates are in place
    const isFirstRun = await initializeBootstrapWorkspace(baseUri);

    const files: BootstrapFile[] = [];

    for (const filename of Object.keys(BOOTSTRAP_TEMPLATES)) {
        const fileUri = vscode.Uri.joinPath(baseUri, filename);
        const content = await readFileContent(fileUri);

        if (content) {
            files.push({
                name: filename,
                content,
                existed: true, // At this point all files exist (we just created missing ones)
            });
        }
    }

    return { files, isFirstRun, workspaceDir: baseUri };
}

/**
 * Filter bootstrap files for a subagent session.
 * Subagents only get AGENTS.md and TOOLS.md — they're ephemeral workers,
 * not the full personality.
 */
export function filterBootstrapFilesForSession(
    files: BootstrapFile[],
    mode: 'full' | 'minimal' | 'none'
): BootstrapFile[] {
    if (mode === 'none') return [];

    if (mode === 'minimal') {
        return files.filter(f => SUBAGENT_BOOTSTRAP_FILES.includes(f.name));
    }

    // Full mode — include everything
    return files;
}

/**
 * Format bootstrap files for injection into the system prompt.
 * Caps total content at maxChars to avoid context overflow.
 */
export function formatBootstrapForPrompt(
    files: BootstrapFile[],
    maxChars: number = DEFAULT_MAX_BOOTSTRAP_CHARS
): string {
    if (files.length === 0) return '';

    const sections: string[] = [];
    sections.push('# Project Context — Johann Workspace Files\n');
    sections.push('> These files define your identity, instructions, and memory.');
    sections.push('> You can read and write these files to update yourself.\n');

    let totalChars = sections.join('\n').length;

    for (const file of files) {
        const header = `\n## ${file.name}\n`;
        const content = file.content;
        const sectionLength = header.length + content.length;

        if (totalChars + sectionLength > maxChars) {
            // Truncate this file to fit
            const remaining = maxChars - totalChars - header.length - 50;
            if (remaining > 200) {
                sections.push(header);
                sections.push(content.substring(0, remaining));
                sections.push('\n\n[... truncated for context window ...]');
            }
            break;
        }

        sections.push(header);
        sections.push(content);
        totalChars += sectionLength;
    }

    return sections.join('\n');
}

/**
 * Write a bootstrap file back to the workspace.
 * Used when the agent wants to update its own files (SOUL.md, MEMORY.md, etc.)
 */
export async function writeBootstrapFile(
    baseUri: vscode.Uri,
    filename: string,
    content: string
): Promise<void> {
    const fileUri = vscode.Uri.joinPath(baseUri, filename);
    await writeFile(fileUri, content);
}

/**
 * Read a specific bootstrap file.
 */
export async function readBootstrapFile(
    baseUri: vscode.Uri,
    filename: string
): Promise<string> {
    const fileUri = vscode.Uri.joinPath(baseUri, filename);
    return readFileContent(fileUri);
}
