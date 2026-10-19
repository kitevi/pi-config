# Open Design models (`opendesign`)

Pi reaches Open Design Cloud through a workspace-scoped, OpenAI-compatible
gateway ("AMR", backed by Vela) at `https://amr-link.open-design.ai/v1`.
`models.json` declares it as provider `opendesign`, authenticated by
`$OPENDESIGN_API_KEY`, and `bootstrap.mjs` installs that file wholesale into
`~/.pi/agent/models.json`.

Every fact below was checked against the live endpoint with pi 1.3.0. Re-check
before trusting a number: the gateway is the only authority on its own limits.

## Discover before you write

```sh
curl -s https://amr-link.open-design.ai/v1/models \
  -H "Authorization: Bearer $OPENDESIGN_API_KEY" \
| jq -r '.data[] | [.id, .metadata.context_limit, .metadata.context_budget,
         .metadata.output_budget, (.architecture.input_modalities|join("+")),
         .enabled, .default] | @tsv'
```

| gateway field | use |
|---|---|
| `id` | the `id` in `models.json` |
| `metadata.context_budget` | `contextWindow` |
| `metadata.output_budget` | `maxTokens` |
| `metadata.context_limit` | **not** `contextWindow` — see below |
| `architecture.input_modalities` | `input`, keeping only `text` and `image` |
| `enabled` | `false` means the model is off for this workspace; skip it |
| `default` | the model the workspace picks when none is named |

## The trap: `context_limit` is not the window to record

`deepseek-v4.1-flash` reports `context_limit: 1048000` but
`context_budget: 328000`. The limit is what the model can theoretically hold;
the budget is what this workspace may actually send. Pi sizes its context meter
and compaction from `contextWindow`, so recording 1048000 lets a conversation
grow to roughly 943K before `pi-vcc` compacts — three times past the point where
the gateway starts rejecting. Record the budget.

The same applies to output: `output_budget: 128000` is the real cap, not the
model's nominal maximum.

## Reasoning

`deepseek-v4.1-flash` reasons by default. The gateway accepts
`reasoning_effort` values `none`, `minimal`, `low`, `high`, and `max` (all HTTP
200, with `none` producing zero `reasoning_tokens`). `medium` and `xhigh` are
untested and stay `null` in `thinkingLevelMap`, which makes pi clamp those
levels to the nearest supported one.

Stream deltas carry `reasoning` and `reasoning_details`, and usage reports
`completion_tokens_details.reasoning_tokens` — the OpenRouter shape. Hence:

```json
"compat": { "thinkingFormat": "openrouter" }
```

Two flags from pi's OpenRouter catalog entry are **not** needed here, and were
probed to confirm it: an assistant message replayed without reasoning still
returns 200 (so not `requiresReasoningContentOnAssistantMessages`), and a
`developer` message returns 200 (so not `supportsDeveloperRole: false`). Do not
add compat flags without that kind of probe.

## Do not copy catalog numbers

Pi ships an OpenRouter entry for the same checkpoint
(`deepseek/deepseek-v4.1-flash-1017`) declaring `contextWindow: 1048576` and
`maxTokens: 943718`. Those are OpenRouter's, not this gateway's, and both are
wrong here. What does transfer: `thinkingFormat: "openrouter"`, the modality
list, and `reasoning: true`.

`cost` has no source. The gateway returns tier labels (`metadata.cost: "low"`,
`"medium"`), not per-token rates, so leaving `cost` out makes pi show no price
rather than a fabricated one.

## Naming

Ids carry no checkpoint suffix. The vendor markets
"DeepSeek-V4.1-Flash-1017" and the gateway serves it as `deepseek-v4.1-flash`,
so the marketing name belongs in `name` and the bare id in `id`. The provider
id is `opendesign` — no hyphen, no space — and the key variable is
`OPENDESIGN_API_KEY`, matching how the console labels them.

## Verify

```sh
pi --list-models opendesign                      # registered, limits applied
pi --provider opendesign --model deepseek-v4.1-flash "Reply with exactly: OK"
```

## When the provider is missing from `/model`

The provider is dropped during registration when no credential resolves
(`dist/core/provider-composer.js` throws `no authentication method configured`),
so its absence points at the environment, not the JSON:

- `[ -n "$OPENDESIGN_API_KEY" ] && echo set` in the shell that launches pi. Pi
  snapshots its environment at startup, so exporting afterwards and reloading
  changes nothing, and a desktop launcher never reads shell rc files.
- `pi auth check --provider opendesign` prints `ready` even for a bogus key: it
  proves a credential resolved, not that the gateway accepts it.
- A wrong `id` still registers the provider and fails at request time; a wrong
  `baseUrl` fails the same way. Both surface as request errors, never as a
  missing provider.

## Adding or changing a model

1. Run the discovery command; take `id`, `context_budget`, `output_budget`, and
   the modalities.
2. Add the entry to `models.json`, keeping `apiKey: "${OPENDESIGN_API_KEY}"` so
   the key never enters this repository.
3. Extend `tests/bootstrap.test.ts`, which pins the provider's `baseUrl`, `api`,
   key interpolation, model id, and limits.
4. `npm run setup && npm test`.

The gateway also exposes `openai-responses` at `/v1/responses` and
`anthropic-messages` at `https://amr-link.open-design.ai` (no `/v1`). Both have
live routes — a `POST` without a key returns 401, an unknown route returns 404 —
but neither was exercised with a real request. Chat Completions is the verified
path; switch only if you can test the alternative.
