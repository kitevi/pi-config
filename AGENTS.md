# pi-config

Deterministic, git-managed configuration for the pi coding agent (the [pi-mono](https://github.com/earendil-works/pi-mono) monorepo). This repository declares the desired state of `~/.pi/agent/`; `npm run setup` reconciles that state idempotently. Pi loads this file automatically for sessions started in this repository or any subdirectory. Terminology follows `CONTEXT.md`.

## Rules

1. Never edit anything under `~/.pi/` to change pi configuration. Reconciliation fully replaces, clears, or symlinks every managed path under `~/.pi/agent/`, so direct edits are silently lost on the next `npm run setup`.
2. Make every change in this repository, in the repo-owned source file that controls it. If a pi setting is missing, add it to `settings.json` in this repo — not to `~/.pi/agent/settings.json`.
3. Never treat `~/.pi/agent/npm/` or `.pi/fabric/mcp-cache.json` as configuration. Packages are declared in `settings.json` (`npm:` package ids) and installed during reconciliation; the cache is regenerated.

## Repo-owned sources and their runtime targets

- `settings.json`, `fabric.json`, `mcp.json`, `APPEND_SYSTEM.md`, `opencode-go-provider.json` → installed wholesale into `~/.pi/agent/`
- `pi-better-openai.json` → installed wholesale into `~/.pi/agent/extensions/`
- `extensions/`, `themes/`, `prompts/`, `skills/`, `reminders/`, `keybindings.json` → symlinked into `~/.pi/agent/`
- `bootstrap.mjs` — the reconciler that performs those steps

## Making a change

1. Edit the repo-owned source file for the change. Never edit `~/.pi/`.
2. Run `npm run setup` to reconcile `~/.pi/agent/`.
3. Run `npm test`, then commit with a scoped commit message (`git log` shows examples).
