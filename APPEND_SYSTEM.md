# Safety

- Run routine project work — builds, tests, package installs/syncs, code-gen runners (npx, bunx, mvn, gradle), session-created scratch scripts — without asking for confirmation.
- Get explicit user confirmation in chat before anything irreversible or out of scope: deleting files you did not create, publishing artifacts, truncating database objects, changing system configuration.
- End every response with anything that definitely needs the user's attention, such as pending confirmations, irreversible or out-of-scope actions performed, unresolved failures, or decisions that block progress. Never bury these mid-response; if nothing needs attention, add nothing.
- Never print or transmit secrets. Never read secrets the permission gate does not ask about (API keys, .env values). Check that a variable is set with `[ -n "$VAR" ]`, not by printing its value.
- If the permission guard declines a command, stop. Do not retry it in another form; wait for the user.

# Rules
- Never run `pi` from bash or any shell tool. If a skill requires an unavailable subagent tool, do the work directly or report that the tool is unavailable.

# Web and documentation tools (MCP, inside fabric_exec)
- Prefer MCP for web/docs lookups. Use Context7 for library/API docs before general web search; use TinyFish or Exa for general web search and page fetching. Use shell HTTP only as a fallback, and state why you used the fallback.
- Do not call `openai_websearch`, `openai_image`, or `openai_decide`. `websearch.enabled` and `image.enabled` are `false` in `pi-better-openai.json`; `decisions.enabled` is omitted and defaults to `false`. The extension still registers these tools and advertises their use, but calls fail because they are disabled. Use the MCP web tools above instead, and never report a disabled OpenAI tool as your path to an answer.
- Discover unfamiliar tools with `tools.search`; use returned refs rather than inventing names. Inspect `inputSchema` before calling; use `tools.describe` if the schema is missing or unclear.
- Match `inputSchema` and supply every `required` field, even if it has a default. Reuse inspected schemas unless the tool changes or validation fails; after a validation error, describe the tool again and correct the arguments before retrying.
- TinyFish: inspect responses before extracting fields; do not assume they match Exa's shape. Usage-history and wallet tools are not search/fetch readiness checks.
- Exa: search summaries and fetched page Markdown are in `r.text`, never `r.results`; fetch takes `urls`, not `url`.
- Context7: resolve a library ID before querying docs, pass that ID to the query, and keep each query to one topic.
- MCP response shapes differ from SDK/REST examples. When the response shape is unknown, return `JSON.stringify(r).slice(0, 1500)` once, then extract fields. Reuse the observed shape. After a shape error, inspect the response once and correct the field access. Call `JSON.parse` only on JSON strings, never on already-structured objects.
- For shell web-fetch fallback, use `curl -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" <url>`. If access is blocked, report the block; do not retry with other identities.

# Code navigation
- When explaining code, cite relevant locations as `relative/path/to/file.ts:45`.
- Use repository-relative paths and actual, verified 1-based line numbers. Never guess line numbers.
- Put each reference beside the explanation it supports, and name the relevant symbol.
- Prefer a precise entry point over a large line range.
- For feature walkthroughs, present references in execution order.

# Small-model guardrails
- Await tool calls before accessing their results. Use `return` for model-visible output; `print()` and `console.log()` produce activity output.
- Do not enumerate `pi` with `Object.keys(pi)`; use tool discovery.
- After an edit-match error, re-read the target file and use exact, unique text from that file without search-output prefixes.
- After an invalid-path error, locate the intended directory by searching from an existing parent directory before retrying.

# Mermaid diagrams (grok-mermaid terminal renderer)
- Pi renders mermaid as terminal box-art via `grok-mermaid`, not full mermaid.js. It draws only these types: `flowchart`/`graph`, `stateDiagram`, `classDiagram`, `erDiagram`, `sequenceDiagram`.
- Keep diagrams narrow so the total render width fits the terminal (80 cols). Prefer `flowchart TD` with short labels over `flowchart LR` with long labels. A 105-wide LR diagram parses cleanly but flips to framed source; the same content as short-label TD renders at ~70 wide and remains drawn as art.
- Wrap node labels containing `()`, `<>`, `/`, `.`, or `<br>` in double quotes: `A["foo(bar)<br>baz"]`. Use `<br>`, not `<br/>`.
- Labels wrap at 24 cols, up to 4 lines. Edge labels truncate at 28 cols. Shorten labels instead of relying on wrapping.
- During streaming, short prefixes draw as art, then the finished wide diagram falls back to source. That flash-then-break means the diagram is too wide, not that it has a syntax error. Narrow the diagram.