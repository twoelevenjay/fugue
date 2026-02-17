import * as vscode from 'vscode';
import { getLogger } from './logger';

// ============================================================================
// BOOTSTRAP CONTEXT — Auto-detect project environment & inject awareness
//
// Inspired by OpenClaw's bootstrap file injection pattern:
// Scans the workspace for project-descriptor files (package.json,
// .ddev/config.yaml, docker-compose.yml, AGENTS.md, etc.) and builds
// a compact context string that gives the planner and subagents
// awareness of what tools, runtimes, and services are available.
//
// Key design principles:
// - Files are truncated (head + tail) to stay within token budget
// - Environment capabilities are explicitly surfaced (e.g., "DDEV detected:
//   you have `ddev wp`, `ddev exec`, `ddev mysql` available")
// - This context is injected ONCE at planning time and ONCE per subagent
// ============================================================================

/**
 * Maximum characters per bootstrap file. Files longer than this are
 * truncated to 70% head + 20% tail (following OpenClaw's pattern).
 */
const MAX_FILE_CHARS = 8000;

/**
 * Maximum total bootstrap context size.
 * Keeps the combined injection under ~5K tokens.
 */
const MAX_TOTAL_CHARS = 20000;

/**
 * Files to look for in the workspace root (in priority order).
 * Each entry: [glob pattern, user-friendly label, whether to read contents]
 */
const BOOTSTRAP_FILES: [string, string, boolean][] = [
    ['.ddev/config.yaml', 'DDEV Configuration', true],
    ['.ddev/config.yml', 'DDEV Configuration', true],
    ['docker-compose.yml', 'Docker Compose', true],
    ['docker-compose.yaml', 'Docker Compose', true],
    ['package.json', 'Node.js Package', true],
    ['composer.json', 'PHP Composer', true],
    ['Gemfile', 'Ruby Gemfile', true],
    ['requirements.txt', 'Python Requirements', true],
    ['pyproject.toml', 'Python Project', true],
    ['go.mod', 'Go Module', true],
    ['Cargo.toml', 'Rust Cargo', true],
    ['Makefile', 'Makefile', true],
    ['.env', 'Environment Variables', false], // Don't read — may contain secrets
    ['.env.example', 'Environment Template', true],
    ['AGENTS.md', 'Agent Instructions', true],
    ['CLAUDE.md', 'AI Instructions', true],
    ['.cursorrules', 'Cursor Rules', true],
    ['.github/copilot-instructions.md', 'Copilot Instructions', true],
    ['README.md', 'Project README', true],
    ['wp-config.php', 'WordPress Config', false], // Don't read — contains secrets
];

/**
 * Describes a detected environment capability.
 */
interface EnvironmentCapability {
    name: string;
    description: string;
    commands: string[];
}

/**
 * Result of scanning the workspace for bootstrap context.
 */
export interface BootstrapResult {
    /** Detected environment capabilities (DDEV, Docker, npm, etc.) */
    capabilities: EnvironmentCapability[];
    /** Contents of detected bootstrap files (truncated) */
    fileContents: Map<string, string>;
    /** Full formatted context string ready for injection */
    contextBlock: string;
    /** Whether any project context was found at all */
    hasContext: boolean;
}

/**
 * Truncate a file's content using head+tail strategy.
 * 70% from the head, 20% from the tail, with a clear marker in between.
 */
function truncateFile(content: string, maxChars: number): string {
    if (content.length <= maxChars) {
        return content;
    }
    const headSize = Math.floor(maxChars * 0.7);
    const tailSize = Math.floor(maxChars * 0.2);
    const head = content.substring(0, headSize);
    const tail = content.substring(content.length - tailSize);
    const omitted = content.length - headSize - tailSize;
    return head + `\n\n... [${omitted} chars omitted] ...\n\n` + tail;
}

/**
 * Detect environment capabilities from the discovered files.
 */
function detectCapabilities(files: Map<string, string>): EnvironmentCapability[] {
    const caps: EnvironmentCapability[] = [];

    // DDEV Detection
    if (files.has('.ddev/config.yaml') || files.has('.ddev/config.yml')) {
        const ddevConfig = files.get('.ddev/config.yaml') || files.get('.ddev/config.yml') || '';
        const projectType = ddevConfig.match(/type:\s*(\S+)/)?.[1] || 'generic';
        const phpVersion = ddevConfig.match(/php_version:\s*["']?(\S+)/)?.[1];
        const dbType = ddevConfig.match(/database:\s*\n\s+type:\s*(\S+)/)?.[1] || 'MariaDB';

        const commands = [
            'ddev start — Start all DDEV containers',
            'ddev stop — Stop all containers',
            'ddev restart — Restart all containers',
            'ddev describe — Show project URLs, ports, and status',
            'ddev ssh — SSH into the web container',
            'ddev exec <command> — Run a command inside the web container',
            'ddev logs — View container logs',
            'ddev mysql — Direct MySQL/MariaDB shell access',
            'ddev export-db — Export database',
            'ddev import-db — Import database',
        ];

        if (projectType === 'wordpress') {
            commands.push(
                'ddev wp <command> — Run WP-CLI commands (e.g., ddev wp plugin list)',
                'ddev wp theme list — List installed themes',
                'ddev wp option get siteurl — Get the site URL',
                'ddev wp db export — Export WordPress database',
                'ddev wp search-replace — Search and replace in database',
            );
        } else if (projectType === 'drupal' || projectType === 'drupal9' || projectType === 'drupal10') {
            commands.push(
                'ddev drush <command> — Run Drush commands',
                'ddev drush cr — Clear Drupal cache',
                'ddev drush uli — Generate one-time login link',
            );
        } else if (projectType === 'laravel') {
            commands.push(
                'ddev artisan <command> — Run Laravel Artisan commands',
                'ddev php artisan migrate — Run database migrations',
            );
        }

        caps.push({
            name: 'DDEV',
            description: `DDEV local dev environment (type: ${projectType}${phpVersion ? `, PHP ${phpVersion}` : ''}, DB: ${dbType}). All services are containerized — use \`ddev exec\` to run commands inside the container.`,
            commands,
        });
    }

    // Docker Detection (without DDEV)
    if ((files.has('docker-compose.yml') || files.has('docker-compose.yaml')) &&
        !files.has('.ddev/config.yaml') && !files.has('.ddev/config.yml')) {
        caps.push({
            name: 'Docker Compose',
            description: 'Docker Compose multi-container setup. Services are defined in docker-compose.yml.',
            commands: [
                'docker compose up -d — Start all services in background',
                'docker compose down — Stop and remove containers',
                'docker compose logs — View container logs',
                'docker compose exec <service> <command> — Run command in a service',
                'docker compose ps — List running containers',
                'docker compose build — Rebuild images',
            ],
        });
    }

    // Node.js Detection
    if (files.has('package.json')) {
        try {
            const pkg = JSON.parse(files.get('package.json')!);
            const scripts = Object.keys(pkg.scripts || {});
            const deps = Object.keys(pkg.dependencies || {});
            const devDeps = Object.keys(pkg.devDependencies || {});

            const manager = files.has('pnpm-lock.yaml') ? 'pnpm' :
                files.has('yarn.lock') ? 'yarn' : 'npm';

            const commands = [
                `${manager} install — Install dependencies`,
                `${manager} run <script> — Run a package.json script`,
            ];

            if (scripts.length > 0) {
                commands.push(`Available scripts: ${scripts.slice(0, 10).join(', ')}${scripts.length > 10 ? '...' : ''}`);
            }

            const frameworks: string[] = [];
            if (deps.includes('react') || devDeps.includes('react')) { frameworks.push('React'); }
            if (deps.includes('next') || devDeps.includes('next')) { frameworks.push('Next.js'); }
            if (deps.includes('vue') || devDeps.includes('vue')) { frameworks.push('Vue'); }
            if (deps.includes('express') || devDeps.includes('express')) { frameworks.push('Express'); }
            if (deps.includes('@angular/core') || devDeps.includes('@angular/core')) { frameworks.push('Angular'); }
            if (deps.includes('svelte') || devDeps.includes('svelte')) { frameworks.push('Svelte'); }

            caps.push({
                name: 'Node.js',
                description: `Node.js project (${manager})${frameworks.length > 0 ? ` with ${frameworks.join(', ')}` : ''}`,
                commands,
            });
        } catch {
            caps.push({
                name: 'Node.js',
                description: 'Node.js project (package.json found but could not be parsed)',
                commands: ['npm install', 'npm run <script>'],
            });
        }
    }

    // PHP/Composer Detection
    if (files.has('composer.json')) {
        caps.push({
            name: 'PHP/Composer',
            description: 'PHP project with Composer dependency management',
            commands: [
                'composer install — Install PHP dependencies',
                'composer require <package> — Add a dependency',
                'composer dump-autoload — Regenerate autoload files',
            ],
        });
    }

    // WordPress Detection (via wp-config.php or DDEV type)
    if (files.has('wp-config.php')) {
        caps.push({
            name: 'WordPress',
            description: 'WordPress installation detected (wp-config.php found)',
            commands: [
                'wp plugin list — List installed plugins',
                'wp theme list — List installed themes',
                'wp option get <option> — Get a WordPress option',
                'wp db export — Export database',
                'wp cache flush — Flush object cache',
            ],
        });
    }

    // Python Detection
    if (files.has('requirements.txt') || files.has('pyproject.toml')) {
        caps.push({
            name: 'Python',
            description: 'Python project detected',
            commands: [
                'pip install -r requirements.txt — Install dependencies',
                'python -m pytest — Run tests',
                'python manage.py — Django management commands (if Django)',
            ],
        });
    }

    // Go Detection
    if (files.has('go.mod')) {
        caps.push({
            name: 'Go',
            description: 'Go module detected',
            commands: [
                'go build ./... — Build all packages',
                'go test ./... — Run all tests',
                'go mod tidy — Clean up module dependencies',
            ],
        });
    }

    // Rust Detection
    if (files.has('Cargo.toml')) {
        caps.push({
            name: 'Rust',
            description: 'Rust project detected',
            commands: [
                'cargo build — Build the project',
                'cargo test — Run tests',
                'cargo run — Build and run',
            ],
        });
    }

    return caps;
}

/**
 * Format capabilities into a prompt-friendly context block.
 */
function formatCapabilities(caps: EnvironmentCapability[]): string {
    if (caps.length === 0) {
        return '';
    }

    const lines: string[] = [
        '=== DETECTED ENVIRONMENT CAPABILITIES ===',
        'The following tools and services are AVAILABLE in this project.',
        'You MUST use them when relevant — do NOT install alternatives or workarounds.',
        '',
    ];

    for (const cap of caps) {
        lines.push(`### ${cap.name}`);
        lines.push(cap.description);
        lines.push('');
        lines.push('Available commands:');
        for (const cmd of cap.commands) {
            lines.push(`  - ${cmd}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format file contents into a prompt-friendly context block.
 */
function formatFileContents(files: Map<string, string>): string {
    if (files.size === 0) {
        return '';
    }

    const lines: string[] = [
        '=== PROJECT FILES (auto-detected) ===',
        '',
    ];

    for (const [path, content] of files) {
        if (!content) { continue; }
        lines.push(`--- ${path} ---`);
        lines.push(content);
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Scan the workspace for project bootstrap files and build context.
 * This is the main entry point — call this at orchestration start.
 */
export async function scanBootstrapContext(
    workspaceRoot?: string
): Promise<BootstrapResult> {
    const result: BootstrapResult = {
        capabilities: [],
        fileContents: new Map(),
        contextBlock: '',
        hasContext: false,
    };

    // Determine workspace root
    let rootUri: vscode.Uri;
    if (workspaceRoot) {
        rootUri = vscode.Uri.file(workspaceRoot);
    } else {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            return result;
        }
        rootUri = folders[0].uri;
    }

    // Scan for bootstrap files
    const discoveredFiles = new Map<string, string>();

    for (const [pattern, label, shouldRead] of BOOTSTRAP_FILES) {
        try {
            const fileUri = vscode.Uri.joinPath(rootUri, pattern);
            await vscode.workspace.fs.stat(fileUri); // Check existence

            if (shouldRead) {
                const content = await vscode.workspace.fs.readFile(fileUri);
                const text = Buffer.from(content).toString('utf-8');
                const truncated = truncateFile(text, MAX_FILE_CHARS);
                discoveredFiles.set(pattern, truncated);
            } else {
                // File exists but we don't read it (secrets, etc.)
                discoveredFiles.set(pattern, `[${label} detected — contents not read for security]`);
            }
        } catch {
            // File doesn't exist — skip
        }
    }

    // Also check for lock files (used for package manager detection)
    for (const lockFile of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json']) {
        try {
            const fileUri = vscode.Uri.joinPath(rootUri, lockFile);
            await vscode.workspace.fs.stat(fileUri);
            discoveredFiles.set(lockFile, '[lock file detected]');
        } catch {
            // Not found — skip
        }
    }

    if (discoveredFiles.size === 0) {
        return result;
    }

    // Detect environment capabilities
    const capabilities = detectCapabilities(discoveredFiles);

    // Build the context block
    const capBlock = formatCapabilities(capabilities);
    const fileBlock = formatFileContents(discoveredFiles);

    // Combine and enforce total size limit
    let contextBlock = '';
    if (capBlock) {
        contextBlock += capBlock + '\n';
    }
    if (fileBlock) {
        // Only include file contents if we have room
        const remaining = MAX_TOTAL_CHARS - contextBlock.length;
        if (remaining > 1000) {
            contextBlock += fileBlock.substring(0, remaining);
        }
    }

    result.capabilities = capabilities;
    result.fileContents = discoveredFiles;
    result.contextBlock = contextBlock.trim();
    result.hasContext = true;

    getLogger().info(
        `Bootstrap: detected ${capabilities.length} capabilities, ` +
        `${discoveredFiles.size} files, ${contextBlock.length} chars context`
    );

    return result;
}

/**
 * Build a compact capability summary for subagent prompts.
 * This is shorter than the full bootstrap context — it just tells
 * the subagent what tools are available without file contents.
 */
export function buildCapabilitySummary(capabilities: EnvironmentCapability[]): string {
    if (capabilities.length === 0) {
        return '';
    }

    const lines: string[] = [
        '=== ENVIRONMENT TOOLS (USE THESE) ===',
        'These tools are installed and available. Use them — do NOT install alternatives.',
        '',
    ];

    for (const cap of capabilities) {
        lines.push(`**${cap.name}:** ${cap.description}`);
        lines.push(`  Commands: ${cap.commands.slice(0, 5).join(' | ')}`);
        lines.push('');
    }

    return lines.join('\n');
}
