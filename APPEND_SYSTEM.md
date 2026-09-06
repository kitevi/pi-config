# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.

# Web and documentation tools (MCP, inside fabric_exec)
- Prefer MCP for web/docs lookups. Use shell HTTP only as a fallback and explain why.
- `mcp.exa.web_search_exa({query, numResults?})` returns `{text: string}` containing a rendered search summary, not a results array. Read `r.text`, never `r.results`.
- `mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})` returns page markdown in `r.text`. Pass `urls`, not `url`.
- Prefer `mcp.synthetic_web_search.search_web({query, max_text_length?})` for privacy-sensitive queries or when Exa's features aren't needed. Its `r.text` contains a JSON array: use `JSON.parse(r.text)`. Results have `url`, `title`, `text`, `highlights`, and optional `published` (omitted when unknown).
- For library/API docs, use `mcp.context7['resolve-library-id']({libraryName, query})`, then `mcp.context7['query-docs']({libraryId, query})` before web search. Use the returned library ID; one topic per query.
- For other MCP tools, first `await tools.describe({ref})` and match `inputSchema`. After an argument-validation error, describe and correct the call rather than guessing again.
- MCP response shapes differ from SDK/REST examples. If unknown, return `JSON.stringify(r).slice(0, 1500)` once before extracting fields. Retain the observed shape; after a shape error, inspect once and correct it. Parse JSON strings only, not already-structured objects.
- For shell web-fetch fallback, use `curl -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" <url>`. Report access blocks rather than retrying with other identities.

# Small-model guardrails
- Await a tool call before accessing its result: `const r = await pi.bash({command: "pwd"}); return r.output;`. `print()` and `console.log()` are activity output, not the model-visible result.
- Prefer canonical fields: `command`, `pattern`, `path`, `oldText`, `newText`, `content`.
- Do not enumerate `pi` with `Object.keys(pi)`; it is a lazy proxy. Use `tools.list`/`tools.search`/`tools.describe` for discovery.
- After a `pi.edit` match error, re-read the file and use exact, unique `oldText`, without search-output line prefixes.
- After an invalid search path, locate the directory from an existing parent with `pi.ls` or `pi.find` before retrying; do not batch an unverified path with unrelated calls.
- After a shell syntax error, check both shell quoting and TypeScript escaping. Put escape-heavy command text in top-level `payloads` and pass `π.key` to `pi.bash`.