# pi-config

Declares the desired state of `~/.pi/agent/` for the pi coding agent; `npm run setup` reconciles it idempotently. Pi loads this file for any session started in this repo.

## Commands

| Task | Command |
|------|---------|
| Install dependencies (first time) | `npm install` |
| Reconcile `~/.pi/agent/` | `npm run setup` |
| All tests | `npm test` |
| One test file | `npx vitest run tests/<name>.test.ts` |

## Rules

1. Never edit anything under `~/.pi/` to change pi configuration; edit the repo-owned source file that controls it. Reconciliation replaces, clears, or symlinks every managed path, so direct edits are silently lost.
2. Add a missing pi setting to `settings.json` in this repo, never to `~/.pi/agent/settings.json`.
3. Never treat `~/.pi/agent/npm/` as configuration. Packages are declared in `settings.json` (`npm:` package ids); keep sources unpinned — no npm versions, git tags, or commits.
4. `deviceId` is runtime installation identity, not configuration. Reconciliation preserves it; never commit it.
5. `bootstrap.mjs` reconciles only declared paths, so leftovers from removed packages, renamed config, or older bootstrap versions survive setup by design; never add deletion logic for undeclared paths. For a large change, delete `~/.pi`, rerun setup, and reload Pi.

## Sources and runtime targets

| Repo path | Installed as |
|-----------|--------------|
| `settings.json` | overlay at `~/.pi/agent/settings.json`, keeps the local `deviceId` |
| `APPEND_SYSTEM.md`, `pi-vcc-config.json`, `mcp.json`, `models.json` | overlay at `~/.pi/agent/` |
| `pi-better-openai.json`, `coralbricks.json` | overlay at `~/.pi/agent/extensions/` |
| `extensions/*.ts`, `prompts/`, `skills/`, `reminders/`, `keybindings.json` | symlinked into `~/.pi/agent/` |
| `bootstrap.mjs` | the reconciler that performs setup |

## Behavior that affects how you work

- `settings.json` sets `codemode.mode` to `only`; MCP servers are reachable only from codemode scripts.
- `extensions/codemode-output-cap.ts` caps the codemode return at 10,000 characters and leaves the full-text path in the omission hole.
- `coralbricks.json` sends `X-Coral-Pricing: cache-optimized` by default; the provider's runtime `ctrl+alt+c` toggle is overwritten on the next reconciliation.
- `opendesign` models (`models.json`) record the gateway's `context_budget` and `output_budget`, never a catalog's `context_limit` — see `docs/opendesign.md`.
- `npm:@monotykamary/pi-vcc` compacts the session once context use passes 90% of the model window (`pi-vcc-config.json`).

## External references

| Need | File |
|------|------|
| Prerequisites, setup details, extension behavior | `README.md` |
| Domain terminology | `CONTEXT.md` |
| `opendesign` model runbook | `docs/opendesign.md` |

## Making a change

1. Edit the repo-owned source file for the change.
2. Run `npm run setup` to reconcile `~/.pi/agent/`.
3. Run `npm test` and report the result. Stop with changes uncommitted unless the user explicitly authorizes a commit for those changes.
