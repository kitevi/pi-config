# Rules
- Ask one short question only when plausible interpretations require different implementations. Otherwise choose the most likely interpretation and proceed.
- Never run `pi` from bash or any shell tool. If a skill needs a subagent tool you do not have, do the work yourself or say it is unavailable.
- Read files with offset/limit instead of reading whole large files.

# Web and documentation tools (MCP, inside fabric_exec)
- Use these MCP tools for web/docs lookups — not curl/wget (shell HTTP is fallback only; say why):
- `mcp.exa.web_search_exa({query, numResults?})` — web search. Returns `{text: string}` (a pre-rendered "Title / URL / Published / Highlights" blob, not a results array). Read `.text`; never `.results`.
- `mcp.exa.web_fetch_exa({urls: string[], maxCharacters?})` — fetch pages; `urls` is an array, never `{url}`. Returns `{text: string}` (concatenated markdown of every page); read `.text`.
- MCP output shapes are tool-specific. Use a documented shape when one is given; otherwise return `JSON.stringify(res).slice(0, 1500)` once before extracting fields. SDK/REST client examples do not define an MCP tool’s response.
- Probe once, then extract: after inspecting a response, use the observed fields on the next call and retain that shape for later calls to the same tool. A shape-related failure permits one inspection retry, not another guessed access.
- `mcp.context7['resolve-library-id']({libraryName, query})` then `mcp.context7['query-docs']({libraryId: '/org/project[/version]', query})` — library/API docs before web search; one topic per query; hyphenated names need bracket access (or `tools.call({ref, args})`).
- Any other `mcp.*` tool: `await tools.describe({ref})` first, match `inputSchema` exactly (extra/missing props get rejected). After "Invalid arguments": describe and fix — never re-guess.

# fabric_exec reliability supplement

Pi Fabric already supplies routine full-code guidance automatically. This
supplement restates canonical forms and edge semantics as a ready reference.
Load the full fabric-exec skill only for advanced APIs or a contract error not
covered here.

Put one type-checked TypeScript program in `fabric_exec.code`. Top-level
`await` and `return` work. Only the returned value enters model context;
`print()` and `console.log()` go to the activity panel. For awkward payloads,
pass top-level `strings` and read them in code as `π.<key>`.

## Prefer canonical pi.* forms
- String results: `pi.read({ path, offset, limit })`,
  `pi.grep({ pattern, path, limit })`, `pi.find({ pattern, path, limit })`, and
  `pi.ls({ path, limit })`.
- Envelope results: `pi.bash({ command, timeout, settle })`,
  `pi.edit({ path, oldText, newText })` or
  `pi.edit({ path, edits: [{ oldText, newText }] })`, and
  `pi.write({ path, content })`. Read their `.output` when only output text is
  needed.

## Additional semantics
- Unbounded `pi.read` stops at 2,000 lines or 50KB. Use `offset` and `limit`.
- Aliases such as `cmd`, `query`, and `file_path` are accepted, but prefer
  canonical fields for consistency.
- For `pi.edit`, omit `all` for a unique anchor. Entry-level `all: true`
  intentionally replaces every non-overlapping occurrence.
- Batch independent calls with `Promise.all`; keep dependent calls sequential.

## Canonical batch
```ts
const [pkg, hits] = await Promise.all([
  pi.read("package.json"),
  pi.grep({ pattern: "TODO", path: "src", limit: 20 }),
]);
return { pkg, hits };
```

