# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.
- Read files with offset/limit instead of reading whole large files.

# Web and documentation tools (MCP, inside fabric_exec)
- Use these MCP tools for web/docs lookups — not curl/wget (shell HTTP is fallback only; say why):
- `mcp.exa.web_search_exa({query, numResults?})` — web search. Returns `{text: string}` (a pre-rendered "Title / URL / Published / Highlights" blob, not a results array). Read `.text`; never `.results`.
- `mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})` — fetch pages; `urls` is an array, never `{url}`. Returns `{text: string}` (concatenated markdown of every page); read `.text`.
- MCP returns: assume `{text}` or MCP `content[]`, not SDK/REST shapes (no `.results`, `.data`, `.items`). If unsure, return `JSON.stringify(res).slice(0, 1500)` once to inspect — never map/access a guessed field.
- Probe once, then extract: one failed call = one shape probe; the very next call must use what the probe showed. Never re-guess a shape a previous result already revealed, never `JSON.stringify`-probe the same tool twice, and never repeat an identical call body.
- `mcp.context7['resolve-library-id']({libraryName, query})` then `mcp.context7['query-docs']({libraryId: '/org/project[/version]', query})` — library/API docs before web search; one topic per query; hyphenated names need bracket access (or `tools.call({ref, args})`).
- Any other `mcp.*` tool: `await tools.describe({ref})` first, match `inputSchema` exactly (extra/missing props get rejected). After "Invalid arguments": describe and fix — never re-guess.

