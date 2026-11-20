# Deploy models (`deploy`)

Pi reaches Deploy through its OpenAI-compatible Chat Completions API at
`https://api-cdn.deploy.com/api/v1`. `models.json` declares it as provider
`deploy`, authenticated by `$DEPLOY_API_KEY`, and `bootstrap.mjs` installs that
file wholesale into `~/.pi/agent/models.json`.

Every fact below was checked against the live endpoint with pi 1.5.2 on
2026-11-15. Re-check before trusting a number: Deploy's own docs disagree with
each other and with the API, so treat the live endpoint as the only authority.

## Discover before you write

```sh
curl -s https://api-cdn.deploy.com/api/v1/models \
  -H "Authorization: Bearer $DEPLOY_API_KEY" | jq -r '.data[].id'
```

`/models` returns only `id`, `created`, `owned_by`, and `shutdown_date`. It
reports no limits, modalities, or prices, so take those from the sources below.

| need | source |
|---|---|
| `id` | `/models` |
| `contextWindow` | the probe below, not the docs |
| `input` | [Models & Pricing](https://docs.deploy.com/models-and-pricing.md), then an image probe |
| `cost` | [Models & Pricing](https://docs.deploy.com/models-and-pricing.md) (USD per million tokens) |
| `thinkingLevelMap` | [Reasoning](https://docs.deploy.com/reasoning.md) |

## Base URL

Deploy serves the same API on several hosts: `api.deploy.com` and
`api-cdn.deploy.com` route to the closest region, and the `-sf1` and `-va1`
hosts pin a region. From this machine, `api-cdn` connects in about 12 ms and
`api` in about 125 ms, with the same time to first byte. The model page uses
`api-cdn`, so this repo uses it too. Switch to `api-va1` only for a
Virginia-only (VA1) account.

## Context window: measure it

The docs say "1 million tokens", and Deploy's harness snippets put
`contextWindow: 1000000` next to output caps of `32768` (OpenCode, Kilo) and
`16384` (Pi), which contradict each other. The gateway enforces something
else: it rejects `prompt_tokens + max_completion_tokens > 1048576` with
`400 "Please reduce the length of the messages or completion"`. With a
35-token prompt, `max_completion_tokens: 1048541` returns 200 and `1048542`
returns 400. Find the boundary by binary search:

```sh
probe() { curl -s -o /dev/null -w '%{http_code}\n' \
  https://api-cdn.deploy.com/api/v1/chat/completions \
  -H "Authorization: Bearer $DEPLOY_API_KEY" -H 'Content-Type: application/json' \
  -d "{\"model\":\"deepseek-ai/deepseek-v4.1-flash-1017\",\"max_completion_tokens\":$1,
       \"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}"; }
probe 1048541   # 200
probe 1048542   # 400
```

So `contextWindow` is `1048576`. Pi clamps each request's `maxTokens` to the
room left in `contextWindow` (`clampMaxTokensToContext` in pi-ai), so the
total limit never surfaces as a 400 if `contextWindow` is right. If you
overstate the window, long sessions start failing before `pi-vcc` compacts.

The gateway has no separate output cap: any `max_completion_tokens` within the
total returns 200. `maxTokens: 384000` is the checkpoint's native output limit,
which pi's `deepseek` and `fireworks` catalogs also record. Do not copy the
harness snippets' `16384` or `32768`: they would cut off long answers at
`max` reasoning effort.

## Reasoning

The model reasons by default (the documented default effort is `high`).
Reasoning arrives as `reasoning_content` on the message and on stream deltas,
and usage reports `completion_tokens_details.reasoning_tokens`. That is the
DeepSeek shape, and pi reads it whatever `thinkingFormat` is set.

Control reasoning with top-level `reasoning_effort`. That is pi's
auto-detected `thinkingFormat: "openai"` for this host, so the entry sets no
`thinkingFormat`. The other request shapes are ignored without an error: the
`deepseek` format's `thinking: {type: "disabled"}` and the `openrouter`
format's `reasoning: {effort: "none"}` both return 200 and still reason.

The gateway does **not** validate `reasoning_effort`. Every label returns 200,
including `"banana"`, so a 200 proves nothing about a level. Only `none`
behaves measurably differently (zero `reasoning_tokens`). The docs list
`none`, `low`, `high`, and `max`, so `thinkingLevelMap` forwards those and sets
`minimal`, `medium`, and `xhigh` to `null`, which makes pi clamp them to the
nearest supported level. With thinking off, pi sends `reasoning_effort: "none"`
from `thinkingLevelMap.off`.

`max_thinking_tokens` is documented, but it did not limit reasoning in a probe:
a cap of 50 still produced 50 reasoning tokens, the same count as no cap. The
entry leaves `thinkingTokenBudgetField` unset.

## Compat: the one flag that is needed

```json
"compat": { "supportsDeveloperRole": false }
```

Pi sends the system prompt as a `developer` message to a reasoning model when
`supportsDeveloperRole` is true, and as `system` otherwise. Before 1.6.0 it
assumed `developer` on any host it didn't recognize; since 1.6.0 it assumes it
only for OpenAI (provider `openai` or a base URL on `api.openai.com`), so Deploy
already gets `system`. The flag pins that against a change in pi's host
detection, because Deploy returns 200 and **ignores a `developer` instruction
silently** while reasoning is on. In 4 of 4 runs, a `developer` message saying
"Always reply in French" got English replies, while the same text as `system`
got French. With `reasoning_effort: "none"`, `developer` was honored. A pi
session that sent `developer` would run with its system prompt mostly ignored
and no error to show it.

Each of these was probed and returned 200, so it needs no override:

- `max_completion_tokens` (pi's auto-detected field) and `max_tokens`, so no
  `maxTokensField`. Deploy's pi snippet sets `maxTokensField: "max_tokens"`,
  which is unnecessary.
- `reasoning_effort`, so keep `supportsReasoningEffort` at its detected
  `true`. Deploy's pi snippet sets it `false`, which would make `off` and every
  level identical.
- `store: false`, `stream_options.include_usage` (a final usage chunk with
  empty `choices`), `prompt_cache_key`, and tools with `strict: true` or
  `strict: false`.
- An assistant message replayed without `reasoning_content`, including a
  tool-call turn followed by a `tool` result. So no
  `requiresReasoningContentOnAssistantMessages`, unlike DeepSeek's own API.
- A `data:image/png;base64` `image_url`. A solid red 32×32 PNG was described as
  "Red", so `input` includes `image`.

## Cost

[Models & Pricing](https://docs.deploy.com/models-and-pricing.md) lists USD per
million tokens: input $0.10, output $0.35, cache read $0.003. Caching is
automatic with no write surcharge, so `cacheWrite` is `0`. Reasoning tokens are
billed as output.

## Naming

`/models` lists the checkpoint as `deepseek-ai/deepseek-v4.1-flash-1017`, and
that is the `id`. The bare `deepseek-ai/deepseek-v4.1-flash` also works but
resolves to the same `-1017` model in the response. Unlike `opendesign`, the
gateway's own id carries the checkpoint, so keep it. The provider id is
`deploy` and the key variable is `DEPLOY_API_KEY`, which is the name Deploy's
docs use.

## Limits and errors

- 5 requests/second per organization by default; above that the gateway
  returns `429 {"message":"Too Many Requests"}`. Parallel subagents hit this
  quickly.
- `405` means the organization's credit balance is not positive.
- `401` means the key is invalid or expired.

## Verify

```sh
pi --list-models deploy
pi --provider deploy --model deepseek-ai/deepseek-v4.1-flash-1017 "Reply with exactly: OK"
```

## When the provider is missing from `/model`

As with `opendesign`, pi drops a provider whose credential doesn't resolve.
Check `[ -n "$DEPLOY_API_KEY" ] && echo set` in the shell that launches pi. Pi
reads its environment once at startup, so exporting the key later and
reloading has no effect.

## Adding or changing a model

1. List ids with the discovery command. Take limits from the boundary probe,
   and price and modalities from Models & Pricing.
2. Add the entry to `models.json` with `apiKey: "${DEPLOY_API_KEY}"` and
   `compat.supportsDeveloperRole: false`. Re-run the developer-vs-system probe
   for the new model before you drop that flag.
3. Extend `tests/bootstrap.test.ts`.
4. `npm run setup && npm test`.
