# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.
- Keep repository code and orchestration separate: repository files may use any language; `fabric_exec.code` uses the configured Monty Python kernel.

# Web and documentation tools
- Prefer MCP for web/docs lookups. Use shell HTTP only as a fallback and explain why.
- `await mcp.exa.web_search_exa(query="...", numResults=5)` returns a dict whose `text` is a rendered search summary, not a results array. Read `r["text"]`.
- `await mcp.exa.web_fetch_exa(urls=["..."], maxCharacters=10000)` returns concatenated page markdown in `r["text"]`. The argument is `urls`, not `url`.
- `await mcp.synthetic_web_search.search_web(query="...", max_text_length=1000)` is preferred for privacy-sensitive queries or when Exa's features aren't needed. Its `r["text"]` contains a JSON array: decode with `import json` and `json.loads(r["text"])`. Each result has `url`, `title`, `text`, `highlights`, and optional `published` (omitted when unknown).
- For library/API docs, first use `await tools.call(ref="mcp.context7.resolve-library-id", args={"libraryName": "...", "query": "..."})`, then `await tools.call(ref="mcp.context7.query-docs", args={"libraryId": "...", "query": "..."})`. One topic per query; use web search afterward if needed.
- For other MCP tools, use `await tools.describe(ref="...")` first and match `inputSchema`. After an argument-validation error, describe and correct the call rather than guessing again.
- MCP response shapes differ from SDK/REST examples. If unknown, return a bounded inspection (about 1500 characters) before extracting fields. Retain the observed shape; after a shape error, inspect once and correct it. Decode JSON strings only, not already-structured dicts/lists.
- For shell web-fetch fallback, use the documented user-triggered fetcher UA: `curl -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" <url>`. Report access blocks rather than repeatedly retrying.

# Tool edge cases and recovery
- Prefer canonical argument fields: `command`, `pattern`, `path`, `oldText`, `newText`, `content`.
- `print()` is activity output; explicitly return evidence the model needs to inspect.
- Discover capabilities through `tools`; `pi` is a lazy namespace, not an enumerable catalog.
- After a syntax error, fix the reported source before retrying.
- After a `pi.grep` regex error, use `literal=True` for exact text; pass escape-heavy regex patterns through top-level `payloads`.
- After a `pi.edit` match error, re-read the file and use exact, unique `oldText`, without search-output line prefixes. Use `all=True` only when every occurrence should change.
- After an invalid search path, locate the directory from an existing parent with `pi.ls` or `pi.find` before retrying.
- After a shell syntax error, inspect the command after Python string escaping; quote shell metacharacters or pass the command through top-level `payloads`.