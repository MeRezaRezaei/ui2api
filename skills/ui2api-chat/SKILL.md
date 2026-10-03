---
name: ui2api-chat
description: >-
  Use when you must TALK to an AI chat website through ui2api's chat surface —
  pick a model, send a prompt, read the answer, choose a vault account — over
  `POST /prompt`, `POST /v1/chat/completions`, `GET /v1/models`, or
  `npx tsx src/cli.ts prompt`. Load BEFORE calling a chat endpoint, and BEFORE
  promising a user an answer. Not for non-chat tools (search, upload,
  transcripts, posting) — that is `ui2api-capabilities`.
---

# ui2api chat surface

You are on the **other side of an HTTP API**. ui2api drives a real logged-in
browser page and reads the site's rendered answer; it never synthesises
traffic. Everything here is what the code does — you do not need this repo.
**One law: a returned answer is real, an absent answer is NAMED. Never invent one.
Never retry a named failure — report the reason verbatim.**

## Copy-paste: readiness → models → prompt → answer

```bash
curl -s http://127.0.0.1:9797/status       # 1. up? always 200, real posture
curl -s http://127.0.0.1:9797/v1/models | jq -r '.data[].id'   # 2. DERIVE models
curl -s -X POST http://127.0.0.1:9797/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gemini","messages":[{"role":"user","content":"reply: PONG"}]}'
curl -s -X POST http://127.0.0.1:9797/prompt -H 'content-type: application/json' \
  -d '{"site":"gemini","prompt":"reply: PONG"}'     # same, ui2api-native
npx tsx src/cli.ts prompt "reply: PONG" --site gemini   # no daemon: one-shot
npx tsx src/cli.ts promptd          # start it; CLI model list: prompt --sites
```

Daemon default `127.0.0.1:9797`, loopback-only when no token is set (`src/cli.ts:1206`, `src/prompt/http.ts:991`). With `UI2API_PROMPTD_TOKEN` set, EVERY call needs `Authorization: Bearer <token>` or you get `401 {"error":"unauthorized"}` (`src/prompt/http.ts:1087`).

Derive live state; never trust a count in this file.

## Endpoint cheat — field names are the code's

| route | request | response |
| --- | --- | --- |
| `POST /prompt` | `site`, `prompt`, `model?`, `account?`, `newChat?` | `ok`, `answer`, `chunkCount`, `doneReason`, `url`, `title`, `citations?`, `model?`; on a wall `ok:false` + `reason` + `restrictions[]` |
| `POST /v1/chat/completions` | `model`, `messages`, `stream?`, `stream_options.include_usage?`, `new_chat?`, `account?`, `tools?` | `choices[0].message.content`, `.finish_reason`, `.refusal`; `usage`; `ui2api.{site,doneReason,chunkCount,url,title}` |
| `GET /v1/models` | — | `data[].id` (+ `site`, `url`, `status`) — only ids the daemon has **measured as answering** (`src/prompt/openai.ts:838`) |
| `GET /sites` | — | `sites[].{id,name,url,loginRequired,status}` |
| `GET /accounts?site=<id>` | query `site` | `{site, host, accounts:[{account, capturedAt, usable?}]}` — `account` is the handle you pass back |
| `GET /status` | — | `ok`, `pool`, `liveness`, `posture`, `bootWarm`; `/health` adds `counts`, `vault`, `stuckness` with a **computed** `ok` |
| `GET /registry` | — | `packages[]`; `chat:{model,streaming}` only for chat packages |

`/v1` ignores `temperature`, `top_p`, `max_tokens`, `seed`, `stop` (reported under
`ui2api.parameters.ignored`, `src/prompt/openai.ts:41`) and **`new_chat` DEFAULTS
TO `true`** (`src/prompt/openai.ts:1030`) — send `"new_chat": false` to continue
a thread.

## Fresh answers — two sentences, do not misread

The pool REUSES warm pages, so before each ask the driver snapshots the answer region as a baseline and judges only text NEW since that baseline — the answer you get back answers *your* prompt, never the previous prompt's still-mounted answer (`src/prompt/driver.ts:588`, `src/runtime/dom-primitives.ts:183`). So do NOT add your own "wait for it to change" logic and do NOT retry on an unchanged answer: a no-growth read is refused as stale, never echoed to you (`src/runtime/dom-primitives.ts:386`, `test/readback-freshness.test.ts`).

## Model selection is verified, never assumed

`model` is not a hint. ui2api opens the site's picker, requires the model in the observed list, clicks the **exact** row (exact first; substring last, precisely so it cannot click "Pro" for "Pro 2"), then reads the selected state back and REFUSES if it did not take — there is no silent wrong-model path (`src/prompt/driver.ts:820`). Never paper over a failure: report `model "<name>" did not take`.

## Streaming is a replay, not a live stream

`stream:true` sends SSE, but the answer is **already finished** before the first frame: the driver waits for the rendered answer to stop growing, then replays it in chunks and ends with `data: [DONE]` (`src/prompt/openai.ts:45`, `:1230`). Honest — real page text — but token timings are cosmetic. **Do not promise a user live token-by-token generation.**

## Multi-account

`account` (or `--account`) takes the exact handle from
`GET /accounts?site=<id>`; omit it or pass `"default"` for the legacy shared
session. Resolution is **exact** — no alias folding, no "first account" fallback
(`src/prompt/http.ts:835`). Unknown account → **400**, before any browser launches,
`{"error":{"code":"no_stored_account","message":"account \"<acct>\" is not available for <host>; send the request without \"account\" to use the default account, or pass an id from GET /accounts?site=<host>"}}`
— it deliberately does **not** list the other stored identities
(`src/prompt/consumer-surface.ts:632`). Fix: take a handle from
`GET /accounts?site=<id>`, check `usable`. Do NOT retry as-is.

## Pacing floor — do not hammer

Per site the pool refuses to send again until the floor passes
(`src/prompt/pool.ts:699`). Floor `1500` ms (`UI2API_DEFAULT_MIN_INTERVAL_MS`,
`src/prompt/pool.ts:457`); per-site override is a JSON object keyed by site id
(`UI2API_SITE_MIN_INTERVAL_MS`, `src/prompt/pool.ts:447`). An unlisted site — or a
malformed value — falls back to the default, never to zero. **Why it matters:** a
free pool slot is not permission to send, a hammering agent loop is exactly what
trips a site's anti-bot stack, and a challenge on a real logged-in account is
unrecoverable. Send once, read, pace yourself.

## Named failures — what to do, never to do

| you see | do | NEVER |
| --- | --- | --- |
| `ok:false` + `doneReason:"restricted"` + `restrictions[]` (`kind`,`matched`), or `finish_reason:"content_filter"` on `/v1` | report it — paywall / plan limit / login | retry-loop it; invent an answer; call it a model failure |
| `ok:false`, answer absent | report the named reason verbatim | fabricate or paraphrase into an answer |
| `unknown_model` / `model_not_found` | `GET /v1/models`, pick from the list | guess an id |
| `model_withheld` (+`withheldClass`) | daemon hasn't measured it answering; use `/capabilities/<id>` | call it an error |
| `not_chat` — `"<id>" is installed and serves POST /capability/<id>` | use `POST /capability/<id>` | keep asking `/prompt` |
| `no_stored_account` | take a handle from `GET /accounts?site=<id>` | retry the same account |
| `pool_saturated` / `pool_queue_timeout` (503) | back off, retry once | tight-loop it |
| `request_timeout` (504) | raise `UI2API_REQUEST_TIMEOUT_MS` or re-scope | assume the answer exists |
| `internal_error` (500) | report it; real text is withheld on purpose | treat as a model problem |
| site answers a challenge / consent wall | stop — wigolo tier, see `ui2api-operate` | retry the plain path |

Full machine-pinned code list: `README.md` → "Error contract — the named
failures". The **code** is the contract; `message` is prose and may change.

## Absence means no chat

A package can be on `/registry` and `POST /capability/<id>` while `chat` is
**absent**. Absent = no chat: key on `pkg.chat?.model`, never `pkg.chat.model`
(`src/prompt/registry.ts:1068`). Resolving today: `gemini`, `kimi`, `deepseek` are
builtins (`src/profile/profile.ts:110`); `duckduckgo` is a packaged-only chat id
(`capabilities/duckduckgo/manifest.json`); `google-ai-search` declares no
`*_chat` capability, so it is not on the chat surface at all.

## Environment knobs

Do **not** learn them here — the authoritative machine-pinned table (purpose,
default, read-site) is **`AGENTS.md`** → "Environment knobs — the full
`UI2API_*` surface". Every knob named in this skill is a row there.
`UI2API_AI_SITE` takes a builtin site id OR a `*.json` profile path; a
`--profile FILE` whose `id` disagrees with `--site` refuses loudly rather than
tuning the wrong site (`src/profile/profile.ts:518`).

## Sibling skills

- **`ui2api`** — entry point: what ui2api is, which model to reach for.
- **`ui2api-capabilities`** — non-chat tools (search, upload, transcripts,
  posting) on `POST /capability/<site>`.
- **`ui2api-operate`** — daemon lifecycle, MCP install, headed-posture recovery,
  wigolo when a site challenges you.