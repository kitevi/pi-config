---
name: blast-radius
description: "Find what a change breaks outside the diff, and show each break by running code. Use for 'blast radius of X', 'what could this break', or a small diff you don't trust."
disable-model-invocation: true
license: MIT (adapted from cursor/plugins pstack; see LICENSE)
---

# Blast radius

Find what this change breaks outside the diff. Callers that grep finds are not the job. The job is what grep misses.

## Steps

1. Read the diff, including untracked files. If it changes only docs, comments, or formatting, run any check that reads those files, reply "Nothing that runs changed" with that check's result, and stop.
2. List every place outside the diff that now behaves differently: callers, data the change writes or reads, serialized formats, config keys, and names held in strings such as templates, queries, and selectors.
3. Check each place with one search or one run, and mark it `breaks`, `fine`, or `unchecked`. A search that finds nothing is an answer.
4. Run the real code for every `breaks`: an existing test, a new test file, or a short script that fails when you are wrong. Never edit an existing test. If you cannot run it, mark it `unchecked`.
5. Stop after 20 tool calls and reply with what you have.

## Reply

- **Blast radius.** One line per place: `file:line`, what changes there, and `breaks`, `fine`, or `unchecked`.
- **Shockers.** Each `breaks` place: what breaks, the command you ran, and its output. If there are none, write "None found."
- **Unchecked.** At most three, one line each, with the command that would settle it. If there are none, write "None."

Leave out style, naming, wording, and anything that needs a future change to matter.
