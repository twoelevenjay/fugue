# Contributing to Ramble

Thanks for your interest in contributing to Ramble for GitHub Copilot!

## Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/YOUR_USERNAME/ramble.git
   cd ramble
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run in development mode**
   - Press `F5` in VS Code to launch the Extension Development Host
   - Or run `npm run watch` to compile on changes

4. **Test the extension**
   - In the Extension Development Host, open Copilot Chat
   - Type `@ramble` followed by a test request

## Project Structure

```
ramble/
├── src/
│   ├── extension.ts      # Main extension code
│   └── test/
│       └── extension.test.ts
├── package.json          # Extension manifest
├── tsconfig.json         # TypeScript config
└── eslint.config.mjs     # Linting rules
```

## Code Style

- Run `npm run lint` before committing
- Use TypeScript strict mode
- Keep functions focused and well-named
- Add comments for non-obvious logic

## Pull Request Process

1. **Fork** the repository
2. **Create a branch** for your feature: `git checkout -b feature/my-feature`
3. **Make your changes** with clear, atomic commits
4. **Run tests**: `npm run pretest`
5. **Push** and open a Pull Request

### PR Guidelines

- Describe what your PR does and why
- Reference any related issues
- Keep PRs focused — one feature or fix per PR
- Update documentation if needed

## Reporting Issues

- Check existing issues first to avoid duplicates
- Use the issue templates when available
- Include VS Code and extension version
- Provide steps to reproduce

## Questions?

Open a [Discussion](https://github.com/YOUR_USERNAME/ramble/discussions) for questions or ideas.
