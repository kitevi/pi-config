# pi-config

My personal pi agent config repo.
It keeps prompts/extensions/skills/themes/reminders plus repo-managed pi config files (settings, keybindings, etc.) in version control and bootstraps them into `~/.pi/agent`.

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

The theme follows your terminal appearance: pi switches between the
`github-colorblind-light` and `github-colorblind-dark` variants automatically.

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
- `hiddenSkills` — skills hidden by exact name or `"prefix*"` glob (`["fabric-*"]` by default).
- `pinnedSkills` — skills always shown, even under a glob (`[]` by default, so `fabric-*` stays fully hidden).

## Desktop notifications

`extensions/desktop-notifications.ts` requests terminal focus reporting and sends an attention notification only when Pi's terminal surface is known to be unfocused. It notifies for the final `agent_settled` lifecycle event (`Pi is waiting for you`). The waiting notification is debounced by ~10s: if a new agent run starts within the window (auto-retry, compaction retry, queued follow-up), the settle was transient, so nothing is sent. Unknown focus is treated conservatively as focused, so unsupported or headless sessions stay silent.

Ghostty is the primary path on both Linux and macOS: CSI mode 1004 reports exact surface focus, and OSC 777 raises the native desktop notification. The extension also supports Kitty's OSC 99 protocol. When no native notification protocol is recognized, it falls back to `notify-send` on Linux or `osascript` on macOS. If no terminal focus report has arrived, focus detection falls back to X11's active window when `DISPLAY` and `WINDOWID` are available, or the frontmost terminal application on macOS. Terminal reports take precedence over these best-effort fallbacks.


## Pi Fabric

The `npm:pi-fabric` package is installed with its `fabric-exec` skill and runs in full code mode (`fabric.json`): the model writes one awaited code block against the `pi.*`/`tools.*` APIs instead of chaining many small tool calls. Subagents are disabled (`approvals.agent: "deny"`, `agents.enabled: false`); mesh, memory, and the Fabric UI widget are off. MCP is enabled through `mcp.json`, with allowlisted Exa web-search/fetch, TinyFish search/fetch, and Context7 documentation tools. Oversized results are spilled to disk artifacts once output passes `executor.maxOutputChars` (8,192 chars), keeping context lean; `maxNestedResultChars` stays at 2M since nested results never reach the model.


## What `npm run setup` does

`npm run setup` runs `bootstrap.mjs`, which:

1. **Clears** all repo-managed paths under `~/.pi/agent/` (prompts, skills, reminders, APPEND_SYSTEM.md, keybindings.json, extensions/, themes/) — stale symlinks and files are cleaned out before re-creation.

2. **Symlinks** directories and files into `~/.pi/agent`:
   - `prompts/`
   - `skills/`
   - `reminders/`
   - `keybindings.json`

3. **Installs** the repository-owned `APPEND_SYSTEM.md` as `~/.pi/agent/APPEND_SYSTEM.md`.

4. **Symlinks** extension and theme directories from the repo into `~/.pi/agent`:
   - `extensions/` → `~/.pi/agent/extensions/`
   - `themes/` → `~/.pi/agent/themes/`

5. **Installs** JSON config files (full replacement — the repo file becomes the target file). If a source file is later removed from the repo, re-running setup removes the corresponding target:
   - `settings.json` → `~/.pi/agent/settings.json`
   - `pi-better-openai.json` → `~/.pi/agent/extensions/pi-better-openai.json`
   - `fabric.json` → `~/.pi/agent/fabric.json`
   - `mcp.json` → `~/.pi/agent/mcp.json`

6. **Links both theme variants** — `github-colorblind-light.json` and `github-colorblind-dark.json` are linked into `~/.pi/agent/themes/`; pi follows the terminal's light/dark appearance automatically.

Paths this repository does not declare are never touched, so leftovers from removed packages, renamed configuration, or earlier bootstrap versions stay on disk after setup. Delete `~/.pi`, rerun setup, and reload Pi for a large configuration change (`AGENTS.md` rule 5).

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `AGENTS.md` — agent-facing rules for this repository, loaded automatically by pi sessions started in this repository
- `prompts/` — prompt files
- `extensions/` — pi extensions
  - `extensions/skill-guide.ts` — TUI skill-index widget, toggled with `/skill-guide` (settings live in `DEFAULT_SKILL_GUIDE_CONFIG` at the top of the file)
  - `extensions/footer-veil.ts` — `Ctrl+P` footer veil for model info and provider usage widgets
  - `extensions/git-editor-guard.ts` — stops git from spawning an interactive editor inside agent `bash` calls
  - `extensions/max-reasoning.ts` — raises the thinking level to any reasoning model’s highest supported level on model select/start (the runtime clamps “max” to the model’s top; `EXCLUDED_FAMILIES` opts models out)
- `skills/` — pi skills
- `themes/` — pi themes (`github-colorblind` light/dark variants)
- `reminders/` — global reminder definitions for `pi-system-reminders`
- `APPEND_SYSTEM.md` — repository-owned system prompt overlay rules installed into `~/.pi/agent/` during reconciliation
- `settings.json` — repo-managed pi settings, including installed packages/extensions
- `keybindings.json` — repo-managed keybinding overrides; unbinds the built-in commands that use `Ctrl+P` so `footer-veil` can own `Ctrl+P`
- `fabric.json` — Pi Fabric configuration installed into `~/.pi/agent/fabric.json` (see [Pi Fabric](#pi-fabric))
- `mcp.json` — Pi Fabric MCP server configuration installed into `~/.pi/agent/mcp.json`
- `tests/` — Vitest suites for extensions and reconciliation behavior, run with `npm test`

The bootstrap script is plain Node.js; the pi extensions in `extensions/` are TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine. Reconciliation is offline — no network access is required.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

All JSON config files (`settings.json`, `pi-better-openai.json`, `fabric.json`, and `mcp.json`) are **fully replaced** on every `npm run setup` — the repo file is written wholesale over the target. Any local pi settings not tracked in this repo will be overwritten.

If a JSON source file is removed from the repo, re-running setup deletes the corresponding target file.