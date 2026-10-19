# pi-config

My personal pi agent config repo.
It keeps prompts/extensions/skills/reminders plus repo-managed pi config files (settings, keybindings, etc.) in version control and bootstraps them into `~/.pi/agent`.

## Prerequisites

- **Node.js** ≥ 22.19.0 — see [Installing Node.js](#installing-nodejs)
- **pi** — see [Installing pi](#installing-pi)


### Installing Node.js

**macOS** (Homebrew):
```bash
brew install node
```

Or install via [`mise`](https://mise.jdx.dev/) or [fnm](https://github.com/Schniz/fnm#installation) if you want a version manager for Node.

**Linux** — install via your package manager (`apt`, `dnf`, etc.), [`mise`](https://mise.jdx.dev/), or [fnm](https://github.com/Schniz/fnm#installation).

Verify:
```bash
node --version   # should be ≥ 22.19.0
```

### Installing pi

Install pi globally with npm:
```bash
npm install -g @earendil-works/pi-coding-agent
```

Verify:
```bash
pi --version
```

## Setup
From this repo root:
```bash
npm install
npm run setup
```

`npm install` provides the pinned dependencies used by the extensions and their tests. The reconciliation script itself still uses only Node.js built-ins.

## Footer veil

`extensions/footer-veil.ts` starts each session with model information and provider usage
veiled. Press `Ctrl+P` to show or hide them; context statistics are never veiled. Provider usage covers both the
footer status slots and the below-editor widget lines used by hypercharm
and Better OpenAI (in its `status` footer mode). No per-provider
commands are used; the veil filters at render time, so provider updates stay
hidden until you reveal them with `Ctrl+P`. Reloads and new/resumed/forked sessions restore the
initially veiled state.

## Skill index

`extensions/skill-guide.ts` renders every loaded skill command with a short summary in a TUI-only widget when a session starts. The widget is not added to the conversation or sent to the model provider. It hides whenever you submit a prompt; use `/skill-guide` to reopen it until your next prompt.

Configure it in `extensions/skill-guide.ts` (`DEFAULT_SKILL_GUIDE_CONFIG`, then `/reload`):

- `title` — widget heading text (`"Skill index"` by default).
- `showOnStartup` — whether the index is shown when a session starts.
- `hideOnPrompt` — whether the index hides whenever an interactive prompt is submitted.
- `placement` — `aboveEditor` or `belowEditor`.
- `maxSummaryLength` — maximum summary length before shortening (30 characters by default).
- `summaryOverrides` — replacements for unclear upstream descriptions, keyed by skill name.
- `hiddenSkills` — skills hidden by exact name or `"prefix*"` glob (`[]` by default).
- `pinnedSkills` — skills always shown, even under a glob (`[]` by default).

## Desktop notifications

`git:github.com/kitevi/pi-nudge` sends a native desktop notification when Pi's terminal surface is unfocused at the final `agent_settled` lifecycle event (`Pi is waiting for you`). The waiting notification is debounced by 10s: if a new agent run starts within the window (auto-retry, compaction retry, queued follow-up), the settle was transient, so nothing is sent. Unknown focus is treated conservatively as focused, so unsupported or headless sessions stay silent.

Focus detection uses CSI mode 1004 reports where the terminal supports them, with X11's active window or the frontmost macOS application as best-effort fallbacks. Delivery is delegated to node-notifier — Notification Center on macOS, toasts on Windows, `notify-send` on Linux — so no terminal-emulator notification protocol is required.


## Codemode

`settings.json` sets `codemode.mode` to `only` and enables `codemode`, `grep`, `find`, and `ls` beside the default `read`, `bash`, `edit`, and `write` tools. The model reaches those tools through one codemode script. Pi's `tool-search` extension stays disabled. MCP servers in `mcp.json` are hidden except the Context7, TinyFish, and Exa tools scripts call. `extensions/codemode-output-cap.ts` keeps the model-facing codemode return to 10,000 characters: a longer return is written once to a private temp file, or Pi's existing spill is reused, and the visible text keeps the start and the end with that path in the omission hole, inside the budget. `npm:@monotykamary/pi-vcc` replaces Pi's summarizer: `pi-vcc-config.json` compacts when context use passes 90% of the model context window.


## What `npm run setup` does

`npm run setup` runs `bootstrap.mjs`, which:

1. **Clears** each repo-managed path under `~/.pi/agent/` (prompts, skills, reminders, APPEND_SYSTEM.md, keybindings.json) before re-creating it — stale symlinks and files are cleaned out first.

2. **Symlinks** directories and files into `~/.pi/agent`:
   - `prompts/`
   - `skills/`
   - `reminders/`
   - `keybindings.json`

3. **Installs** the repository-owned `APPEND_SYSTEM.md` as `~/.pi/agent/APPEND_SYSTEM.md`.

4. **Symlinks** the repo's extension files into `~/.pi/agent/extensions/`, and prunes repo-owned symlinks whose source file left the repository. Regular files this repo does not declare — such as the model-order state `pi-model-sort` writes — are left in place.

5. **Installs** JSON config files (full replacement — the repo file becomes the target file, written atomically). If a source file is later removed from the repo, re-running setup copies the target to `<target>.bak` and then removes it:
   - `settings.json` → `~/.pi/agent/settings.json`
   - `pi-better-openai.json` → `~/.pi/agent/extensions/pi-better-openai.json`
   - `coralbricks.json` → `~/.pi/agent/extensions/coralbricks.json`
   - `mcp.json` → `~/.pi/agent/mcp.json`
   - `models.json` → `~/.pi/agent/models.json`
   - `pi-vcc-config.json` → `~/.pi/agent/pi-vcc-config.json`

Paths this repository does not declare are never touched, except repo-owned symlinks inside `~/.pi/agent/extensions/`, which are pruned when their source file leaves the repository. Leftovers from removed packages, renamed configuration, or earlier bootstrap versions otherwise stay on disk after setup. Delete `~/.pi`, rerun setup, and reload Pi for a large configuration change (`AGENTS.md` rule 5).

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `AGENTS.md` — agent-facing rules for this repository, loaded automatically by pi sessions started in this repository
- `prompts/` — prompt files
- `extensions/` — pi extensions
  - `extensions/skill-guide.ts` — TUI skill-index widget, toggled with `/skill-guide` (settings live in `DEFAULT_SKILL_GUIDE_CONFIG` at the top of the file)
  - `extensions/footer-veil.ts` — `Ctrl+P` footer veil for model info and provider usage widgets
  - `extensions/git-editor-guard.ts` — stops git from spawning an interactive editor inside agent `bash` calls
  - `extensions/codemode-output-cap.ts` — caps the model-facing codemode return at 10,000 characters and spills the complete return to one temp file, with the path in the omission hole
  - `extensions/max-reasoning.ts` — raises the thinking level to any reasoning model’s highest supported level on model select/start (the runtime clamps “max” to the model’s top; `EXCLUDED_FAMILIES` opts models out)
- `skills/` — pi skills
- `reminders/` — global reminder definitions for `pi-system-reminders`; `hbm-companion.ts` points to the companion `.hbm.xml` mapping when a Hibernate-mapped Java entity is read
- `APPEND_SYSTEM.md` — repository-owned system prompt overlay rules installed into `~/.pi/agent/` during reconciliation
- `settings.json` — repo-managed pi settings, including installed packages/extensions
- `keybindings.json` — repo-managed keybinding overrides; unbinds the built-in commands that use `Ctrl+P` so `footer-veil` can own `Ctrl+P`
- `mcp.json` — Pi MCP server configuration installed into `~/.pi/agent/mcp.json` (see [Codemode](#codemode))
- `coralbricks.json` — `pi-coralbricks-provider` settings installed into `~/.pi/agent/extensions/coralbricks.json`; turns cache-optimized pricing (`X-Coral-Pricing: cache-optimized`) on by default, so `ctrl+alt+c` toggles are reset by the next `npm run setup`
- `models.json` — Open Design (`amr-link`) provider: Chat Completions against `https://amr-link.open-design.ai/v1`, keyed by `$OPEN_DESIGN_API_KEY`, exposing the DeepSeek V4.1 Flash 1017 checkpoint as `deepseek-v4.1-flash`
- `pi-vcc-config.json` — pi-vcc compaction settings installed into `~/.pi/agent/pi-vcc-config.json`; compacts after 90% of the context window
- `tests/` — Vitest suites for extensions and reconciliation behavior, run with `npm test`

The bootstrap script is plain Node.js; the pi extensions in `extensions/` are TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine. Reconciliation is offline — no network access is required.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

All JSON config files (`settings.json`, `pi-better-openai.json`, `coralbricks.json`, `mcp.json`, `models.json`, and `pi-vcc-config.json`) are **fully replaced** on every `npm run setup` — the repo file is written wholesale over the target. Any local pi settings not tracked in this repo will be overwritten.

If a JSON source file is removed from the repo, re-running setup backs the target up to `<target>.bak` and deletes it. `*.bak` files are gitignored.