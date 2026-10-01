# Integrating an OpenAI client with ui2api

`ui2api` exposes an OpenAI-compatible chat surface at `/v1` so any OpenAI
client (or any router) can treat a real logged-in chat website as a model
provider. The surface is:

- `GET /v1/models` — the chat sites this daemon can serve
- `GET /v1/models/<id>` — the same single entry the list would contain
- `POST /v1/chat/completions`

Everything else under `/v1` answers `404` with `error.code === "not_found"`.

- Base URL: `http://127.0.0.1:9797/v1` (the daemon binds loopback only)
- Port: `UI2API_PROMPTD_PORT`, default `9797`
- Auth: the one env var is `UI2API_PROMPTD_TOKEN`. Unset ⇒ localhost-only, no
  header. Set ⇒ every call sends `Authorization: Bearer <token>`.

## Discover the truth at runtime

Do not hardcode a model list. `GET /v1/models` returns
`{ object: "list", capabilitiesVersion: 1, data: [...] }`, and each entry carries
a **derived** capability block at the top level:

| field | meaning |
| --- | --- |
| `status` | `verified` / `unverified-candidate` / `builtin` / `dormant` / `dead-end` |
| `provenance` | `builtin` (built-in profile) or `packaged` (installed capability package) |
| `verified` | the package's real verification record, or `false` — never synthesised |
| `requiresRealBrowser` | the site is only driveable with a real logged-in browser |
| `streaming` / `streamingMode` | `true` / `"replay"` — see Class D |
| `tools` | `native` / `soft` / `none` |
| `toolMechanisms[]` | every mechanism this site can reach, strongest first |
| `toolCallProvenanceField` | the path carrying provenance on a returned call |

### THE LIST IS A PROMISE, AND THE RESPONSE SAYS HOW BIG IT IS

`data` lists only models this daemon has **measured answering** — a real round
trip returned HTTP 200 with real answer text. The full catalogue of installed
sites is NOT on this list, and that is deliberate: a consumer that materialised
one provider per advertised id must not build twenty providers that cannot answer.

So the response also carries the honest count. Read it — it is the difference
between "this service offers 4" and "this service hides 18":

| field | meaning |
| --- | --- |
| `advertisement.offered` | how many models are in `data` |
| `advertisement.addressable` | how many of this daemon's sites are driveable at all |
| `advertisement.withheld` | how many are driveable but **not** advertised |
| `advertisement.withheldByClass` | the measured class of each withheld model |
| `advertisement.record` / `recordGeneratedAt` / `recordAgeDays` | the dated record the promise is derived from |
| `withheld[]` | each withheld model: `{ model, class, reason }` |

The classes, and the action each one names. A `class` on a withheld model is one
of two different things, and the table below marks which is which: a **measured
class** is a member of the record's own nine-member vocabulary (the same list as
`VERIFICATION_CLASSES` in `src/prompt/verification-class.ts`, which is where the
classifier and its per-class preconditions live), while a **reader sentinel** is
emitted by the serving code, never appears in the record, and means the record
had nothing to say.

| class | kind | what was measured | what the action is |
| --- | --- | --- | --- |
| `ANSWERS` | measured | HTTP 200 with real answer text | advertised on `/v1/models` |
| `SIGN-OUT` | measured | a named 502 saying sign-in is required (or the page that landed IS a login page) | a human logs in; not a code fix |
| `WALL-CHALLENGE` | measured | a named 502 at an idle pool on an anti-bot interstitial (Cloudflare, Vercel checkpoint) | the wigolo bypass tier, never a retry loop |
| `COMPOSER-DRIFT` | measured | a named 502 at an idle pool on a loaded page with no composer | the site's profile/selector needs a retune |
| `CONTENDED-TIMEOUT` | measured | no response while the pool was NOT idle | a queue fact, never a property of the model |
| `NON-ANSWER-READ` | measured | a 2xx at an idle pool carrying text the service itself reports is NOT the answer | find which node the site served that text from, retune the profile against a capture — never `ANSWERS` |
| `ANSWER-UNREADABLE` | measured | the service reports the answer selector matched ZERO nodes in a page that did load | retune the answer selectors from a capture; the DRIVER cannot read this model, which is not the model failing to answer |
| `UNATTRIBUTED-NO-ANSWER` | measured | the service's own no-answer refusal at an idle pool with no page — it names its candidate causes (busy, rate-limiting, sign-in/consent wall) and asserts NONE of them | re-measure with a discriminator that separates those causes; it licenses **no** diagnosis, so not "rate-limited", not "log in", not contention |
| `UNMEASURED` | measured | no class was established | measure it |
| `NO-RECORD` | **reader sentinel** | nothing — the record carries no entry for this model, or its `class` field is empty | measure it |

`NO-RECORD` is NOT a tenth class and is deliberately not in the record's
vocabulary. It is a string this daemon emits on `withheld[].class` when there
was no measurement to report, so a consumer can tell "measured and refused" from
"never looked at" without the two collapsing into one bucket. Treat it as the
absence of a class, not as a class.

A **withheld** model is not a deleted one. It stays fully reachable:
`GET /registry`, `GET /sites` and `POST /capability/<site>` all still serve it,
and on `/registry` it keeps its `tools[]` and `status` while carrying **no**
`chat` key and a `chatWithheld: { class, reason }` in its place. Asking for it by
name — `GET /v1/models/<id>` — answers `404` with `error.code === "model_withheld"`
and the reason, which is deliberately NOT `unknown_model`: the model exists, the
measurement says it could not answer, and those are different statements.

If the record itself cannot be read, `/v1/models` answers `503`
`model_verification_unreadable` and advertises nothing. A promise with no
measurement behind it is worse than no promise.

`model` accepts the site id, `ui2api/<site>`, or `ui2api-<site>` — all resolve to
the same site. An unknown one is `404` with `error.code === "unknown_model"`.

## Minimal client (TypeScript)

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://127.0.0.1:9797/v1",
  apiKey: process.env.UI2API_PROMPTD_TOKEN ?? "not-used", // bearer when gated
});

// 1. non-streaming
const r = await openai.chat.completions.create({
  model: "kimi",
  messages: [{ role: "user", content: "Say PONG and nothing else." }],
});
console.log(r.choices[0].message.content, r.choices[0].finish_reason);

// 2. streaming (SSE replay — see Class D)
const s = await openai.chat.completions.create({
  model: "kimi",
  messages: [{ role: "user", content: "Say PONG." }],
  stream: true,
});
for await (const part of s) process.stdout.write(part.choices?.[0]?.delta?.content ?? "");

// 3. tool calling — read tools/toolMechanisms from /v1/models first.
//    NOTE: this `tools` array is the SOFT mechanism and only fires on
//    `soft` sites with tool_choice:"auto". On a `native` site (kimi) the call
//    comes from the SITE running its own tool, and this array is not what
//    produces it — it is there so the site has a web-search-capable composer.
//    Use a `soft` site if you want the array below to be the source of the call.
const t = await openai.chat.completions.create({
  model: "kimi",
  messages: [{ role: "user", content: "Search the web for ui2api." }],
  tools: [
    {
      type: "function",
      function: {
        name: "kimi_web_search",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    },
  ],
  tool_choice: "auto",
});
console.log(t.choices[0].message.tool_calls, (t.choices[0] as any).ui2api?.toolCall);
```

Extra request fields beyond the OpenAI schema: `new_chat` (boolean) and
`account` (string, a vault account slug/email; validated before any browser
launch, unknown account ⇒ `400`).

## `new_chat` DEFAULTS TO TRUE — read this twice

The whole `messages` array is **flattened into one prompt string**. The site's
own on-page history is therefore a *second, invisible source of truth*. To avoid
one caller's answer bleeding into the next, every standards-compliant request
starts a **fresh chat** by default.

If you want site-side continuity (the warm page keeps its conversation), send
`new_chat: false` explicitly. If you assume OpenAI's stateless semantics, the
default is what you want; if you assume chat-session semantics, you must set it.

## Role flattening

- `system` / `developer` → `[system instruction]: …`
- `assistant` → `[assistant]: …`
- `tool` / `function` → `[tool result (tool_call_id: …)]: …`
- `user` text → unlabelled

`role:"system"` is a **typed convention only**: nothing enforces it and it has no
precedence over a later user turn. It is text in a prompt, not a sandbox.

## Tool calling, honestly

- `native` — the **site** ran its own tool during the turn and this surface read
  the invocation back off the page. Today the only site with a measured native
  reader is `kimi` (`NATIVE_TOOL_READERS` in `src/prompt/openai.ts`); read
  `/v1/models` rather than trusting this paragraph.
- `soft` — a `tools` array in the request is rendered into the prompt and the
  reply parsed back. `executed: false`: **nothing ran**, the caller runs the
  function. Consent-gated: the soft parser only runs when `tool_choice` is
  `"auto"` or an object; otherwise the answer is returned untouched.
- `none` — a `tools` array is ignored.

A returned call is `message.tool_calls[] = {id, type:"function", function:{name,
arguments}}` with `finish_reason:"tool_calls"`, plus
`choices[0].ui2api.toolCall = { mechanism: "native"|"soft-prompt", executed,
site, tool, evidence, suppressedSoft }`. A native invocation outranks and
suppresses a soft one (`suppressedSoft: true`). `tool_calls` is present **only**
when a call was really produced — never an empty or synthesised array.

## Restriction walls

A paywall / plan limit / login gate is **not** an empty success. You get
`200` with `finish_reason:"content_filter"`, a named `message.refusal` string,
and `ui2api.restrictions[]` naming the hits. On the stream path it is a single
chunk carrying `delta.refusal`, then `[DONE]`.

## When a call returns no answer

These are honest failures — the daemon never fabricates an answer.

| class | wire identity |
| --- | --- |
| image / file content parts | `400` `error.code === "unsupported_content_part"`, message names the kinds |
| empty `messages` | `400` with `param:"messages"` and **no** `error.code` |
| unknown model | `404` `unknown_model` |
| a real model the record does not call answering | `404` `model_withheld`, `error.withheldClass` = the measured class; the package is still on `/registry` and `/capability/<site>` |
| the measurement record is missing or unparseable | `503` `model_verification_unreadable` — `/v1/models` advertises nothing rather than promise without evidence |
| any other `/v1` path | `404` `not_found` |
| driver threw | `502` `error.code === "ui2api_driver_error"`, message is the driver's own named throw |

The `502` messages you will actually see, from `src/prompt/driver.ts`:

- stale-echo guard — `no fresh answer appeared on <site> within …`
- prompt-echo guard — `answer-echo on <site> …`
- no answer at all — `no answer appeared on <site> within …` (mentions sign-in
  or a consent wall)

The empty-because-of-a-wall case is the `200 content_filter` path above, not a
throw.

## Class D — the constraints you must code around

1. **Streaming is REPLAY, not incremental.** The answer is complete before the
   first byte; chunks are a finished answer sliced into 8-character pieces. Token
   timings are cosmetic. Do not infer incremental generation from
   `stream: true`.
2. **`usage` is an ESTIMATE of our text, not the site's tokens.** Every response
   carries a real `usage` object (`prompt_tokens`, `completion_tokens`,
   `total_tokens`) so your accounting code never crashes on `null`. It is a
   `ceil(chars/4)` heuristic over the two strings ui2api itself handled — the
   prompt it typed into the site's composer and the answer it read back off the
   page. The site's own backend tokenization is never exposed to us, so this is
   **not** a billable provider count. The label travels with it under
   `ui2api.usageAccounting`: `estimated: true`, `siteReported: false`,
   `method: "ui2api-char-estimate"`. On a stream it arrives on a final
   usage-only frame when you pass `stream_options: { include_usage: true }`
   (that frame is the only one with an empty `choices` array — OpenAI's own
   convention). Use it for a budget guard; never bill on it.
3. **`role:"system"` is a convention with no precedence.** It is prompt text.
4. **Images and files are refused with a named `400`.** Reachable on the
   separate `/capability/<site>` routes, not on `/v1`.
5. **Embeddings are absent by design.** `/v1/embeddings` is a `404`.

## The thing you must never assume

A returned answer does **not** mean the model understood your question as you
meant it. The site may have answered about something else: its own on-page
history is a second source of truth, the answer selectors can match the wrong
region of the page, and a `doneReason` other than a clean stop is surfaced
rather than hidden. Treat every answer as a page readback that was checked for
staleness and echo — not as proof of comprehension. When correctness matters,
verify the answer against something other than the model's own confidence.

## Known gaps

- Two `400` paths carry no `error.code`: empty `messages`, and a body that is
  not valid JSON. Branch on the status plus `error.param` / `error.message`.
  Every other error path names a `code` you can branch on programmatically.
- `temperature`, `top_p`, `max_tokens`, `stop` and friends are **not honoured** —
  there is no sampling API under a human-driven composer. They are not silently
  dropped either: each response reports the ignored ones by name under
  `ui2api.parameters.ignored`, so you can see that the knob did nothing.
