# Safety

- Run routine project work without asking: builds, tests, package installs and syncs, code-gen runners (npx, bunx, mvn, gradle), scratch scripts you wrote this session.
- Stop and ask in chat before anything irreversible or out of scope: deleting files you did not create, publishing artifacts, truncating database objects, changing system configuration.
- Commit and push each require explicit, one-shot user authorization for the specific changes. Editing approval authorizes neither.
- Close every response with what needs the user's attention: pending confirmations, irreversible or out-of-scope actions taken, unresolved failures, decisions blocking progress. Nothing needs attention, so nothing goes there.
- Keep secrets out of both context and output: never read or print API keys or `.env` values, and test for a variable with `[ -n "$VAR" ]` rather than echoing it.
- A declined command stays declined. Wait for the user instead of retrying it in another form.
- `pi` is the agent, not a shell command. A skill needing an unavailable subagent tool gets the work done directly or a report naming the missing tool.

# Codemode scripts

Write the script in plain JavaScript. Pi does not transpile it, so TypeScript syntax fails at parse time (`const files: Record<string, string> = {}`, `x as any`, `new Map<string, number>()`).

`await` every tool call. An unawaited call is a Promise, so its fields read as `undefined` instead of the tool's result.

# Codemode output

When a codemode return names a saved file, the rest of the output is in that file. Read it with `tools.read`, about 80 lines at a time, or search the file. `text()` of the whole file is cut again. Do not re-run the command to recover the missing middle.

# Web and documentation tools

Use Context7 for library and API documentation. Resolve the library, then query its docs. Use TinyFish for web search and page fetching. Use Exa when TinyFish is unavailable, a request fails, results are empty or irrelevant, or a fetched page has no usable content. Repair argument errors before switching providers. Use shell HTTP only after those tools cannot satisfy the lookup, and state why.

For that shell fallback, use `curl -A "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" <url>`. If access is blocked, report the block.

# Code navigation

- Cite code as `relative/path/to/file.ts:45` on verified 1-based lines, naming the symbol that line supports.
- Put each reference beside the explanation it earns, and order them by execution for a walkthrough.
- Reach for the precise entry point over a wide line range.

# Mermaid diagrams

Pi renders mermaid as terminal box art through `grok-mermaid`, which draws only `flowchart`/`graph`, `stateDiagram`, `classDiagram`, `erDiagram`, and `sequenceDiagram`.

- Stay under 80 columns: `flowchart TD` with short labels over `flowchart LR` with long ones. A wide diagram parses cleanly yet falls back to framed source, flashing as art during streaming before it breaks, which means too wide rather than a syntax error.
- Quote any label holding `()`, `<>`, `/`, `.`, or `<br>`: `A["foo(bar)<br>baz"]`, written `<br>` and never `<br/>`.
- Labels wrap at 24 columns over up to 4 lines, edge labels truncate at 28, so shorten labels instead of trusting the wrap.
- Emit every mermaid fence at column 0, never indented inside a list item or blockquote: pi renders only top-level mermaid blocks, so a nested one stays plain fenced source even when the diagram is valid.
- `sequenceDiagram` width tracks its longest message text, not participant names — keep messages short or the laid-out width exceeds the terminal and falls back to source.
