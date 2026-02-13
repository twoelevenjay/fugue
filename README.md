# Ramble for GitHub Copilot

> Stop crafting perfect prompts. Just ramble — Ramble turns your stream-of-consciousness into structured, effective prompts for GitHub Copilot Chat.

## What it does

When you have a complex coding task but can't quite articulate it perfectly, just ramble at `@ramble`. It will:

1. **Analyze** your stream-of-consciousness request
2. **Extract** goals, constraints, context, and requirements
3. **Ask** targeted clarifying questions (only for genuinely missing info)
4. **Compile** everything into a structured, copy-ready prompt

## Requirements

- **VS Code** 1.108.1 or later
- **GitHub Copilot** extension installed and active

## Usage

1. Open GitHub Copilot Chat (`Cmd+Shift+I` / `Ctrl+Shift+I`)
2. Type `@ramble` followed by your request — don't worry about structure, just explain what you need
3. Answer any clarifying questions
4. Copy the compiled prompt and use it with Copilot or any AI assistant

### Example

**You type:**
```
@ramble okay so we have this API that's getting slow and I think it's the database 
queries, there's like 5 of them running sequentially when they could probably run 
in parallel, also the caching is broken I think, users are complaining about stale 
data, oh and we need to add rate limiting before we launch next week
```

**Ramble extracts:**
- Goal: Optimize API performance and add rate limiting before launch
- Current issues: Sequential DB queries, broken caching (stale data)
- Constraints: Launch deadline next week
- Success criteria: Parallel queries, working cache, rate limiting implemented

**Ramble asks** (only if needed):
- Which API endpoints are affected?
- What caching solution are you using?

**Ramble outputs:** A structured prompt ready for Copilot.

## Commands

| Command | Description |
|---------|-------------|
| `@ramble <your request>` | Start a new ramble session |
| `@ramble reset` | Clear session and start fresh |
| `@ramble refresh` | Reload workspace context |
| `Ramble: Copy Last Compiled Prompt` | Copy the last compiled prompt to clipboard |

## Workspace Context

Ramble automatically reads your workspace to understand your project:

- `.github/copilot-instructions.md` — Your project's Copilot instructions
- `CLAUDE.md` — Alternative instructions file
- `README.md` files — Project documentation
- Workspace structure — Folder and file layout

Use `@ramble refresh` to reload context after making changes to these files.

## How it works

Ramble uses GitHub Copilot's language model to intelligently analyze your request. Unlike rigid templates, it understands context and only asks questions when information is genuinely missing.

**What gets preserved:**
- All distinct facts, examples, and technical details
- Relationships between systems/components
- Analogies and concept explanations

**What gets cleaned up:**
- Filler words (um, uh, you know)
- Duplicate mentions of the same fact
- Scattered fragments get organized together

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)

