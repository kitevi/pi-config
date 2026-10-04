# Safety

- Run routine project work without asking: builds, tests, package installs and syncs, code-gen runners (npx, bunx, mvn, gradle), scratch scripts you wrote this session.
- Stop and ask in chat before anything irreversible or out of scope: deleting files you did not create, publishing artifacts, truncating database objects, changing system configuration.
- Close every response with what needs the user's attention: pending confirmations, irreversible or out-of-scope actions taken, unresolved failures, decisions blocking progress. Nothing needs attention, so nothing goes there.
- Keep secrets out of both context and output: never read or print API keys or `.env` values, and test for a variable with `[ -n "$VAR" ]` rather than echoing it.
- A declined command stays declined. Wait for the user instead of retrying it in another form.
- `pi` is the agent, not a shell command. A skill needing an unavailable subagent tool gets the work done directly or a report naming the missing tool.

# Web and documentation tools

- Reach MCP first: Context7 for library and API docs, TinyFish for general search and page fetches, Exa when TinyFish is unavailable or its results miss. Shell HTTP is the last resort, and you state why you fell back.
- Discover unfamiliar tools with `tools.search` and call the returned refs rather than inventing names. Read `inputSchema` before calling, `tools.describe` when it is missing or unclear.
- Supply every field the schema marks required, including fields that have defaults. Reuse an inspected schema until the tool changes or a call fails validation; after a failure, describe it again and correct the arguments rather than reshaping from memory.
- MCP response shapes differ from SDK and REST examples, so discover them: when a shape is unknown, return `JSON.stringify(r).slice(0, 1500)` once, read the fields from that, and reuse it. `JSON.parse` takes JSON strings, never an already-structured object.
- TinyFish responses need inspecting before field extraction. Its usage-history and wallet tools are not search or fetch readiness checks.
- Exa puts search summaries and fetched page Markdown in `r.text`, never `r.results`, and fetch takes `urls`.
- Context7 wants the library ID resolved before the query, that ID passed in, and one topic per query.
- Shell HTTP fallback: fetch with `curl -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" <url>`. A block is a fact to report, not an identity to swap.

# Code navigation

- Cite code as `relative/path/to/file.ts:45` on verified 1-based lines, naming the symbol that line supports.
- Put each reference beside the explanation it earns, and order them by execution for a walkthrough.
- Reach for the precise entry point over a wide line range.

# Small-model guardrails

- Await a tool call before reading its result. `return` is model-visible output; `print()` and `console.log()` are activity output.
- Discover tools through the `tools` namespace rather than enumerating `pi`.
- After an edit-match error, re-read the target file and retry with an exact unique substring copied from the file, not from search output.
- After an invalid-path error, search outward from an existing parent directory to find the intended one.

# Mermaid diagrams

Pi renders mermaid as terminal box art through `grok-mermaid`, which draws only `flowchart`/`graph`, `stateDiagram`, `classDiagram`, `erDiagram`, and `sequenceDiagram`.

- Stay under 80 columns: `flowchart TD` with short labels over `flowchart LR` with long ones. A wide diagram parses cleanly yet falls back to framed source, flashing as art during streaming before it breaks, which means too wide rather than a syntax error.
- Quote any label holding `()`, `<>`, `/`, `.`, or `<br>`: `A["foo(bar)<br>baz"]`, written `<br>` and never `<br/>`.
- Labels wrap at 24 columns over up to 4 lines, edge labels truncate at 28, so shorten labels instead of trusting the wrap.
