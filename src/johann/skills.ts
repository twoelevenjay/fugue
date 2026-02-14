import * as vscode from 'vscode';
import { getJohannWorkspaceUri } from './bootstrap';

// ============================================================================
// SKILLS SYSTEM — Discoverable skills from .vscode/johann/skills/
//
// Inspired by OpenClaw's skills architecture:
// - Skills are directories under .vscode/johann/skills/
// - Each skill has a SKILL.md with name, description, and instructions
// - Skills are discovered at startup and injected into the system prompt
// - The LLM checks skill descriptions before answering — if a skill applies,
//   it follows that skill's instructions
//
// Skill directory structure:
//   .vscode/johann/skills/
//     my-skill/
//       SKILL.md     — Description and instructions
//       *.md|*.txt   — Supporting files (optional)
// ============================================================================

/**
 * A discovered skill.
 */
export interface Skill {
    /** Skill name (directory name) */
    name: string;
    /** Short description (from SKILL.md front matter) */
    description: string;
    /** Full instructions (from SKILL.md body) */
    instructions: string;
    /** Path to the skill directory */
    dirUri: vscode.Uri;
    /** Supporting files found in the skill directory */
    supportingFiles: string[];
}

/**
 * Discover all skills in the skills directory.
 */
export async function discoverSkills(): Promise<Skill[]> {
    const base = getJohannWorkspaceUri();
    if (!base) return [];

    const skillsDir = vscode.Uri.joinPath(base, 'skills');

    try {
        const entries = await vscode.workspace.fs.readDirectory(skillsDir);
        const skills: Skill[] = [];

        for (const [name, type] of entries) {
            if (type !== vscode.FileType.Directory) continue;

            const skillDir = vscode.Uri.joinPath(skillsDir, name);
            const skill = await loadSkill(name, skillDir);
            if (skill) {
                skills.push(skill);
            }
        }

        return skills;
    } catch {
        return [];
    }
}

/**
 * Load a single skill from its directory.
 */
async function loadSkill(name: string, dirUri: vscode.Uri): Promise<Skill | undefined> {
    const skillMdUri = vscode.Uri.joinPath(dirUri, 'SKILL.md');

    try {
        const bytes = await vscode.workspace.fs.readFile(skillMdUri);
        const content = new TextDecoder().decode(bytes);

        const { description, instructions } = parseSkillMd(content, name);

        // Find supporting files
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        const supportingFiles = entries
            .filter(([fname, ftype]) =>
                ftype === vscode.FileType.File &&
                fname !== 'SKILL.md' &&
                (fname.endsWith('.md') || fname.endsWith('.txt'))
            )
            .map(([fname]) => fname);

        return {
            name,
            description,
            instructions,
            dirUri,
            supportingFiles,
        };
    } catch {
        // No SKILL.md — not a valid skill
        return undefined;
    }
}

/**
 * Parse SKILL.md content to extract description and instructions.
 *
 * Expected format:
 * ```
 * # Skill Name
 * > Short description of what the skill does
 *
 * ## Instructions
 * Full instructions for how to use this skill...
 * ```
 *
 * Or with YAML-like front matter:
 * ```
 * ---
 * name: skill-name
 * description: Short description
 * ---
 * Instructions here...
 * ```
 */
function parseSkillMd(content: string, fallbackName: string): { description: string; instructions: string } {
    // Try YAML front matter first
    const frontMatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (frontMatterMatch) {
        const frontMatter = frontMatterMatch[1];
        const body = frontMatterMatch[2].trim();

        const descMatch = frontMatter.match(/description:\s*(.+)/i);
        const description = descMatch ? descMatch[1].trim() : fallbackName;

        return { description, instructions: body };
    }

    // Try blockquote description
    const lines = content.split('\n');
    let description = fallbackName;
    let instructionStart = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('> ')) {
            description = line.replace(/^>\s*/, '').trim();
            instructionStart = i + 1;
            break;
        }
        if (line.startsWith('# ')) {
            // Skip title line
            continue;
        }
        if (line.length > 0) {
            // First non-empty, non-title line is the description
            description = line;
            instructionStart = i + 1;
            break;
        }
    }

    const instructions = lines.slice(instructionStart).join('\n').trim();

    return { description, instructions };
}

/**
 * Read a supporting file from a skill directory.
 */
export async function readSkillFile(skill: Skill, filename: string): Promise<string> {
    const fileUri = vscode.Uri.joinPath(skill.dirUri, filename);
    try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

/**
 * Format discovered skills as a list for system prompt injection.
 * Returns an array of "name: description" strings.
 */
export function formatSkillsForPrompt(skills: Skill[]): string[] {
    return skills.map(s => `**${s.name}**: ${s.description}`);
}

/**
 * Get the full instructions for a specific skill.
 */
export function getSkillInstructions(skills: Skill[], name: string): string | undefined {
    const skill = skills.find(s => s.name === name);
    return skill?.instructions;
}

/**
 * Create a new skill directory with a template SKILL.md.
 */
export async function createSkill(name: string, description: string): Promise<Skill | undefined> {
    const base = getJohannWorkspaceUri();
    if (!base) return undefined;

    const skillDir = vscode.Uri.joinPath(base, 'skills', name);
    try {
        await vscode.workspace.fs.createDirectory(skillDir);
    } catch {
        // Already exists
    }

    const skillMd = `# ${name}
> ${description}

## Instructions

<!-- Write instructions for this skill here.
     Johann will follow these instructions when this skill applies. -->

When this skill is triggered:
1. (define steps here)
2. ...
`;

    const skillMdUri = vscode.Uri.joinPath(skillDir, 'SKILL.md');
    await vscode.workspace.fs.writeFile(skillMdUri, new TextEncoder().encode(skillMd));

    return loadSkill(name, skillDir);
}
