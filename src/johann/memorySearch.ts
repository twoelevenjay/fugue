import * as vscode from 'vscode';
import { getJohannWorkspaceUri } from './bootstrap';

// ============================================================================
// MEMORY SEARCH — Keyword-based search across all memory sources
//
// Searches across:
// 1. MEMORY.md (curated long-term knowledge)
// 2. memory/*.md (daily notes)
// 3. Individual memory entries in .vscode/johann/*.md
//
// Simple keyword matching (no embeddings, no SQLite) — designed for
// a VS Code extension where we want zero external dependencies.
// ============================================================================

/**
 * A single search result with context.
 */
export interface MemorySearchResult {
    /** Source file path (relative to .vscode/johann/) */
    source: string;
    /** Matching lines with surrounding context */
    snippet: string;
    /** Relevance score (higher = more relevant) */
    score: number;
    /** The matching line numbers (1-based) */
    matchLines: number[];
}

/**
 * Search configuration.
 */
export interface MemorySearchOptions {
    /** Maximum results to return */
    maxResults?: number;
    /** Lines of context around each match */
    contextLines?: number;
    /** Minimum score to include */
    minScore?: number;
    /** Only search in specific subdirectories */
    searchDirs?: string[];
}

const DEFAULT_OPTIONS: Required<MemorySearchOptions> = {
    maxResults: 10,
    contextLines: 3,
    minScore: 1,
    searchDirs: ['.', 'memory'],
};

/**
 * Search all memory files for keywords.
 * Keywords are split by spaces and matched case-insensitively.
 * Score is based on number of keyword matches per snippet.
 */
export async function searchMemory(
    query: string,
    options: MemorySearchOptions = {},
): Promise<MemorySearchResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const base = getJohannWorkspaceUri();
    if (!base) {
        return [];
    }

    // Extract keywords from query
    const keywords = extractKeywords(query);
    if (keywords.length === 0) {
        return [];
    }

    const results: MemorySearchResult[] = [];

    // Search each configured directory
    for (const dir of opts.searchDirs) {
        const dirUri = dir === '.' ? base : vscode.Uri.joinPath(base, dir);

        const dirResults = await searchDirectory(dirUri, dir, keywords, opts);
        results.push(...dirResults);
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Limit results
    return results.slice(0, opts.maxResults);
}

/**
 * Search files in a single directory.
 */
async function searchDirectory(
    dirUri: vscode.Uri,
    dirLabel: string,
    keywords: string[],
    opts: Required<MemorySearchOptions>,
): Promise<MemorySearchResult[]> {
    const results: MemorySearchResult[] = [];

    try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);

        for (const [name, type] of entries) {
            if (type !== vscode.FileType.File || !name.endsWith('.md')) {
                continue;
            }

            const fileUri = vscode.Uri.joinPath(dirUri, name);
            const content = await readFileContent(fileUri);
            if (!content) {
                continue;
            }

            const source = dirLabel === '.' ? name : `${dirLabel}/${name}`;
            const fileResults = searchFileContent(source, content, keywords, opts);
            results.push(...fileResults);
        }
    } catch {
        // Directory doesn't exist or can't be read
    }

    return results;
}

/**
 * Search within a single file's content.
 */
function searchFileContent(
    source: string,
    content: string,
    keywords: string[],
    opts: Required<MemorySearchOptions>,
): MemorySearchResult[] {
    const lines = content.split('\n');
    const matchingLineNums: Map<number, Set<string>> = new Map();

    // Find all lines that match any keyword
    for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase();
        for (const kw of keywords) {
            if (lineLower.includes(kw)) {
                if (!matchingLineNums.has(i)) {
                    matchingLineNums.set(i, new Set());
                }
                matchingLineNums.get(i)!.add(kw);
            }
        }
    }

    if (matchingLineNums.size === 0) {
        return [];
    }

    // Group adjacent matches into snippets
    const snippets = groupAdjacentMatches(
        Array.from(matchingLineNums.keys()).sort((a, b) => a - b),
        opts.contextLines,
    );

    const results: MemorySearchResult[] = [];

    for (const group of snippets) {
        // Calculate context window
        const startLine = Math.max(0, group[0] - opts.contextLines);
        const endLine = Math.min(lines.length - 1, group[group.length - 1] + opts.contextLines);

        const snippetLines = lines.slice(startLine, endLine + 1);
        const snippet = snippetLines.join('\n');

        // Calculate score: unique keywords matched × match count
        const uniqueKeywords = new Set<string>();
        let totalMatches = 0;
        for (const lineNum of group) {
            const kws = matchingLineNums.get(lineNum);
            if (kws) {
                kws.forEach((kw) => uniqueKeywords.add(kw));
                totalMatches += kws.size;
            }
        }

        const score = uniqueKeywords.size * 2 + totalMatches;

        if (score >= opts.minScore) {
            results.push({
                source,
                snippet,
                score,
                matchLines: group.map((n) => n + 1), // Convert to 1-based
            });
        }
    }

    return results;
}

/**
 * Group adjacent line numbers into clusters.
 * Lines within `contextSize` of each other are grouped together.
 */
function groupAdjacentMatches(lineNums: number[], contextSize: number): number[][] {
    if (lineNums.length === 0) {
        return [];
    }

    const groups: number[][] = [[lineNums[0]]];

    for (let i = 1; i < lineNums.length; i++) {
        const currentGroup = groups[groups.length - 1];
        const lastInGroup = currentGroup[currentGroup.length - 1];

        if (lineNums[i] - lastInGroup <= contextSize * 2) {
            // Close enough to merge into current group
            currentGroup.push(lineNums[i]);
        } else {
            // Start a new group
            groups.push([lineNums[i]]);
        }
    }

    return groups;
}

/**
 * Extract and normalize keywords from a search query.
 * Removes stop words, lowercases, and deduplicates.
 */
function extractKeywords(query: string): string[] {
    const stopWords = new Set([
        'a',
        'an',
        'the',
        'is',
        'are',
        'was',
        'were',
        'be',
        'been',
        'being',
        'have',
        'has',
        'had',
        'do',
        'does',
        'did',
        'will',
        'would',
        'could',
        'should',
        'may',
        'might',
        'shall',
        'can',
        'to',
        'of',
        'in',
        'for',
        'on',
        'with',
        'at',
        'by',
        'from',
        'as',
        'into',
        'through',
        'during',
        'before',
        'after',
        'above',
        'below',
        'between',
        'and',
        'but',
        'or',
        'not',
        'no',
        'nor',
        'so',
        'yet',
        'both',
        'either',
        'neither',
        'each',
        'every',
        'all',
        'any',
        'few',
        'more',
        'most',
        'some',
        'such',
        'than',
        'too',
        'very',
        'just',
        'about',
        'what',
        'which',
        'who',
        'whom',
        'this',
        'that',
        'these',
        'those',
        'it',
        'its',
        'i',
        'me',
        'my',
        'we',
        'us',
        'our',
        'you',
        'your',
        'he',
        'him',
        'his',
        'she',
        'her',
        'they',
        'them',
        'their',
    ]);

    const words = query
        .toLowerCase()
        .replace(/[^a-z0-9\s-_./]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !stopWords.has(w));

    return [...new Set(words)];
}

/**
 * Format search results as a readable string for prompt injection.
 */
export function formatSearchResults(results: MemorySearchResult[]): string {
    if (results.length === 0) {
        return 'No memory matches found.';
    }

    const lines: string[] = ['=== Memory Search Results ===', ''];

    for (const result of results) {
        lines.push(`**[${result.source}]** (score: ${result.score})`);
        lines.push('```');
        lines.push(result.snippet);
        lines.push('```');
        lines.push('');
    }

    return lines.join('\n');
}

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

async function readFileContent(uri: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}
