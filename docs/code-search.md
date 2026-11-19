# Code search (`extensions/code-search.ts`)

`extensions/code-search.ts` registers `code_search`, the tool that every Pi
session starts a search of code with. It runs
[probe](https://github.com/probelabs/probe), which pairs ripgrep with
tree-sitter: it needs no index, and an answer quotes whole functions, classes,
and blocks with line numbers, best match first. This page is the spec; the tool
description in `extensions/code-search.ts` and the "Code search" section of
`APPEND_SYSTEM.md` are what the model reads.

Facts about probe below were checked against probe v0.6.0-rc347 on 2026-11-19.

## Files

| Path | Role |
|---|---|
| `extensions/code-search.ts` | Registers `code_search`; installs, updates, and runs probe |
| `APPEND_SYSTEM.md`, section "Code search" | Routing for every session |
| `tests/code-search.test.ts` | Extension tests |
| `skills/codebase-search/` | The call graph that the user can start instead ([`docs/codebase-search.md`](codebase-search.md)) |

## Requirements

| Requirement | How it is met |
|---|---|
| Works in any repository, with no index, no per-repository setup, and nothing written into the repository | probe reads the files as they are ([below](#nothing-written-into-the-repository)) |
| Installs probe on first use and keeps it current without help | [Release, install, and storage](#release-install-and-storage) |
| Linux, macOS, and Windows, on x86-64 and ARM64 | [Platforms](#platforms) |
| A repository's own code-search tool takes precedence for the whole session | `APPEND_SYSTEM.md` "Code search" and the last sentence of the tool description ([Routing](#routing)) |
| The model starts every other search of code with it without being asked, small models included | `APPEND_SYSTEM.md` "Code search" names the first tool call ([Routing](#routing)) |
| Codemode scripts can call it without a discovery step | [Codemode listing](#codemode-listing) |
| Reconciliation stays offline | The download happens on the first call, never in `bootstrap.mjs` |

## Routing

1. **Repository tool.** When the repository's AGENTS.md, CLAUDE.md, or the docs
   they point to name a code-search tool, the model uses it as they describe for
   the whole session, also when it is the repository's own codebase-memory-mcp
   wrapper, and calls `code_search` there only if that tool fails. A preferred
   text-search command, such as `rg` over `grep`, is not a code-search tool.
2. **The codebase-search skill**, once the user starts it with
   `/skill:codebase-search`: its graph answers every search of code for the rest
   of the session ([`docs/codebase-search.md`](codebase-search.md)).
3. **`code_search`** for every other search or exploration of code: where
   something is defined or handled, what calls or uses it, what it calls,
   whether it exists, how the parts connect, and what a change affects. It is
   the first tool call; grep, find, and ls wait until it has answered.
4. **grep, find, ls, and read** straight away for text rather than code
   structure: string literals, comments such as TODOs, configuration values,
   logs, and a named file or directory.

`APPEND_SYSTEM.md` states this order for every session. The last sentence of the
tool description repeats the first step, because the description is what a
model reads as it writes the call.

On 2026-11-19, `coralbricks/deepseek-v4.1-flash-fast` at thinking `max` ran one
prompt per fresh `pi -p` session with the wording above:

| Sessions | Expected | Result |
|---|---|---|
| 15 code questions in a Rust repository | `code_search` in the first tool call | 15 of 15 |
| 10 text lookups in the same repository: TODO and FIXME comments, comments that mention "deprecated", a directory listing, the Markdown files in `docs/`, the test files, the version and the dependencies in `Cargo.toml`, a literal string, `.gitignore`, and the first 40 lines of the README | no `code_search` | 10 of 10 |
| 12 code questions, 2 sessions each, run to the answer in three smaller repositories without a code-search tool of their own (two TypeScript, one Go): in each, three about a named function or type and one about how a feature works | `code_search` in the first tool call | 19 of 24. Three more first read the `CONTEXT.md` that the Go repository's CLAUDE.md requires before any work and called `code_search` in their next call; both sessions of one how-does-it-work question started with `ls` and the README and never called it. All 18 sessions about a named function or type named the file that defines it |
| 3 text lookups, 2 sessions each, in the same repositories: a directory listing, the dependencies in `package.json`, the Markdown files in `docs/` | no `code_search` | 6 of 6 |
| 6 code questions, 4 sessions each, in a Java repository whose AGENTS.md makes its own cbm wrapper the mandatory first step | the wrapper in the first tool call | 24 of 24 |
| The same 6 questions, 2 sessions each, run to the answer or to 14 tool calls | the wrapper, and no `code_search` | 11 of 12 started with the wrapper and 1 with `code_search`; none of the other 113 tool calls used `code_search` |
| The same 6 questions, 2 sessions each, with `--no-context-files`, so that the repository's AGENTS.md is not loaded | `code_search` in the first tool call | 12 of 12 |
| 5 code questions in the Rust repository, each after `/skill:codebase-search` | the skill's wrapper in the first tool call | 5 of 5, none `code_search` |

Deferring to the Java repository's tool took two rounds. With the exception in
`APPEND_SYSTEM.md` alone, 5 of 30 sessions there called `code_search` in their
first tool call. A last sentence in the tool description that sent the model to
the repository's tool brought that to 1 of 48, but in 12 sessions run to the
answer one later call still looked up a symbol with `code_search` that the
repository's graph could find. Stating in both places that the repository's
tool holds for the whole session, with `code_search` only as the fallback when
it fails, gave the results above.

### Why the section reads as it does

The section keeps the shape that the codebase-search skill was tuned to on
2026-11-18, with the same model and one prompt per fresh session, while the
skill was the default for every search of code. It names the first tool call
because a small model skips a looser rule: when the section only named the
question types and said to ask the graph before grep or find, the model started
3 of 15 code searches in the Rust repository with the graph alone. Naming the
first tool call raised that to 15 of 15, while none of 15 text lookups touched
the graph, and all 6 searches in a repository that names its own tool used that
tool.

The first sentence points to the exception, and the exception names a
repository's own cbm wrapper, because a repository can route code search through
its own codebase-memory-mcp wrapper under a heading that is also called codebase
search. In the Java repository the model never ran the skill's wrapper, but it
read the skill's `SKILL.md` within its first two tool calls in 10 of 15
sessions; with both changes it did so in 3 of 35, while code searches in the
Rust repository still started with the graph in 34 of 35.

## Tool contract

- **Parameters.** `query` is required. `path`, a file or directory relative to
  the working directory, defaults to the whole working directory. `maxTokens`,
  the code budget of the answer, defaults to 4,000 and is clamped to
  500–20,000.
- **Command.** Each call runs, from the home directory
  ([below](#nothing-written-into-the-repository)):

  ```
  probe search --format outline --max-tokens <maxTokens> --allow-tests [--exact] -- <query> <absolute path>
  ```

- **Literal queries.** A query without whitespace or `"` that is neither a bare
  `AND`, `OR`, or `NOT` nor a filter starting with `ext:`, `file:`, `path:`,
  `dir:`, `lang:`, `language:`, or `type:` gets `--exact`: probe matches it as
  a case-insensitive substring, also inside longer names, instead of parsing it
  as a query. `$scope`, `Foo::bar`, `@Override`, `a[0]`, `user.name`,
  `code-search`, `foo(x)`, `x+y`, `*ptr`, `a|b`, `^start`, and `USER.NAME` each
  found their line. A literal query is also the fast one: in the Java
  repository an identifier took about 1 s, two words about 12 s, and a query
  without matches 0.15 s. With `--files-only` the two words took 2.6 s, so the
  time goes into extracting the matching blocks.
- **What one call covers.** probe ranks the matching files by BM25, not
  definitions first. In two small TypeScript repositories, a literal query for
  each of six functions and types took 0.1–0.2 s and showed its definition and
  every file that uses it within the default budget. In a Go repository of
  about 90 source files, `FetchCache` and `Poller`, each used in 22 files, took
  0.3 s and showed their definitions but only 17 and 9 of those files, listing
  the rest. `Source`, used in 40 files, matched 85 as a substring and filled the
  budget with 10 of them, leaving its definition out; the sessions that asked
  what a change to it would affect took 11 and 13 tool calls.
- **Several words** go to probe's query parser: they match by word stem and
  rank by BM25, and `AND`, `OR`, `NOT`, `"quoted phrases"`, `ext:`, `file:`,
  and `dir:` combine and narrow them.
- **Answer.** probe's outline, trimmed for the model. It keeps the matching
  blocks and the result count and drops the echoed pattern, path, and ranking
  lines, the statistics after the count, and the CLI tips. The files past the
  token budget become one line, "N more matching files not shown, among
  them:", followed by the first 10. Every file path becomes relative to the
  working directory or its real path; probe names the files it left out
  relative to its own working directory, the home directory, when they lie
  under it, so those are resolved against it first. A search without matches
  answers `No results found.`
- **Errors.** An empty query and a missing path fail before probe runs. When no
  probe can be found or installed, the call fails with "code_search is
  unavailable (<reason>); search with grep, find, and read instead." A non-zero
  exit reports the last 2,000 characters of probe's stderr, or of its stdout
  when stderr is empty; a search still running after 120 s is stopped.

## Platforms

| `process.platform`, `process.arch` | Release asset |
|---|---|
| `darwin`, `arm64` | `probe-<tag>-aarch64-apple-darwin.tar.gz` |
| `darwin`, `x64` | `probe-<tag>-x86_64-apple-darwin.tar.gz` |
| `linux`, `arm64` | `probe-<tag>-aarch64-unknown-linux-musl.tar.gz` |
| `linux`, `x64` | `probe-<tag>-x86_64-unknown-linux-musl.tar.gz` |
| `win32`, `x64` | `probe-<tag>-x86_64-pc-windows-msvc.zip`, holding `probe.exe` |
| `win32`, `arm64` | The x86-64 build, which Windows on ARM runs under emulation; probe publishes no Windows ARM64 build |

On any other platform the tool reports itself unavailable unless `PROBE_PATH`
names a binary. `tar` unpacks both archive types; the `tar` that Windows 10 and
later ship is bsdtar, which reads zip.

## Release, install, and storage

```
${XDG_CACHE_HOME:-~/.cache}/probe/bin/
├── v0.6.0-rc347/probe   one directory per release
├── latest               the tag of the last check
└── checked-at           when it ran, in seconds since the epoch
```

1. `PROBE_PATH` names a binary that runs as is: no download and no check.
2. `PROBE_VERSION`, a tag such as `v0.6.0`, pins that release: it is installed
   if missing, GitHub is never asked for the latest one, and a value that is
   not a release tag makes the call fail.
3. If the last check is less than a day old and its release is installed, that
   release runs.
4. Otherwise GitHub's latest-release API names the release (15 s timeout); it is
   installed if missing, and the check is recorded. On 2026-11-19 that was
   v0.6.0-rc347: probe publishes its rc builds as full releases.
5. When the check or the install fails, the recorded release runs, else the
   newest one installed. The failed check is recorded too, so an offline
   machine asks again a day later, not on every call. With nothing installed,
   the call fails ([Tool contract](#tool-contract)).

Tags must look like `v0.6.0` or `v0.6.0-rc347`, so nothing from the network or
the environment reaches a path or URL unchecked.

An install downloads the archive and its `.sha256` file (180 s timeout),
compares the SHA-256, unpacks the archive in a `.install-*` work directory
inside the store, and renames the binary into `<tag>/`. The work directory is
removed afterwards, and one left by a process that died is swept after an hour;
when another process installed the same release first, its binary stays. After
each check the store keeps the current release and the one recorded before it
and deletes the other release directories. Concurrent calls in one session
share one check and download, and a call that installs a release reports
"Downloading probe <tag> for code_search..." while it waits. The requests send
no token and no user agent of their own.

## Nothing written into the repository

probe reads the files where they are and keeps no index. The extension writes
only inside its store, never passes `--session` (probe's cache of results it has
already returned), and runs probe from the home directory. probe reads
`./.probe/settings.json` from its working directory, and that file's
`defaults.enable_lsp` adds `--lsp` to every search, which starts language
servers, and a language server can run a repository's build scripts. From the
home directory that path is the user's own `~/.probe/settings.json`, which
probe reads in any case. A planted `.probe/settings.json` that limited results
to one cut an answer from three files to one when probe ran in its directory,
and changed nothing from the home directory.

## Codemode listing

`code_search` is an ordinary extension tool. With `codemode.mode` set to
`only`, Pi hides it as a top-level tool and lists it in the codemode tool's
description as a TypeScript declaration: scripts call
`tools.code_search({ query, path?, maxTokens? })`, which resolves to the answer
text. `codemode.inlineBudget`, 3,000 estimated tokens by default, limits that
listing; on 2026-11-19 `code_search` took 302 of the 2067 tokens that the
nine listed tools used. An MCP server would have been deferred, so a model
would have had to find the tool before calling it.

## Decisions

- **probe by default, cbm on request.** probe answers where-is and who-uses
  questions in one call with the code itself and has no index to build or keep
  fresh. cbm's graph adds exact callers and callees, call paths, architecture,
  and change impact, at the cost of an index and a longer workflow;
  `/skill:codebase-search` keeps it a command away. AFT was ruled out because
  it replaces Pi's own file tools.
- **The release binary, not the npm package.** The extension downloads probe
  itself, so reconciliation stays offline and `settings.json` gains no package.
- **An extension tool, not an MCP server**, so codemode lists it
  ([Codemode listing](#codemode-listing)).
- **Tests included.** `--allow-tests` keeps test callers in who-uses answers;
  `dir:` or `path` narrows a search.
- **Timeouts.** probe ends a search at its own `--timeout`, 30 s by default; the
  extension's 120 s limit catches a probe that hangs.
- **macOS quarantine.** A file that Node's `fetch` downloads carries no
  quarantine attribute, so Gatekeeper lets it run; the same binary downloaded
  by a browser was stopped until the user allowed it.
- **Integrity, not authenticity.** The `.sha256` file comes from the same
  release over HTTPS, so the check catches corruption and truncation, not a
  compromised release.

## Tests

`tests/code-search.test.ts` runs the extension against a fake `fetch` that
serves releases from a temporary directory, whose `probe` is a shell script
that answers in probe's outline format, so the tests never touch the network or
the user's cache. They cover the first install and the trimmed answer, the
daily check, an update with pruning, a digest mismatch, the offline fallback and
its once-a-day retry, the unavailable message, concurrent calls sharing one
download, `PROBE_PATH`, a `PROBE_VERSION` pin and a malformed one, the probe
arguments for literal and multi-word queries with a `path` and a clamped
budget, the home directory as probe's working directory, input errors, the
output trimming, the files left out that probe names relative to its working
directory, the literal-query rule, and every row of the platform table. The
tests that run the fake probe skip Windows.
