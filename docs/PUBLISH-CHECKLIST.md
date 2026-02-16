# Publish Checklist

Pre-publish checklist for releasing Fugue to the VS Code Marketplace and Open VSX.

## Pre-Release Validation

### Code Quality
- [ ] `npm run lint` — zero errors
- [ ] `npm run format:check` — zero formatting issues
- [ ] `npm run typecheck` — zero type errors
- [ ] `npm test` — all tests pass
- [ ] `npm audit --omit=dev` — zero production vulnerabilities

### Packaging
- [ ] `npm run package` — VSIX builds successfully
- [ ] VSIX size < 500 KB (currently ~234 KB)
- [ ] `npm run package:check` — no unexpected files included
- [ ] No `.vscode-test/`, `src/`, `node_modules/`, or `*.ts` in VSIX
- [ ] No `*.vsix` files committed to git

### Documentation
- [ ] README.md — accurate, no placeholder URLs
- [ ] CHANGELOG.md — updated for this version
- [ ] SECURITY.md — present with reporting instructions
- [ ] CONTRIBUTING.md — accurate setup instructions
- [ ] LICENSE — present (MIT)

### Security
- [ ] `npm audit` findings documented or resolved
- [ ] No `eval`, `new Function`, or `exec` in codebase
- [ ] All `fs.rm()` calls guarded by `assertSafePath()`
- [ ] Workspace trust check active
- [ ] No secrets, tokens, or API keys in repo
- [ ] `.env` and key/cert files in `.gitignore`

### Manifest (package.json)
- [ ] `name` — correct (`fugue`)
- [ ] `displayName` — accurate
- [ ] `description` — clear and concise
- [ ] `version` — updated (semver)
- [ ] `publisher` — set to your Marketplace publisher ID
- [ ] `engines.vscode` — set to minimum supported version
- [ ] `repository.url` — valid GitHub URL
- [ ] `bugs.url` — valid issues URL
- [ ] `license` — `MIT`
- [ ] `categories` — relevant VS Code categories
- [ ] `icon` — 128x128+ PNG (if publishing with icon)

## VS Code Marketplace

### First-Time Setup
1. Create a publisher at https://marketplace.visualstudio.com/manage
2. Generate a Personal Access Token (PAT) with `Marketplace > Manage` scope
3. Login: `npx vsce login <publisher-id>`

### Publish
```bash
# Dry run — verify everything looks right
npx vsce package --no-dependencies

# Publish
npx vsce publish --no-dependencies
```

### Post-Publish
- [ ] Extension visible on Marketplace
- [ ] Install from Marketplace works
- [ ] `@ramble` and `@johann` register in Copilot Chat
- [ ] Basic smoke test passes

## Open VSX (Optional)

### First-Time Setup
1. Create account at https://open-vsx.org
2. Generate access token

### Publish
```bash
npx ovsx publish fugue-<version>.vsix -p <access-token>
```

## Version Bumping

```bash
# Patch (0.0.1 → 0.0.2)
npm version patch

# Minor (0.0.x → 0.1.0)
npm version minor

# Major (0.x.x → 1.0.0)
npm version major

# Then rebuild and publish
npm run package
npx vsce publish --no-dependencies
```
