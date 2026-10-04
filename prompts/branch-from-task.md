---
description: Create and switch to a local git branch from a task description
argument-hint: "[from <local-branch>] <ticket-or-task description>"
---

Create and switch to at most one local branch for this invocation, after confirming its name, base, and exact command.

Use local Git state only. The confirmed branch switch is the only permitted mutation: do not commit, push, fetch, pull, merge, rebase, stash, or edit files. If a check blocks progress, explain it and stop rather than repairing state.

Task:
$ARGUMENTS

## 1. Check the worktree

Verify this is a Git worktree, then run `git status --porcelain`. Any output means stop immediately: this request requires a clean worktree and does not carry changes onto the new branch.

## 2. Resolve the task and base

1. Parse only a leading `from <local-branch>` as the base selector, and strip it before interpreting the task.
   - `from main ABC-1234 fix login redirect` selects `main`.
   - `base <branch>` and non-leading uses of `from` remain task text.
2. Without that selector, use the current local branch. If HEAD is detached, stop and ask me to rerun with `from <local-branch>`.
3. Require a meaningful task description after removing the selector. If it is empty or contains only a ticket number/key, stop and ask for a short description.
4. Verify the base is an existing local branch with `git show-ref --verify refs/heads/<base>`. Reject remote-tracking bases such as `origin/main`.
5. Compare the base with its known remote-tracking counterpart:
   - Prefer the configured upstream from `git rev-parse --abbrev-ref <base>@{upstream}`.
   - Otherwise, if `refs/remotes/origin/<base>` exists, use `origin/<base>`.
   - If neither exists, proceed without a tracking comparison.
   - Otherwise, run `git rev-list --left-right --count <base>...<tracking-ref>`. If either count is non-zero, stop: I must resolve an ahead, behind, or diverged base manually.

## 3. Build and validate the name

### Ticket

- Accept Jira-style keys such as `ABC-1234` and bare ticket numbers. Use only the numeric part in the branch name.
- Prefer a single Jira-style key over bare numbers elsewhere in the text. If there are multiple keys, or multiple bare-number candidates without a single key, stop and ask which ticket to use.
- If no ticket is found, ask: `No ticket number found. Create a non-ticket branch?` Use the non-ticket format only after confirmation.

### Name

- With a ticket: `<scope>/<ticket-number>-<kebab-summary>`.
- Without a ticket: `<scope>/<kebab-summary>`.
- Infer a specific scope from project language: subsystem, module, feature, package, command, config area, or concern.
- Keep the summary concise and retain meaningful action verbs such as `fix`, `add`, `update`, `remove`, `rename`, or `support`. Avoid filler such as `misc`, `stuff`, `changes`, `work`, or `update-stuff`.
- Use exactly one `/` between the two lowercase kebab-case segments. Separate words with single hyphens; use no spaces, underscores, trailing separators, or trailing periods.
- Keep the name around 80 characters or less unless a longer name is clearly justified.
- Validate the candidate with `git check-ref-format --branch <branch>` before proposing it.
- Check for an existing local branch with `git show-ref --verify refs/heads/<branch>`. If it exists, stop and ask me to choose a different summary or switch manually.

## 4. Confirm and create

Once every check passes, show:

```text
Proposed branch: <branch>
Base branch: <base>

Will run:
git switch -c <branch> <base>

Proceed?
```

Wait for confirmation. Then:
1. Recheck the clean worktree, local base existence, base-vs-tracking comparison, and absence of the proposed branch.
2. If those checks still pass, run exactly `git switch -c <branch> <base>`.
3. On success, reply only with a concise result, such as `Created and switched to branch <branch> from <base>.` On failure, explain why and what I should do next. Stop after reporting either result.
