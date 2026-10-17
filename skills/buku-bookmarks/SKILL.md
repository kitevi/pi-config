---
name: buku-bookmarks
description: "Manage a Buku bookmark collection: inspect, search, add, tag, update, delete, import, export, back up, and open bookmarks. Use whenever the user mentions Buku, the `b` fuzzy bookmark launcher, bookmark organization, or asks Pi to change a bookmark collection."
compatibility: Requires Buku 5.0+. The interactive launcher also requires Bash and fzf.
---

# Buku Bookmarks

## Setup

- Buku's data directory comes from `BUKU_DEFAULT_DBDIR`.
- The shell configuration defaults it to `$HOME/MEGA/buku`.
- The live database is `$BUKU_DEFAULT_DBDIR/bookmarks.db`.
- Daily exports are `$BUKU_DEFAULT_DBDIR/backups/bookmarks-YYYY-MM-DD.db`.
- The interactive launcher is the Bash function `b [initial query]` in `$HOME/.bashrc`.
- When bookmarks exist, `b` creates the day's export on its first invocation, then uses `fzf` and opens the selected bookmark in the default browser. An empty collection exits cleanly without creating an export.

The Bash tool is non-interactive and might not source `.bashrc`. Pass the resolved data directory explicitly. `--nostdin` must be Buku's first argument, but it does not suppress every confirmation prompt. Do not invoke `b` from an agent shell; it is an interactive human command.

## Required Preflight

Begin every Bash tool call that uses Buku with this check, before any file changes:

```bash
command -v buku >/dev/null 2>&1 || {
  printf '%s\n' 'Buku is not installed or not on PATH; aborting.' >&2
  exit 127
}
```

If Buku is missing, report that and stop. Do not install it or initialize a database automatically.

For live-collection commands, follow with this check before invoking Buku or creating backup directories:

```bash
data_dir="${BUKU_DEFAULT_DBDIR:-$HOME/MEGA/buku}"
if [ ! -d "$data_dir/.." ] ||
   [ ! -f "$data_dir/bookmarks.db" ] ||
   [ ! -r "$data_dir/bookmarks.db" ]; then
  printf 'Buku collection unavailable: %s/bookmarks.db; aborting.\n' "$data_dir" >&2
  exit 1
fi
```

Prefix every command block below with both preflights in the same Bash tool call. Resolve `data_dir` again on each call; shell state might not persist. Backup inspection is the exception: run the Buku availability check and the selected-backup check shown there, without requiring a live database.

## Safety Rules

1. Match the user's intent. For research, explanation, or planning requests, do not modify bookmarks or files.
2. Treat `bookmarks.db` as Buku-owned. Never edit it directly with a text editor, Pi file tools, or mutating SQLite statements.
3. Run the required preflights before every live-collection command, including reads. Buku can create missing databases even during inspection. Report an unavailable collection instead of initializing one.
4. Inspect relevant records as JSON immediately before changing them. Do not rely on IDs remembered from an earlier turn.
5. Buku indices are not stable: deletion can move another bookmark into the deleted index. Perform an approved multi-delete in one Buku command, then fetch fresh records.
6. Create a timestamped `.db` export before deletion, import, global tag replacement, bulk update, or other high-impact changes. Confirm the export command succeeded and the file is non-empty before proceeding.
7. Execute clear, low-risk requests such as adding one bookmark without unnecessary confirmation. Ask only when the target or intended mutation is ambiguous.
8. Verify mutations by reading the affected records again. For deletions, verify by URL rather than by the old index.
9. Do not open URLs in the browser unless the user asks. Searching and reporting results must remain non-interactive.
10. Do not store credentials, session tokens, or signed query parameters in bookmark URLs. Never prune backup files unless explicitly requested.

## Inspect and Search

List every record as JSON:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --print --json
```

Search all supplied words, including substrings, and return JSON:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --sall postgres production --deep --json
```

Search by tags:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --stag 'database + postgres' --json
```

Print specific current indices:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --print 12 18 --json
```

Prefer JSON for agent work. Use the URL as the durable identity and the index only for the immediate command.

## Backup Before High-Impact Changes

Create a unique timestamped directory and export to a nonexistent `bookmarks.db` inside it. This prevents same-second collisions and overwrite prompts:

```bash
backup_dir="$data_dir/backups"
mkdir -p "$backup_dir" || exit 1
backup_run_dir="$(mktemp -d "$backup_dir/bookmarks-before-change-$(date +%Y%m%d-%H%M%S)-XXXXXX")" || exit 1
backup="$backup_run_dir/bookmarks.db"
if ! env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --export "$backup" --tacit || [ ! -s "$backup" ]; then
  printf '%s\n' 'Buku backup export failed or is empty; aborting.' >&2
  exit 1
fi
printf 'Backup: %s\n' "$backup"
```

Abort the requested mutation if either export or validation fails. The daily launcher backup does not replace this pre-change backup for destructive or bulk work.

Inspect a selected backup without touching the live database:

```bash
backup_path="${BUKU_BACKUP_PATH:?Set BUKU_BACKUP_PATH to the selected backup}"
case "$backup_path" in
  /*) ;;
  *) backup_path="$PWD/$backup_path" ;;
esac
if [ ! -f "$backup_path" ] || [ ! -r "$backup_path" ]; then
  printf 'Buku backup unavailable: %s; aborting.\n' "$backup_path" >&2
  exit 1
fi
buku --nostdin --db "$backup_path" --print --json
```

Restoring or replacing the live database requires an explicit request. Do not infer that inspecting a backup means restoring it.

## Mutations

Add a bookmark; tags are comma-separated:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --add 'https://example.com' 'database,postgres,production'
```

Use `--title`, `--comment`, or `--offline` only when the request requires them. By default, Buku fetches page metadata.

Append or remove tags from a freshly resolved index:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --update 12 --tag + 'database,postgres'

env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --update 12 --tag - 'obsolete'
```

Update title or comment:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --update 12 --title 'PostgreSQL Operations' --comment 'Operations reference'
```

Replace a tag globally only after backup and scope review:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --replace 'old-tag' 'new-tag'
```

Delete approved records in one command after backup:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" \
  buku --nostdin --delete 12 18 --tacit
```

Import only from a path the user identifies. For HTML imports, `--tacit` suppresses prompts, omits the automatic date tag, uses direct parent folder names as tags, and appends imported tags to existing bookmarks. Confirm these effects match the requested import; ask if the intended tag policy is unclear.

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --import /path/to/bookmarks.html --tacit
```

Export only to a path the user identifies:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --export /path/to/bookmarks.html
```

Open a freshly resolved index only when requested:

```bash
env BUKU_DEFAULT_DBDIR="$data_dir" buku --nostdin --open 12
```

## Completion Checklist

- Required preflights ran in each Bash tool call before Buku or file changes.
- The command targeted the resolved `data_dir`, not Buku's fallback database.
- High-impact work has a verified pre-change `.db` export.
- Changed records were re-read and checked.
- IDs were refreshed after any delete or reorder.
- The response reports affected URLs/titles and the backup path when one was created.
