# pi-config

Deterministic, git-managed configuration for the pi coding agent (the [pi-mono](https://github.com/earendil-works/pi-mono) monorepo). This repository declares the desired state of `~/.pi/agent/`; `npm run setup` reconciles that state idempotently. Pi loads this file automatically for sessions started in this repository or any subdirectory. Terminology follows `CONTEXT.md`.

## Rules

1. Never edit anything under `~/.pi/` to change pi configuration. Reconciliation fully replaces, clears, or symlinks every managed path under `~/.pi/agent/`, so direct edits are silently lost on the next `npm run setup`.
2. Make every change in this repository, in the repo-owned source file that controls it. If a pi setting is missing, add it to `settings.json` in this repo — not to `~/.pi/agent/settings.json`.
3. Never treat `~/.pi/agent/npm/` or `.pi/fabric/mcp-cache.json` as configuration. Packages are declared in `settings.json` (`npm:` package ids) and installed by Pi; the cache is regenerated.
4. Pi’s runtime-generated `deviceId` is installation identity, not configuration. Reconciliation preserves it from the installed settings; never commit it to this repo.
5. Treat every path this repository does not declare as user-owned. `bootstrap.mjs` reconciles only declared paths, so leftovers from removed packages, renamed configuration, or earlier bootstrap versions survive setup untouched; never add deletion logic to `bootstrap.mjs` for them. For a large configuration change, delete `~/.pi`, rerun `npm run setup`, and reload Pi.

## Repo-owned sources and their runtime targets

- `settings.json` → installed into `~/.pi/agent/settings.json`; replaces preferences but preserves the local runtime `deviceId`
- `fabric.json`, `APPEND_SYSTEM.md` → installed wholesale into `~/.pi/agent/`
- `mcp.json` → installed wholesale into `~/.mcporter/mcporter.json` for Pi Fabric, not Pi's native MCP extension
- `pi-better-openai.json` → installed wholesale into `~/.pi/agent/extensions/`
- `extensions/`, `themes/`, `prompts/`, `skills/`, `reminders/`, `keybindings.json` → symlinked into `~/.pi/agent/`
- `bootstrap.mjs` — the reconciler that performs those steps

Pi Fabric owns tool orchestration and MCP. `settings.json` disables Pi's built-in `mcp`, `codemode`, and `tool-search` extensions to keep `fabric_exec` as the exclusive tool path.

## Making a change

1. Edit the repo-owned source file for the change. Never edit `~/.pi/`.
2. Run `npm run setup` to reconcile `~/.pi/agent/`.
3. Run `npm test` and report the result. Stop with changes uncommitted unless the user explicitly authorizes a commit for those changes.
