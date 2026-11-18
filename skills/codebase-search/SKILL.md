---
name: codebase-search
description: "Find code by structure, not text: where something is defined or handled, who calls it, what it calls, what a file contains, how a codebase is laid out, and what a change affects. Use first for every search of a repository's code, before grep, find, or ls, unless the repository's instructions name a code-search tool, such as their own cbm wrapper; literal text such as comments, string literals, and configuration values stays with grep. Runs codebase-memory-mcp, which its wrapper installs and updates."
compatibility: "POSIX sh with curl or wget, tar (unzip on Windows), and sha256sum, shasum, or openssl. Linux, macOS, or Windows Git Bash, on x86-64 or ARM64."
---

# Codebase search

Ask a graph of the code before you grep. Run every command through this skill's wrapper:

```bash
~/.pi/agent/skills/codebase-search/scripts/cbm cli <tool> --<flag> <value> ...
```

The wrapper installs codebase-memory-mcp on first use (a download of about 50 MB), checks for a new release at most once a day, verifies every download against the release's SHA-256 checksums, and then runs the tool with your arguments, passing its output and exit status through. Indexes live in the user's cache; nothing is written into the repository or the working directory, and the wrapper refuses any index call that would.

## Rules

1. If the repository's own instructions name a code-search tool, use that tool as they describe instead of this skill.
2. Index the repository root before the first query of a task, and again after you edit files, pull, or switch branches. Never index a subdirectory: it becomes a separate project.
3. Pass the project name from the `project` field of the index reply: `/home/me/src/app` becomes `home-me-src-app`. `list_projects` maps names to root paths.
4. Read the lines a result cites before relying on it or quoting it.
5. Before saying something does not exist, run `check_index_coverage` on that area. An excluded or unindexed path means unknown, not absent.
6. Use grep for literal text, configuration, logs, and files the index skips.
7. Give `index_repository` its arguments as flags and never add `--persistence`. Leave the index and its settings alone: ignore the reply's `adr_hint`, and run `manage_adr`, `delete_project`, or `config set` only when the user asks. The wrapper refuses `install`, `uninstall`, and `update`.
8. If the wrapper fails or refuses, for example offline before its first install or in a repository that holds a `.codebase-memory/` artifact, say so in one line and continue with grep and find.

## Commands

```bash
# Index or refresh the repository root (outside git, pass the project's root directory)
~/.pi/agent/skills/codebase-search/scripts/cbm cli index_repository --repo-path "$(git rev-parse --show-toplevel)"
~/.pi/agent/skills/codebase-search/scripts/cbm cli list_projects          # names and root paths

# Where is it? Ranked symbols with file and lines; qn is the qualified name
~/.pi/agent/skills/codebase-search/scripts/cbm cli search_graph --project P --query 'install json overlay'
~/.pi/agent/skills/codebase-search/scripts/cbm cli search_graph --project P --name-pattern '^install' --label Function

# Who calls it, and what does it call?
~/.pi/agent/skills/codebase-search/scripts/cbm cli trace_path --project P --function-name installJsonConfig --direction inbound
~/.pi/agent/skills/codebase-search/scripts/cbm cli trace_path --project P --function-name installJsonConfig --direction outbound --depth 2

# What is in it?
~/.pi/agent/skills/codebase-search/scripts/cbm cli get_file_outline --project P --file-path src/app.ts
~/.pi/agent/skills/codebase-search/scripts/cbm cli get_code_snippet --project P --qualified-name installJsonConfig

# Text inside indexed files, grouped by the enclosing symbol
~/.pi/agent/skills/codebase-search/scripts/cbm cli search_code --project P --pattern deviceId

# Layout, and what the changes since the base branch affect
~/.pi/agent/skills/codebase-search/scripts/cbm cli get_architecture --project P
~/.pi/agent/skills/codebase-search/scripts/cbm cli detect_changes --project P

# Was that area indexed at all? Repeat --paths for more
~/.pi/agent/skills/codebase-search/scripts/cbm cli check_index_coverage --project P --paths src/auth
```

- `scripts/cbm --help` lists every tool; `scripts/cbm cli <tool> --help` lists its flags.
- Replies are compact tables. When one says `has_more: true`, page with `--offset` or narrow the query.
- `detect_changes` compares with `origin/HEAD`, else `main` or `master`; pass `--base-branch` for another.
