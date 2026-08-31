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

The theme follows your terminal appearance: pi switches between the
`github-colorblind-light` and `github-colorblind-dark` variants automatically.

`npm install` provides the pinned dependencies used by the extensions and their tests. The reconciliation script itself still uses only Node.js built-ins.

## Skill index

`extensions/skill-guide.ts` renders every loaded skill command and a short summary in a TUI-only widget when a session starts. The widget is not added to the conversation or sent to the model provider. It hides whenever you submit a prompt; use `/skill-guide` to reopen it until your next prompt.

Configure it in `extensions/skill-guide.json`:

- `title` — widget heading text (`"Skill index"` by default).
- `showOnStartup` — show the index when a session starts.
- `hideOnPrompt` — hide the index whenever an interactive prompt is submitted.
- `placement` — `aboveEditor` or `belowEditor`.
- `maxSummaryLength` — maximum summary length before shortening (30 characters by default).
- `summaryOverrides` — replace unclear upstream descriptions by skill name.

## Permission gate

`extensions/permission-gate.ts` is a rule-based guard over agent-issued `bash`/`nu` tool calls. It is behavior shaping, not a sandbox: ordinary work — including reads and writes outside the workspace and `/tmp`, tests, builds, and plain network fetches — runs unhindered, while higher-stakes calls are **blocked** outright or raised as an **ask** you confirm.

**Blocked** (never run): credential and private-material reads or writes (SSH keys, GPG, `.pem`/`.key`/`.p12`/`.pfx`, AWS/gcloud/Azure/Docker auth — `.env`, `.envrc`, `.npmrc`, `.netrc` are intentionally allowed); catastrophic disk/system commands (`mkfs`, `dd` to `/dev/*`, `sudo rm`, `chmod -R 777 /`, `curl … | sudo sh`); writes to `/dev`, `/proc`, `/sys`; git with `--no-verify`; and agent-launched nested Pi agents (below).

**Asked** (confirmed before running): file deletion; shell-side file mutation (`chmod`, `chown`, `tee`, `truncate`, `dd`, in-place `sed`/`perl`, nushell `save`); inline interpreter code that writes files, spawns processes, or sends data; running a script created this session; `sudo`/elevated commands; destructive git (`reset --hard`, `clean -f`, `checkout -- .`, `restore .`, force push); commits; mutating package-manager commands; and outbound network upload, push, or remote execution (`git push`, `ssh`, `scp`, `rsync`, `nc`, `socat`, mutating or authenticated `curl`/`wget`, `curl | sh`). Plain download-to-file is not asked.

An **ask** you decline or dismiss blocks the call and aborts the turn, so the model cannot immediately retry another form; an ask that times out (you stepped away) also blocks the call and aborts the turn — unattended work stops there — but the model gets timeout wording rather than decline wording. Stepping away mid-ask therefore stops the run. In every blocked case the matching rule is quoted back to the model both as the tool result and again on the next turn.

### Nested Pi subprocess guard

As one block rule, the gate declines agent `bash`/`nu` calls that start another Pi agent, preventing a skill from simulating an unavailable subagent with commands such as `pi --no-session -p @prompt.md`. It does **not** affect Pi started directly in a terminal or via Pi’s `!` user-shell prefix. Non-agent Pi operations — help/version, `--list-models`, `--export`, management commands (`config`, `install`, `list`, `remove`, `uninstall`, `update`), and promptless startup — remain available to the agent.

For deliberate nested-agent troubleshooting, opt in on the **parent** process:

```bash
PI_PERMISSION_GATE_ALLOW_NESTED_PI=1 pi
```

Setting that variable inside an agent’s child command does not bypass the gate.

## Desktop notifications

`extensions/desktop-notifications.ts` requests terminal focus reporting and sends an attention notification only when Pi's terminal surface is known to be unfocused. It handles permission-gate asks (`Pi needs permission`) and the final `agent_settled` lifecycle event (`Pi is waiting for you`). Unknown focus is treated conservatively as focused, so unsupported or headless sessions stay silent.

Ghostty is the primary path on both Linux and macOS: CSI mode 1004 reports exact surface focus, and OSC 777 raises the native desktop notification. The extension also supports Kitty's OSC 99 protocol. When no native notification protocol is recognized, it falls back to `notify-send` on Linux or `osascript` on macOS. If no terminal focus report has arrived, focus detection falls back to X11's active window when `DISPLAY` and `WINDOWID` are available, or the frontmost terminal application on macOS. Terminal reports take precedence over these best-effort fallbacks.


## What setup does

`npm run setup` runs `bootstrap.mjs`, which:

1. **Clears** all repo-managed paths under `~/.pi/agent/` (prompts, skills, reminders, APPEND_SYSTEM.md, models.json, keybindings.json, extensions/, themes/) — stale symlinks and files are cleaned out before re-creation.

2. **Symlinks** directories and files into `~/.pi/agent`:
   - `prompts/`
   - `skills/`
   - `reminders/`
   - `models.json`
   - `keybindings.json`

3. **Installs** the repository-owned `APPEND_SYSTEM.md` as `~/.pi/agent/APPEND_SYSTEM.md`.

4. **Symlinks** extension and theme directories from the repo into `~/.pi/agent`:
   - `extensions/` → `~/.pi/agent/extensions/`
   - `themes/` → `~/.pi/agent/themes/`

5. **Installs** JSON config files (full replacement — the repo file becomes the target file). If a source file is later removed from the repo, re-running setup removes the corresponding target:
   - `settings.json` → `~/.pi/agent/settings.json`
   - `synthetic.json` → `~/.pi/agent/extensions/synthetic.json`
   - `neuralwatt.json` → `~/.pi/agent/extensions/neuralwatt.json`
   - `pi-vcc-config.json` → `~/.pi/agent/pi-vcc-config.json`
   - `web-tools.json` → `~/.pi/web-tools.json`
   - `mcp.json` → `~/.pi/agent/mcp.json` (the Pi global MCP override — declared MCP servers are available from any working directory)

6. **Links both theme variants** — `github-colorblind-light.json` and `github-colorblind-dark.json` are linked into `~/.pi/agent/themes/`; pi follows the terminal's light/dark appearance automatically.

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
  - `extensions/skill-guide.ts` — TUI skill-index widget, toggled with `/skill-guide`
  - `extensions/skill-guide.json` — startup skill-index display settings and summary overrides
  - `extensions/permission-gate.ts` — stable entry point for the rule-based `bash`/`nu` permission gate (see [Permission gate](#permission-gate))
  - `extensions/permission-gate/` — shell analysis, policy, state, presentation, and runtime modules behind the gate
  - `extensions/model-info-toggle.ts` — `Ctrl+P` footer toggle for model info, plus GPT verbosity and context "dumb zone" hints
  - `extensions/git-editor-guard.ts` — stops git from spawning an interactive editor inside agent `bash` calls
  - `extensions/bash-context-guard.ts` — replaces oversized `bash` results with a small head/tail preview linked to the complete output
  - `extensions/readseek-output-guard.ts` — caps oversized ReadSeek reference and search results while preserving access to full output
  - `extensions/max-reasoning.ts` — raises the thinking level to any reasoning model’s highest supported level on model select/start (the runtime clamps “max” to the model’s top; `EXCLUDED_FAMILIES` opts models out)
  - `extensions/codex-usage.ts` — shows Codex 5h/7d rolling usage and reset times in the footer while a Codex model is active
  - `extensions/opencode-go-usage.ts` — shows OpenCode Go 5h/weekly/monthly used quotas and reset times in the footer while an OpenCode Go model is active
- `skills/` — pi skills
- `themes/` — pi themes (`github-colorblind` light/dark variants)
- `reminders/` — global reminder definitions for `pi-system-reminders`
- `APPEND_SYSTEM.md` — repository-owned system prompt overlay rules installed into `~/.pi/agent/` during reconciliation
- `settings.json` — repo-managed pi settings, including installed packages/extensions
- `models.json` — custom provider/model definitions symlinked into pi (for example OpenRouter via `OPENROUTER_API_KEY`)
- `keybindings.json` — repo-managed keybinding overrides; unbinds built-in `Ctrl+P` users so `model-info-toggle` can own it
- `synthetic.json` — pi-synthetic configuration installed into `~/.pi/agent/extensions/synthetic.json`
- `neuralwatt.json` — Neuralwatt provider configuration installed into `~/.pi/agent/extensions/neuralwatt.json`
- `pi-vcc-config.json` — pi-vcc compaction configuration installed into `~/.pi/agent/pi-vcc-config.json`
- `web-tools.json` — pi-web-tools configuration installed into `~/.pi/web-tools.json`
- `mcp.json` — MCP server config (Exa, synthetic-web-search, context7) installed into `~/.pi/agent/mcp.json`, the Pi global override; servers load from any working directory, not just this repo
- `tests/` — Vitest suites for extensions and reconciliation behavior, run with `npm test`

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine. Reconciliation is offline — no network access is required.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

All JSON config files (`settings.json`, `synthetic.json`, `neuralwatt.json`, `pi-vcc-config.json`, `mcp.json`, and `web-tools.json`) are **fully replaced** on every `npm run setup` — the repo file is written wholesale over the target. Any local pi settings not tracked in this repo will be overwritten.

If a JSON source file is removed from the repo, re-running setup deletes the corresponding target file.