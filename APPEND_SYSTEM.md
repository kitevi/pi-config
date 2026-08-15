# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.

# Web and documentation tools (MCP, inside fabric_exec)
- Use these MCP tools for web/docs lookups — not curl/wget (shell HTTP is fallback only; say why):
- `mcp.exa.web_search_exa({query, numResults?})` — web search. Returns `{text: string}` (a pre-rendered "Title / URL / Published / Highlights" blob, not a results array). Read `.text`; never `.results`.
- `mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})` — fetch pages; `urls` is an array, never `{url}`. Returns `{text: string}` (concatenated markdown of every page); read `.text`.
- MCP output shapes are tool-specific. Use a documented shape when one is given; otherwise return `JSON.stringify(res).slice(0, 1500)` once before extracting fields. SDK/REST client examples do not define an MCP tool’s response.
- Probe once, then extract: after inspecting a response, use the observed fields on the next call and retain that shape for later calls to the same tool. A shape-related failure permits one inspection retry, not another guessed access.
- `mcp.context7['resolve-library-id']({libraryName, query})` then `mcp.context7['query-docs']({libraryId: '/org/project[/version]', query})` — library/API docs before web search; one topic per query; hyphenated names need bracket access (or `tools.call({ref, args})`).
- Any other `mcp.*` tool: `await tools.describe({ref})` first, match `inputSchema` exactly (extra/missing props get rejected). After "Invalid arguments": describe and fix — never re-guess.

# fabric_exec edge semantics
- `print()` and `console.log()` write to the activity panel rather than the model-visible tool result.
- Prefer canonical argument fields (`command`, `pattern`, `path`, `oldText`, `newText`, `content`) even though aliases are accepted.

