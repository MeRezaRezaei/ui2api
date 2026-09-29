# Probe A — non-browser wire surface of promptd (`http://127.0.0.1:9797`)

All probes: `timeout -k 5 25 curl ...`. **No timeouts fired (no exit 124).**
Runner: `src/prompt/openai.ts`. Daemon date header: `Tue, 29 Sep 2026 10:19:44 GMT`.

## Table

| # | endpoint | status | code | type | verdict |
|---|---|---|---|---|---|
| 1 | `GET /v1/models/gemini` | 404 | `not_found` | `invalid_request_error` | ABSENT |
| 2a | `GET /v1/models/ui2api%2Fkimi` | 404 | `not_found` | `invalid_request_error` | ABSENT (also no provider-prefixed ids exist: all 22 ids are bare, e.g. `kimi`) |
| 2b | `GET /v1/models/nope` | 404 | `not_found` | `invalid_request_error` | ABSENT |
| 3 | `POST /v1/embeddings` | 404 | `not_found` | `invalid_request_error` | ABSENT |
| 4 | `POST /v1/audio/speech` | 404 | `not_found` | `invalid_request_error` | ABSENT |
| 5 | `POST /v1/audio/transcriptions` | 404 | `not_found` | `invalid_request_error` | ABSENT |
| 6 | `POST /v1/completions` (legacy) | 404 | `not_found` | `invalid_request_error` | ABSENT |
| 7 | `POST /v1/chat/completions` malformed JSON | 400 | **(none)** | `invalid_request_error` | PRESENT (envelope INCOMPLETE — see below) |
| 8 | `POST /v1/chat/completions` unknown model | 404 | `unknown_model` | `invalid_request_error` | PRESENT (full envelope) |
| 9 | `GET /v1/chat/completions` (wrong method) | 404 | `not_found` | `invalid_request_error` | ABSENT (no 405) |
| 10 | `GET /v1/models` | 200 | — | — | PRESENT, 22 entries |
| 11 | `GET /v1/models` headers | 200 | — | — | PRESENT (below) |
| 12 | code grep | — | — | — | no handler for 3,4,5,6,1,2 |

## Rows 7 & 8 — exact envelopes

Row 7 (`{"model":"gemini",` — truncated), HTTP **400**:

```json
{"error":{"message":"request body is not valid JSON","type":"invalid_request_error","param":null}}
```

**`error.code` is ABSENT here** while rows 1–6/9 have `code:"not_found"`. Same omission in
the `messages` guard (row: empty messages) — `openAiError2()` at
`src/prompt/openai.ts:655` and the inline 400 at `src/prompt/openai.ts:695-698` both
emit `{message, type, param}` with no `code`. An OpenAI client reading `err.code` gets
`None`; it survives because the HTTP status carries the meaning.

Row 8, HTTP **404**:

```json
{"error":{"message":"unknown site \"does-not-exist\" — try one of gemini, chatgpt, claude, copilot, perplexity, huggingchat, kimi, deepseek, tencent-aistudio, hunyuan, blackbox, codex, copilot-m365, duckduckgo, grok, inner-ai, manus, notion, poe, t3chat, v0, venice","type":"invalid_request_error","code":"unknown_model","param":"model"}}
```

All four OpenAI error fields present. Note `hunyuan` is still listed in this hint while
`google-ai-search` is not (GOAL 147).

## Row 11 — response headers

```
HTTP/1.1 200 OK
Content-Type: application/json
Date: Tue, 29 Sep 2026 10:19:44 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked
```

No `x-request-id`, no `openai-organization`, no `openai-version`, no `x-ratelimit-*`,
no `Access-Control-Allow-Origin` (so browser JS on another origin cannot read `/v1/models`).

## Row 10 — `/v1/models` full dump (analysis)

- top-level keys: `['capabilitiesVersion', 'data', 'object']`
- **COUNT: 22** entries
- entry keys (identical on ALL 22 — `ALLKEYSETS` is a single-element set):

```
created, id, loginRequired, object, owned_by, parent, permission,
provenance, requiresRealBrowser, root, site, status, streaming,
streamingMode, toolCallProvenanceField, toolCallShape, toolMechanisms,
tools, url, verified
```

- `entry[0]` verbatim:
  `{"id":"gemini","object":"model","created":0,"owned_by":"ui2api","permission":[],"root":"gemini","parent":null,"site":"Gemini (gemini.google.com)","url":"https://gemini.google.com","loginRequired":true,"streaming":true,"streamingMode":"replay","tools":"soft","status":"verified","provenance":"builtin","verified":{"since":...,"evidence":...,"via":...,"scope":...},"requiresRealBrowser":false,"toolCallShape":"openai.function_call","toolMechanisms":["soft"],"toolCallProvenanceField":"choices[0].ui2api.toolCall.mechanism"}`
- `created` is the literal integer `0` on every entry — `src/prompt/openai.ts:627` hardcodes `created: 0`. **Not a real timestamp** (epoch 1970-01-01).

### Fields a conventional OpenAI client needs that are ABSENT

| field | status | evidence / consequence |
|---|---|---|
| `created` as a real UNIX ts | **present but fake** (`0`) | `openai.ts:627` — any client sorting/filtering models by recency sees epoch 0 for all 22 |
| `context_window` / `max_input_tokens` | ABSENT | no client can size prompts; `max_tokens` sent by clients is **silently ignored** — grep shows no `body.max_tokens` read anywhere in `openai.ts` |
| `capabilities` object | ABSENT (flat, non-OpenAI keys instead) | `tools` is the STRING `"soft"`, not an array; `loginRequired`/`status`/`verified`/`streamingMode`/`toolCallShape`/`toolMechanisms` are bespoke |
| `permission` | present but always `[]` | OpenAI clients that filter on `permission` may hide all models |
| `deprecated`/`in_use` | ABSENT | minor |
| `object` | present (`"model"`) | correct |
| `owned_by` | present (`"ui2api"`) | fine |

### Route-vs-convention gaps

- No `GET /v1/models/{id}` (row 1) — the single-model fetch is a very common client call and it 404s.
- No `GET /v1/models` provider-namespacing, so the `ui2api/kimi` form (row 2a) has nothing to resolve.
- No `POST /v1/completions` (row 6), `/v1/embeddings` (3), `/v1/audio/*` (4, 5).
- Wrong method yields **404, not 405** (row 9); the fallback at `openai.ts:976-982` is deliberately terminal so no `/v1/*` request can hang — the honest trade documented in the comment at `openai.ts:968-975`.

## Row 12 — code grep

```
src/prompt/openai.ts:969:  // response. An unmatched path (any /v1/embeddings, /v1/completions, a wrong
src/capabilities/venice.ts:327:      method: "api-path (POST /api/v1/audio/queue)",
src/capabilities/venice.ts:330:        "not executable yet — ground truth: POST https://api.venice.ai/api/v1/audio/queue with "
```

No handler exists for rows 1–6. The only `v1/embeddings`/`v1/completions` mentions in
`src/` are a comment (openai.ts:969) and a comment/doc string in venice.ts. The
`/v1/audio/queue` hits are the remote venice.ai API, not this daemon.
