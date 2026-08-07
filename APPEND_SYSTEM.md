# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.
- Read files with offset/limit instead of reading whole large files.

# Web and documentation tools
- You have `exa` MCP tools: `web_search_exa` to search the web and `web_fetch_exa` to fetch page content. Use them for any web lookup.
- You have `context7` MCP tools: `resolve-library-id` to find a library and `query-docs` to read its current documentation. Use them for library and API questions before searching the web.
- Do not use `curl`, `wget`, or other shell HTTP calls to fetch web pages or documentation. Fall back to shell HTTP only when the MCP tools cannot do the task, and say why.

