# Rules
- Never run `pi` from bash or any shell tool. If a skill requires an unavailable subagent tool, do the work directly or report that the tool is unavailable.

# Web and documentation tools (MCP, inside fabric_exec)
- Prefer MCP for web/docs lookups. Use Context7 for library/API docs; use TinyFish or Exa for general web search and page fetching. Use shell HTTP only as a fallback, and state why you used the fallback.
- Discover unfamiliar tools with `await tools.search({query: "tinyfish", limit: 5})` (replace `"tinyfish"` with the server or capability needed). Results include `ref`, `description`, and `inputSchema`. Use returned refs rather than inventing tool names. If a tool's schema is missing or unclear, run `await tools.describe({ref})` before calling that tool.
- Call known tools as `mcp.<sanitized_server>.<sanitized_tool>(args)`; replace hyphens with underscores (for example, `mcp.context7.resolve_library_id`). For a ref returned by discovery, use `await tools.call({ref, args})`. These are calls inside `fabric_exec`, not separate model tools.
- Pass arguments that match `inputSchema`. Include every field listed in `required`, even when that field also has a default. After an argument-validation error, describe the tool again and correct the arguments before retrying. Reuse schemas already inspected in this session unless the tool changes or validation fails.
- TinyFish: discover `mcp.tinyfish.search` and `mcp.tinyfish.fetch_content`. Search accepts `{query}`. The current fetch schema requires `{urls: [url], format: "markdown", links: false, image_links: false, page_metadata: false}`. Inspect its response before extracting fields; do not assume Exa's response shape. Usage-history and wallet tools are not search/fetch readiness checks.
- Exa: `mcp.exa.web_search_exa({query, numResults?})` returns `{text: string}` containing a rendered search summary, not a results array. Read `r.text`, never `r.results`. `mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})` returns page markdown in `r.text`; pass `urls`, not `url`.
- For library/API docs, call `mcp.context7.resolve_library_id({libraryName, query})`, then `mcp.context7.query_docs({libraryId, query})`, before web search. Pass the library ID returned by `resolve_library_id` as `libraryId` to `query_docs`. Send one topic per query.
- MCP response shapes differ from SDK/REST examples. When the response shape is unknown, first return `JSON.stringify(r).slice(0, 1500)` once, then extract fields. Reuse the observed shape. After a shape error, inspect once and correct the field access. Call `JSON.parse` only on JSON strings, never on already-structured objects.
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