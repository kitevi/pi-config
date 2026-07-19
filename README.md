# pi-config

My personal pi agent config repo.
It keeps prompts/extensions/skills/themes/reminders plus repo-managed pi config files (settings, models, keybindings, Synthetic, Neuralwatt, etc.) in version control and bootstraps them into `~/.pi/agent`.

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

Theme defaults to light. You can also choose explicitly:

```bash
npm run setup-light
npm run setup-dark
```

`npm install` provides the pinned dependencies used by the extensions and their tests. The reconciliation script itself still uses only Node.js built-ins.

## Skill index

`extensions/skill-guide.ts` renders every loaded skill command and a short summary in a TUI-only widget when a session starts. The widget is not added to the conversation or sent to the model provider. It hides whenever you submit a prompt; use `/skill-guide` to reopen it until your next prompt.

Configure it in `extensions/skill-guide.json`:

- `showOnStartup` — show the index when a session starts.
- `hideOnPrompt` — hide the index whenever an interactive prompt is submitted.
- `placement` — `aboveEditor` or `belowEditor`.
- `maxSummaryLength` — maximum summary length before shortening (30 characters by default).
- `summaryOverrides` — replace unclear upstream descriptions by skill name.

## Agent loop explainer

`extensions/zz-export-agent/` registers `/export-agent [name]`. It writes a standalone, dependency-free HTML report to the system temporary directory (`/tmp` on Linux) and keeps the file private with mode `0600`.

```text
/export-agent
/export-agent work-agent-demo
```

The report is a big-picture explanation of how Pi wraps repeated model calls. It distinguishes Pi’s local session from the provider API and model; shows what enters every request; explains uncached input, cache reads, cache writes, and output; and shows why a model-emitted tool call makes Pi execute locally and issue another request automatically.

Run the command after Pi settles to include the latest provider request, each completed model call in the latest agent run, measured cache/output usage, model output, and tool results. Run it before a prompt for a configuration-only preflight report. The observer retains only the latest run rather than exporting the full session transcript.

The `zz-` directory prefix makes this observer load late among repo-managed extensions, improving its view of the provider request body. HTTP authorization headers are deliberately omitted. Reports contain sensitive prompt, message, project, output, and tool-result content, so review them before sharing.

## Fabric code-mode context guard

`extensions/fabric-code-mode-context-guard.ts` guards only the model-facing `fabric_exec` result. Nested `pi.bash`, `pi.grep`, and other lifecycle results are deliberately left intact for sandbox processing, subject to Pi and Fabric's native execution limits. This avoids producing a final preview of ten already-truncated previews.

Oversized text is saved completely to a unique mode-`0600` OS-temp file before Pi receives a bounded head/tail preview. Images and other non-text blocks are preserved separately and remain outside the text budget. Limits live in `fabric-code-mode-context-guard.json`, symlinked to `~/.pi/agent/fabric-code-mode-context-guard.json` by reconciliation.

## Nested Pi subprocess guard

`extensions/permission-gate.ts` declines agent-issued `bash`/`nu` tool calls that start another Pi agent. This prevents a skill from simulating an unavailable subagent with commands such as `pi --no-session -p @prompt.md`.

The guard does **not** affect Pi started directly in a terminal or commands you run through Pi's `!` user-shell prefix. Non-agent operations—including diagnostics, package/config commands, export, RPC mode, and promptless startup—remain available to the agent.

For deliberate nested-agent troubleshooting, opt in on the **parent** process:

```bash
PI_PERMISSION_GATE_ALLOW_NESTED_PI=1 pi
```

Putting that variable inside an agent's child command does not bypass the gate.

## What setup does

`npm run setup` runs `bootstrap.mjs`, which:

1. **Clears** all repo-managed paths under `~/.pi/agent/` (prompts, skills, reminders, APPEND_SYSTEM.md, models.json, keybindings.json, fabric-code-mode-context-guard.json, extensions/, themes/) — stale symlinks and files are cleaned out before re-creation.

2. **Symlinks** directories and files into `~/.pi/agent`:
   - `prompts/`
   - `skills/`
   - `reminders/`
   - `APPEND_SYSTEM.md`
   - `models.json`
   - `keybindings.json`
   - `fabric-code-mode-context-guard.json`

3. **Symlinks** extension and theme directories from the repo into `~/.pi/agent`:
   - `extensions/` → `~/.pi/agent/extensions/`
   - `themes/` → `~/.pi/agent/themes/`

4. **Installs** JSON config files (full replacement — the repo file becomes the target file). If a source file is later removed from the repo, re-running setup removes the corresponding target:
   - `settings.json` → `~/.pi/agent/settings.json`
   - `synthetic.json` → `~/.pi/agent/extensions/synthetic.json`
   - `neuralwatt.json` → `~/.pi/agent/extensions/neuralwatt.json`
   - `pi-vcc-config.json` → `~/.pi/agent/pi-vcc-config.json`
   - `web-tools.json` → `~/.pi/web-tools.json`
   - `fabric.json` → `~/.pi/agent/fabric.json`
   - selected `code-previews-{light,dark}.json` → `~/.pi/agent/code-previews.json`

5. **Switches the active theme** — symlinks the `github-colorblind.json` theme to the light or dark variant (defaults to light unless `--dark` or `--light` is passed to the script).

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
  - `extensions/fabric-code-mode-context-guard.ts` — recoverable guard for model-facing Fabric code-mode output
  - `extensions/skill-guide.json` — startup skill-index display settings and summary overrides
  - `extensions/zz-export-agent/` — standalone `/export-agent` request, cache, and tool-loop explainer
- `skills/` — pi skills
- `themes/` — pi themes
- `reminders/` — global reminder definitions for `pi-system-reminders`
- `APPEND_SYSTEM.md` — extra system prompt text appended into pi
- `settings.json` — repo-managed pi settings, including installed packages/extensions
- `models.json` — custom provider/model definitions symlinked into pi (for example OpenRouter via `OPENROUTER_API_KEY`)
- `keybindings.json` — repo-managed keybinding overrides; unbinds built-in `Ctrl+P` users so `model-info-toggle` can own it
- `fabric-code-mode-context-guard.json` — line/UTF-8-byte limits for model-facing `fabric_exec` output

- `synthetic.json` — pi-synthetic configuration installed into `~/.pi/agent/extensions/synthetic.json`
- `neuralwatt.json` — Neuralwatt provider configuration installed into `~/.pi/agent/extensions/neuralwatt.json`
- `pi-vcc-config.json` — pi-vcc extension configuration installed into `~/.pi/agent/pi-vcc-config.json`
- `web-tools.json` — web-tools configuration installed into `~/.pi/web-tools.json`
- `fabric.json` — minimal full-code Pi Fabric profile installed into `~/.pi/agent/fabric.json`
- `code-previews-light.json` / `code-previews-dark.json` — matching Shiki theme selected by `setup-light` / `setup-dark` and installed into `~/.pi/agent/code-previews.json`

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

All JSON config files (`settings.json`, `synthetic.json`, `neuralwatt.json`, `pi-vcc-config.json`, `web-tools.json`, `fabric.json`, and the selected `code-previews-{light,dark}.json`) are **fully replaced** on every `npm run setup` — the repo file is written wholesale over the target. Any local pi settings not tracked in this repo will be overwritten.

If a JSON source file is removed from the repo, re-running setup deletes the corresponding target file.