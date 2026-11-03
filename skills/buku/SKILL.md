---
name: buku
description: "Search, add, tag, edit, delete, import, export, back up, and open the user's Buku bookmarks. Use whenever the user mentions bookmarks, Buku, or the `b` bookmark launcher."
compatibility: Requires Buku 5.0+ and Bash.
---

# Buku

Run every Buku command through this skill's wrapper, `scripts/bk`:

```bash
~/.pi/agent/skills/buku/scripts/bk <buku options>
```

The wrapper adds `--nostdin`, uses the user's live collection, and stops if Buku or the collection is missing. Before a delete, import, tag replacement, or update of more than one bookmark, it saves a backup and prints `Backup: <path>`; if the backup fails, nothing changes.

- Never run `buku` directly or the `b` launcher, and never open `bookmarks.db` with other tools or SQLite.
- If the wrapper says Buku or the collection is unavailable, report that and stop. Do not install Buku or create a database.

## Rules

1. Change bookmarks only when the user asks for a change. Questions, research, and planning are read-only.
2. Fetch the records as JSON right before changing them. Indices shift after every delete, so never reuse an index from an earlier command, and delete several bookmarks in one command.
3. Act on clear requests, such as adding one bookmark, without asking. Ask first only when it is unclear which bookmarks or which change the user means.
4. After a change, fetch the records again to confirm it. Confirm deletions by URL.
5. Open bookmarks in the browser only when the user asks.
6. Never put passwords, tokens, or signed query parameters in a bookmark URL. Never delete backup files unless the user asks.
7. Finish by listing the affected titles and URLs, plus the backup path if one was printed.

## Commands

```bash
# Read: always add --json
~/.pi/agent/skills/buku/scripts/bk --print --json                     # all bookmarks
~/.pi/agent/skills/buku/scripts/bk --print 12 18 --json               # by index
~/.pi/agent/skills/buku/scripts/bk --sall postgres production --deep --json  # all words, substrings too
~/.pi/agent/skills/buku/scripts/bk --stag 'database + postgres' --json  # both tags; 'a, b' = either

# Change
~/.pi/agent/skills/buku/scripts/bk --add 'https://example.com' 'database,postgres'
~/.pi/agent/skills/buku/scripts/bk --update 12 --tag + 'database,postgres'
~/.pi/agent/skills/buku/scripts/bk --update 12 --tag - 'obsolete'
~/.pi/agent/skills/buku/scripts/bk --update 12 --title 'PostgreSQL Operations' --comment 'Operations reference'
~/.pi/agent/skills/buku/scripts/bk --replace 'old-tag' 'new-tag'      # rename a tag everywhere
~/.pi/agent/skills/buku/scripts/bk --delete 12 18 --tacit

# Files: only paths the user names
~/.pi/agent/skills/buku/scripts/bk --import /path/to/bookmarks.html --tacit
~/.pi/agent/skills/buku/scripts/bk --export /path/to/new-file.html

# Browser: only when asked
~/.pi/agent/skills/buku/scripts/bk --open 12

# Backups
~/.pi/agent/skills/buku/scripts/bk backup                # make one now
~/.pi/agent/skills/buku/scripts/bk show-backup           # list backups
~/.pi/agent/skills/buku/scripts/bk show-backup FILE      # print one as JSON
```

- `--add` fetches the page title and description. Pass `--title`, `--comment`, or `--offline` only when the request needs them.
- `--import ... --tacit` tags each bookmark with its folder name, adds no date tag, and merges tags into bookmarks that already exist. Ask first if the user wants different tagging.
- `--export` cannot overwrite a file; use a path that does not exist yet.
- Restore a backup over the live collection only when the user explicitly asks.
