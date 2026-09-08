# Rules
- Never run `pi` from bash or any shell tool. If a skill requires an unavailable subagent tool, do the work directly or report that the tool is unavailable.

# Web and documentation tools (MCP, inside fabric_exec)
- Prefer MCP for web/docs lookups. Use shell HTTP only as a fallback, and state why you used the fallback.
- `mcp.exa.web_search_exa({query, numResults?})` returns `{text: string}` containing a rendered search summary, not a results array. Read `r.text`, never `r.results`.
- `mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})` returns page markdown in `r.text`. Pass `urls`, not `url`.
- Prefer `mcp.synthetic_web_search.search_web({query, max_text_length?})` for privacy-sensitive queries or when Exa's features are unnecessary. The response's `r.text` contains a JSON array: parse it with `JSON.parse(r.text)`. Each result has `url`, `title`, `text`, `highlights`, and optional `published` (omitted when unknown).
- For library/API docs, call `mcp.context7['resolve-library-id']({libraryName, query})`, then `mcp.context7['query-docs']({libraryId, query})`, before web search. Pass the library ID returned by `resolve-library-id` to `query-docs`. Send one topic per query.
- Before calling any other MCP tool, run `await tools.describe({ref})` and shape the arguments to match `inputSchema`. After an argument-validation error, describe the tool again and correct the call to match its schema before retrying.
- MCP response shapes differ from SDK/REST examples. When the response shape is unknown, first return `JSON.stringify(r).slice(0, 1500)` once, then extract fields. Reuse the observed shape. After a shape error, inspect once and correct the field access. Call `JSON.parse` only on JSON strings, never on already-structured objects.
- For shell web-fetch fallback, use `curl -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" <url>`. If access is blocked, report the block; do not retry with other identities.

# Small-model guardrails
- Await a tool call before accessing its result: `const r = await pi.bash({command: "pwd"}); return r.output;`. `print()` and `console.log()` are activity output, not the model-visible result.
- Prefer canonical fields: `command`, `pattern`, `path`, `oldText`, `newText`, `content`.
- Use `tools.list`/`tools.search`/`tools.describe` for discovery. The `pi` namespace is a lazy proxy; do not enumerate it with `Object.keys(pi)`.
- After a `pi.edit` match error, re-read the file and use exact, unique `oldText`, without search-output line prefixes.
- After an invalid search path, locate the directory from an existing parent with `pi.ls` or `pi.find` before retrying; do not batch an unverified path with unrelated calls.
- After a shell syntax error, check both shell quoting and TypeScript escaping. Put escape-heavy command text in top-level `payloads` and pass `π.key` to `pi.bash`.

# Mermaid diagrams (grok-mermaid terminal renderer)
- Pi renders mermaid as terminal box-art via `grok-mermaid`, not full mermaid.js. It draws only these types: `flowchart`/`graph`, `stateDiagram`, `classDiagram`, `erDiagram`, `sequenceDiagram`.
- Keep diagrams narrow so the total render width fits the terminal (80 cols). Prefer `flowchart TD` with short labels over `flowchart LR` with long labels. A 105-wide LR diagram parses cleanly but flips to framed source; the same content as short-label TD renders at ~70 wide and remains drawn as art.
- Wrap node labels containing `()`, `<>`, `/`, `.`, or `<br>` in double quotes: `A["foo(bar)<br>baz"]`. Use `<br>`, not `<br/>`.
- Labels wrap at 24 cols, up to 4 lines. Edge labels truncate at 28 cols. Shorten labels instead of relying on wrapping.
- During streaming, short prefixes draw as art, then the finished wide diagram falls back to source. That flash-then-break means the diagram is too wide, not that it has a syntax error. Narrow the diagram.