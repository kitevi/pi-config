# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.

# Web and documentation tools (MCP via pi-mcp-adapter)
- Use these MCP tools for web/docs lookups — not curl/wget (shell HTTP is fallback only; say why).
- Single calls: `mcp({ tool: name, args })` or `mcp__<server>({ tool, args })`. Discover: `mcp({ search })`; schemas: `mcp({ describe: name })`. Multi-call orchestration: `mcpScript` with `await tools.search({query})` / `tools.describe({path})` / `tools.call(path, args)`.
- Tool names are qualified flat names: `exa_web_search_exa({query, numResults?})`, `synthetic-web-search_search_web({query, max_text_length?})`, `context7_resolve-library-id`, `context7_query-docs`. Bare names like `search` fail with "tool not found" — search/describe, never guess. Inside `mcp__<server>` proxies and `includeTools` filters, use the underlying name (`web_search_exa`).
- Result shapes: model-level calls return text content you read directly (outputGuard truncates large output). In `mcpScript`, `tools.call` resolves `{ ok, data }` or `{ ok: false, error }` — check `ok` first; `data` is the raw MCP result `{ content: [{ type: "text", text }] }`. synthetic-web-search's `text` holds a JSON array of results — `JSON.parse(data.content[0].text)`.
- context7 is strictly two-step: `resolve-library-id({libraryName, query})` before `query-docs({libraryId: '/org/project[/version]', query})`.
- Probe once, then extract: after "Invalid arguments" or a shape surprise, describe/inspect once and fix — never re-guess.
