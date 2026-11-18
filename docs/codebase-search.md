# Codebase search (`skills/codebase-search`)

The `codebase-search` skill gives every Pi session a structural index of the
repository it works in: definitions, callers, callees, file outlines,
architecture, and change impact, answered by
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) (cbm).
This page is the spec; `skills/codebase-search/SKILL.md` is what the model
reads.

Facts about cbm below were checked against codebase-memory-mcp 0.12.1 on
2026-11-18.

## Files

| Path | Role |
|---|---|
| `skills/codebase-search/SKILL.md` | What the model reads: when to defer to the repository, workflow rules, commands |
| `skills/codebase-search/scripts/cbm` | POSIX sh wrapper that installs, updates, and runs cbm |
| `APPEND_SYSTEM.md`, section "Code search" | Precedence for every session |
| `extensions/skill-guide.ts` | One-line summary in the skill index |
| `tests/codebase-search.test.ts` | Wrapper tests |

## Requirements

| Requirement | How it is met |
|---|---|
| Works in any repository, with no per-repository setup and nothing written into the repository or the working directory | cbm keeps indexes in its own cache and names each project after its root path; the wrapper refuses index calls that would write into the repository ([below](#nothing-written-into-the-repository)) |
| Installs cbm on first use and keeps it current without help | `scripts/cbm` |
| Linux, macOS, and Windows (Git Bash), on x86-64 and ARM64 | [Platforms](#platforms) |
| A repository's own code-search tool takes precedence | `APPEND_SYSTEM.md` "Code search", skill rule 1 |
| The model uses it without being asked | No `disable-model-invocation`; the description names the questions it answers; `APPEND_SYSTEM.md` routes to it |
| Plain POSIX sh | ShellCheck as `sh` in the tests |
| Reconciliation stays offline | The download happens on first use, never in `bootstrap.mjs` |

## Routing

1. **Repository tool.** When the repository's AGENTS.md, CLAUDE.md, or the docs
   they point to name a code-search tool, the model uses it as described. Such a
   tool can pin the project name, the index location, and the version that the
   repository's instructions rely on; the skill there would build a second index
   under a name those instructions never use.
2. **This skill** everywhere else.
3. **grep and find** for literal text, configuration, logs, files the index
   skips, and whenever the wrapper fails.

`APPEND_SYSTEM.md` states this order for every session; rule 1 of `SKILL.md`
repeats the first step for a model that loads the skill directly.

## Wrapper contract

- `cbm ARGS...` behaves as `codebase-memory-mcp ARGS...` once the binary is in
  place: the wrapper execs it, so stdout, stderr, exit status, and signals are
  the binary's own.
- The wrapper's own messages go to stderr, prefixed `cbm:`. It exits 1 when it
  cannot provide a binary and 2 on invalid input.
- It refuses `install`, `uninstall`, and `update` with exit 2. `install`
  writes MCP configuration for every client it detects, Pi's `mcp.json` among
  them, which reconciliation owns; `update` replaces the binary outside the
  store.
- It refuses, with exit 2 and before any download, every `index_repository`
  call that could write into the repository; see
  [Nothing written into the repository](#nothing-written-into-the-repository).
- It reads three variables and passes every other one, `CBM_CACHE_DIR`
  included, through untouched:

  | Variable | Default | Meaning |
  |---|---|---|
  | `CBM_VERSION` | `latest` | A tag such as `v0.12.1` pins that release and never asks GitHub for the latest |
  | `CBM_UPDATE_INTERVAL` | `86400` | Seconds between release checks; `0` checks on every run |
  | `CBM_BIN_BASE` | `${XDG_CACHE_HOME:-~/.cache}/codebase-memory-mcp/bin` | Binary store |

- It needs curl or wget, tar (unzip for the Windows zip), and sha256sum,
  shasum, or openssl.

## Platforms

| `uname -s` | `uname -m` | Asset | Binary |
|---|---|---|---|
| `Linux` | `x86_64`, `amd64` | `codebase-memory-mcp-linux-amd64-portable.tar.gz` | `codebase-memory-mcp` |
| `Linux` | `aarch64`, `arm64` | `codebase-memory-mcp-linux-arm64-portable.tar.gz` | `codebase-memory-mcp` |
| `Darwin` | `arm64`, or `x86_64` when `sysctl -n hw.optional.arm64` is `1` (Rosetta) | `codebase-memory-mcp-darwin-arm64.tar.gz` | `codebase-memory-mcp` |
| `Darwin` | `x86_64` on Intel | `codebase-memory-mcp-darwin-amd64.tar.gz` | `codebase-memory-mcp` |
| `MINGW*`, `MSYS*`, `CYGWIN*` | `x86_64`, `amd64` | `codebase-memory-mcp-windows-amd64.zip` | `codebase-memory-mcp.exe` |
| `MINGW*`, `MSYS*`, `CYGWIN*` | `aarch64`, `arm64` | `codebase-memory-mcp-windows-arm64.zip` | `codebase-memory-mcp.exe` |

Anything else exits 1 with `unsupported OS` or `unsupported CPU`. The Linux
`-portable` builds are statically linked, so they run on musl and old glibc
too. Each archive holds the binary at its root, over 300 MB unpacked. Git for
Windows ships `unzip`. Cygwin, unlike Git Bash and MSYS2, does not translate
path arguments for the native binary; pass Windows paths there (`cygpath -w`).

## Choosing the release

1. A pinned `CBM_VERSION` runs as is, installed first if missing.
2. If the last check (`checked-at`) is younger than `CBM_UPDATE_INTERVAL` and
   the tag in `latest` is installed, that tag runs. This is the common path: no
   network access and no writes.
3. Otherwise the wrapper asks
   `https://api.github.com/repos/DeusData/codebase-memory-mcp/releases/latest`,
   which skips prereleases and drafts, and installs that tag if needed. When
   the tag changed, it deletes every installed release except the new one and
   the previous one, which a concurrent run may still be starting.
4. If the check or the install fails, the newest installed release runs after a
   `cbm: warning:` line. With none installed, the wrapper exits 1.
5. Steps 3 and 4 both record the tag and the time, so a machine without network
   waits a full interval before trying again instead of paying a connection
   timeout on every call.

Tags must be `vMAJOR.MINOR.PATCH` with digits only, so nothing from the
network or the environment reaches a path or URL unchecked.

## Installing a release

1. Download `checksums.txt` and the asset over HTTPS only (`--proto =https
   --proto-redir =https`) into `.work.<pid>/` inside the store.
2. Compare the asset's SHA-256 with its line in `checksums.txt`. A missing line
   or a mismatch stops the install.
3. Unpack only the binary, which upstream keeps at the archive root, and run
   `--version` from the work directory. A binary that cannot start, for example
   on a `noexec` mount, stops the install with a hint to set `CBM_BIN_BASE`.
4. Rename the binary into `cbm-<tag>/`. The work directory is on the same
   filesystem, so the rename is atomic: a concurrent run sees the whole binary
   or none. On Windows the rename fails while another run executes that
   release, and the binary already in place is used.
5. Remove the work directory on exit, interrupt, or failure. A process killed
   outright leaves its directory behind; the next run that needs the network
   deletes work directories whose process no longer exists.

Every request sends the User-Agent of the shell fallback in `APPEND_SYSTEM.md`,
so it passes the same firewalls.

## Storage

```text
${XDG_CACHE_HOME:-~/.cache}/codebase-memory-mcp/
├── bin/                  the wrapper's store (CBM_BIN_BASE)
│   ├── cbm-v0.12.1/codebase-memory-mcp
│   ├── latest            tag the last check settled on
│   └── checked-at        time of that check, epoch seconds
├── _config.db            cbm settings
└── <project>.db          one index per project
```

Other wrappers that use the same `bin/` layout and state files share the
binaries and the daily check. cbm chooses the rest; the tree
shows its Linux default. The wrapper never sets `CBM_CACHE_DIR`: cbm's default
is where any other cbm client looks, and cbm's per-account daemon asks for one
consistent cache directory.

cbm names a project after the absolute path it indexed:
`/home/me/src/app` becomes `home-me-src-app`. Each
checkout and worktree gets its own index, and indexing a subdirectory creates a
separate project, so the skill always indexes `git rev-parse --show-toplevel`.
Without `--persistence true`, indexing writes nothing into the repository.

## Nothing written into the repository

Checked on 2026-11-18 with 0.12.1 against a clone of this repository: a first
install and every command in `SKILL.md`, run from the repository root, from a
subdirectory, and from an unrelated directory, created, changed, or removed no
file in the repository (`.git/` and ignored files included) or in the working
directory. `manage_adr` keeps its document in cbm's cache.

cbm writes into a repository in two cases, and the wrapper refuses both:

- `index_repository --persistence true` creates `.codebase-memory/`
  (`artifact.json`, `graph.db.zst`, and a `.gitattributes`) and adds a merge
  driver to `.git/config`.
- Once `.codebase-memory/` exists, for example because a teammate committed
  it, every `index_repository` call rewrites it and `.git/config`, even with
  `--persistence false`. No setting or environment variable turns this off.

So the wrapper reads `index_repository`'s arguments itself and refuses
`--persistence` with any value but `false`, JSON or `--args-file` arguments
(it cannot read them), a call without `--repo-path`, and a `--repo-path` that
holds `.codebase-memory/`. `--help` passes. The skill falls back to grep in
such a repository.

## Decisions

- **No settings changes.** The wrapper leaves settings such as `auto_watch`
  alone: `index_status` reports that auto-sync "watches only the
  active MCP session's project", and a CLI call runs a session-managed daemon
  that exits with the call. The skill re-indexes explicitly instead.
- **CLI, not an MCP server.** `codemode.mode` is `only`, and the CLI reaches
  every tool, so `mcp.json` stays as it is.
- **Pruning.** Each release unpacks to over 300 MB; three releases took about
  880 MB on the first machine. Keeping the new release and the one before it
  bounds the store and still covers a concurrent run and a quick rollback with
  `CBM_VERSION`.
- **Integrity, not authenticity.** `checksums.txt` comes from the same release
  over HTTPS, so verification catches corruption and truncation, not a
  compromised release. Upstream also publishes Sigstore bundles (`*.bundle`);
  checking them needs cosign, which the wrapper does not assume.

## Tests

`tests/codebase-search.test.ts` runs the real script against a stub `curl` that
serves fake releases from a temporary directory, so it never touches the
network or the user's cache. It covers the first install, argument and
exit-status pass-through, the throttle, an update with pruning and the sweep of
a dead process's work directory, a checksum mismatch, the offline fallback and
its back-off, a pinned version, the refused commands, every index call that
could write into the repository, every row of the platform table through stub
`uname` and `sysctl`, and ShellCheck. The Windows rows run
only where `zip` and `unzip` exist.
