# The OpenAI-compatible full-feature matrix — `ui2api`

**Date:** 2026-09-29 · **Daemon:** `http://127.0.0.1:9797` (live, headful Xvfb, 22 chat models / 33 packages / 71 vault accounts)
**Method:** static read of `src/prompt/**` + live HTTP probes against the running daemon. Every claim carries `file:line` or a literal request.
**Scope note:** the tree was being edited concurrently during this audit — `src/prompt/openai.ts` gained role-labelled `messagesToPrompt` and flipped the `new_chat` default to `true` mid-run. Line numbers are against the **current** working tree; re-verify before acting.

---

## (D) WHAT THIS ARCHITECTURE CAN NEVER HONESTLY PROMISE

This is the most valuable section, because it bounds the goal permanently. Class D is not a backlog — it is physics.

### D1. True incremental token streaming — IMPOSSIBLE
`streamingMode: "replay"` is already self-declared on every `/v1/models` entry (`openai.ts:143`, and the honest comment block at `openai.ts:126-140`). The ChatDriver types a prompt, then polls the answer region until it stops growing (`driver.ts:461-473`, `awaitAnswer`). The completion is **finished on the server before the first SSE byte is written**. The SSE loop at `openai.ts:542-547` slices a complete string into 8-char pieces.
- *Measured:* the stream is byte-level incremental (`"Duck.ai "` → `"said\nGen"` → `"erating "` → `"response"` → `"\n\nPARITY"` → `"-OK"`, split mid-word), ends with `data: [DONE]`, correct `chat.completion.chunk` objects. **So a client shows real typing — but it is typed out at wire speed after the fact.** There is no half-answer, no cancellation, no time-to-first-token signal that means anything.
- *Consequence:* no consumer may infer "the model is thinking" from TTFT, and no consumer may cancel mid-generation and keep partial work as though it were a real prefix.

### D2. Token accounting (`usage`) — IMPOSSIBLE
Absent from **both** modes. `openai.ts` has no `usage` key anywhere; `grep -n "usage" src/prompt/openai.ts` → only the word appearing in a comment. `stream_options:{include_usage:true}` is ignored (measured: zero `usage` occurrences in the SSE body).
- *Consequence:* `response.usage.total_tokens` is `None`, not `0`. openai-python token accounting, LangChain cost middleware, and any budget tracker **crash or mis-bill** rather than under-report. Only a third-party tokenizer over the request/response text can produce a number — and it would be an estimate of *our* prompt, not of what the site's own backend tokenized.

### D3. Native tool calling — IMPOSSIBLE (by design, and honestly labelled)
`NATIVE_TOOL_CALL_SUPPORTED = false` (`openai.ts:119`) is the single auditable source; `test/model-capability-truth.test.ts` greps for a `tool_calls` emission and fails if any model claims `native`. There is no path from the site's own function-calling wire to this socket — the site has no such exposed surface reachable by a human click.
- *What exists instead:* the soft layer. `buildToolInstruction` (`soft-tools.ts:134-168`) stringifies the JSON Schema into ~700-900 bytes of English rules appended to the prompt (`openai.ts:414-420`); `parseToolCall` (`soft-tools.ts:317-348`) regex-harvests fenced/balanced JSON from the rendered answer and validates the name against the offered set (`:330`).
- *Measured cooperation:* the repo records **0-for-1** — commit `62cc6d6`, "the model ignored it": the site answered the weather question as prose and `parseToolCall` returned `null`. Nothing was invented to fill the gap. **But this is n=1 on one site, recorded only in a commit message — not a doc, not a per-site census.** The honest statement is *compliance is unmeasured and site-dependent; the layer fails closed.*
- *Live probe this run:* a `get_weather` call DID produce a well-formed `tool_calls` entry. Control A (same tools, prompt `"Say hello."`) produced none; control C (`tool_choice:"required"`, unrelated tool name) produced none. So the call is a **keyword/proximity heuristic over the prompt**, not a model decision. The `{"city":"Paris"}` argument was extracted from the prompt text.
- *Two wire defects make this actively harmful to a client:* `finish_reason` is `"stop"`, never `"tool_calls"` (see B-row below), and `content` is left as the scraped preamble rather than nulled.

### D4. A system-prompt channel — IMPOSSIBLE
`ChatDriver.ask(prompt: string, …)` takes **one string** (`driver.ts:388`). `PromptOptions` (`driver.ts:14-21`) has no role plumbing. The only send mechanism is `dom.type(composer, text)` + `press(composer,["Enter"])` (`driver.ts:497-505`).
- A `role:"system"` message becomes the literal text `[system instruction]: <your prompt>` as **the first line of a user-typed turn** (`openai.ts:324-328`).
- *Consequence:* no precedence, no injection resistance. The bracket label is a convention the model may or may not honour. `role:"developer"` hits the same branch and is **indistinguishable** from system. Because the label sits at the front of an uncapped string, it is the first thing lost if a long transcript is truncated.

### D5. Multimodal input on `/v1` — IMPOSSIBLE without crossing the project's own line
`image_url` appears **zero times** in `src/`. `messagesToPrompt` (`openai.ts:300-303`) keeps only `type:"text"|"input_text"` parts and silently discards the rest.
- *Measured:* an image-only message → `400 {"error":{"message":"messages must contain at least one non-empty text part","param":"messages"}}`, fired at `openai.ts:393` **before** `pool.acquire` (so no browser launched).
- *The dangerous case is mixed:* text + image → the image vanishes, the site is asked "what color is this image?" with nothing attached, and it returns a **confident wrong answer**. Nothing in the response says the image was dropped. The code comment at `openai.ts:298-299` says "refused" — but refusal is a 400; this is **erasure**.
- *Could a site honestly do vision?* Two sites have **live-verified** file upload: `duckduckgo` (`capabilities/duckduckgo/CAPABILITIES.md:181`, chip read-back) and `kimi` (`capabilities/kimi/CAPABILITIES.md:86`, chip `kimi-attach-test / TXT / 52 Bytes`). **Zero** sites have a live-verified *image_gen*. So the capability exists on the site side and is **structurally unreachable from the OpenAI socket** — see C2.

### D6. Embeddings — IMPOSSIBLE, and must stay absent
Live: `POST /v1/embeddings` → `404` with a correct OpenAI-shaped envelope, from the terminal fallback at `openai.ts:585-593`.
- All 33 packages are DOM-read chat UIs. **Not one exposes an embedding endpoint** reachable without synthesizing a payload — which is exactly the fabricated traffic this project forbids. Hashing text and labelling it an embedding is fabrication. **404 is the correct answer.**

### D7. Audio / transcription — IMPOSSIBLE
No `/v1/audio/*` route exists. Live → 404.
- Sites declaring voice (`v0_voice_input` → `/api/chat/transcribe`, `chatgpt_voice` → `/backend-api/transcribe`, `doubao_audio-voice`, `inner_ai_voice`) are all *"declared (not verified)"*. Voice **dictation into a composer** is not an OpenAI transcription endpoint: different auth, different contract, different quality claims. Exposing it as `/v1/audio/transcriptions` would misrepresent all three.

### D8. Server-side conversation state — IMPOSSIBLE as a first-class concept
There is no `conversation_id` / `session_id` / `thread_id` / `previous_response_id` on the wire (grep: every hit is inside a comment). `OpenAIOptions` (`openai.ts:33-59`) has exactly four fields: `pool`, `profilesById`, `softTools`, `validateAccount`.
- A warm pooled page *does* carry the site's prior conversation (the pool hands the same `Page` to the next request, `pool.ts:339`/`:537`) — but the `/v1` default `newChat = true` (`openai.ts:447`) clicks the site's own New-chat and **verifies** the reset (`driver.ts:414-424`, `newChatResetVerified` at `driver.ts:80-93`). So site state is deliberately destroyed per request.
- *Consequence:* multi-turn "works" only because `messages[]` is concatenated into **one flat string** (`openai.ts:333`) and the site sees a single user turn. The cost is O(full transcript) re-paid on **every** call, with no prompt caching, and turn boundaries the site cannot perceive.

---

## (A) WORKS TODAY — NO CAVEAT

| # | Feature | Evidence | Request shape |
|---|---|---|---|
| A1 | `GET /v1/models` list shape | `openai.ts:349-368`; live 200, 24 entries | `GET /v1/models` |
| A2 | Standard model keys `id/object/created/owned_by/permission/root/parent` | live; all present | — |
| A3 | Non-stream `chat.completion` envelope, `choices[].index`, `message.role`, `logprobs:null` | `openai.ts:561-592`; live verified | `POST /v1/chat/completions {"model":"duckduckgo","messages":[{"role":"user","content":"hi"}]}` |
| A4 | SSE framing: `data: <json>\n\n` (LF LF, one space), `chat.completion.chunk`, `data: [DONE]` | live, 9 events, `xxd`-verified; `openai.ts:545-552` | `…,"stream":true` |
| A5 | `ui2api/` and `ui2api-` model prefixes accepted + normalized in response | `siteIdFromModel` `openai.ts:280-288`; live: `"model":"ui2api/duckduckgo"` → response `"model":"duckduckgo"` | `{"model":"ui2api/duckduckgo",…}` |
| A6 | **4xx / 502 error envelope is fully OpenAI-shaped** — all four keys | `openai.ts:363-372`, `:399-404`, `:585-593`, `:576`; live on 404 + 502 | any malformed / unknown path |
| A7 | Unknown endpoint 404, never a hang | `openai.ts:585-593`; live on `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/images/generations`, `/v1/assistants`, `/v1/files`, `/v1/responses`, `/v1/does-not-exist` | — |
| A8 | Account validated against the vault **before** any browser launch | `openai.ts:449`, `validateAccount`; throws → 400 | `{"account":"<slug>"}` |
| A9 | Restriction wall is never a blank success | `openai.ts:502-511` / `:583-589` → `finish_reason:"content_filter"` + `refusal` | — |
| A10 | Restriction surfaces **in-band** in the answer path | `driver.readRestrictions()` | — |
| A11 | `/v1/models` capability metadata derived at request time, never hand-typed | `openai.ts:225-255` (`modelCapabilities`), 10 non-standard keys | — |
| A12 | MCP server (stdio) already ships the non-chat tools | `plugin/serve.ts:33-55` | `ui2api plugin serve` |

---

## (B) WORKS WITH A CAVEAT THE CONSUMER MUST KNOW

| # | Feature | Caveat | Evidence |
|---|---|---|---|
| **B1** | **`stream:true` typing** | **Replay, not real-time.** Genuinely incremental bytes, but the answer was complete server-side first. `streamingMode:"replay"` is on every model entry. TTFT and token timings are cosmetic. | `openai.ts:143`, `:542-547` |
| **B2** | **Soft tool calling** | `tools:"soft"`, not native. Emits a correct-shaped `tool_calls` (JSON-string `arguments`) but the *model never chose it* — it is a prompt-keyword heuristic. Compliance measured **0-for-1** (n=1, one site). `executed:false` is **not on the wire** — a consumer treating it as executed is deciding that itself. | `openai.ts:414-420`; `soft-tools.ts:134-168`, `:317-348`; `openai.ts:568-573` |
| **B3** | **`role:"tool"` round trip — reaches the site, cannot close** | Not dropped: rendered as `[tool result (tool_call_id: X)]: …` (`openai.ts:319-321`), measured in-process. **But** (i) the assistant's own `tool_calls` turn has empty `content` → `continue` at `openai.ts:305` → **silently discarded**, so the model never sees what it requested; (ii) `new_chat` defaults `true` so the site conversation it was reasoning in is wiped; (iii) it is prose, not a wire field. | `openai.ts:289-334`, `:447`; `driver.ts:414-424` |
| **B4** | **Multi-turn continuity** | Works **statelessly** — caller re-sends the whole thread, ui2api flattens it (`openai.ts:333`), site reset each time. Costs full re-transmission per turn; site sees one long user turn, not alternation. `new_chat:false` is a **ui2api-specific** field absent from the OpenAI wire. | `openai.ts:333`, `:426-447` |
| **B5** | **System / developer roles** | Accepted, not privileged. Merged into user text as `[system instruction]: …`. `developer` is indistinguishable from `system`. No precedence, no injection resistance. | `openai.ts:324-328`; `driver.ts:497-505` |
| **B6** | **`/v1/models` metadata richness** | Carries `streaming, streamingMode, tools, toolCallShape, status, provenance, verified, requiresRealBrowser, loginRequired, site, url` — but **no `context_length` / `max_tokens` / context window on any of 24** (deliberately omitted; a made-up window is a number consumers size real requests against). | `openai.ts:325-332` comment; live: zero context keys across all entries |
| **B7** | **Restriction walls** | Correctly `content_filter` + `refusal`, but the non-standard `refusal` key and top-level `ui2api{}` block will fail strict-schema client validation. | `openai.ts:502-511`, `:583-589` |
| **B8** | **`tool_calls[].id` is deterministic** | `call_soft_` + FNV-style hash of `name+args` (`soft-tools.ts:297-306`, `:337`). Two callers issuing the same call get **identical ids** — a collision hazard in multi-tenant consumers. | as cited |
| **B9** | **Tool instruction has no size cap** | A 20-tool caller injects ~4KB of English meta-rules into the site's composer and its token bill. `MAX_SCAN_CHARS` (`soft-tools.ts:113`) bounds the *reply* scan, not the instruction. | as cited |
| **B10** | **`logprobs` / `refusal` inconsistent between modes** | Non-stream carries both + `ui2api{}`; stream carries neither. The two responses are **not shape-equivalent**. | live field diff |

---

## (C) MISSING — THE OPENAI SURFACE HAS IT, WE DO NOT

Ranked by blast radius × likelihood × cheapness. **The top three are the ones to build.**

### C1. `finish_reason: "tool_calls"` on the non-stream path — **one-line bug, breaks every agent framework**
- **Status:** missing, and it is a **conformance bug**, not a feature gap.
- **Where:** `openai.ts:590` — `finish_reason: result.doneReason === "restricted" ? "content_filter" : "stop"`. There is **no `parsedCall` branch**. The constant `OPENAI_TOOL_CALL_FINISH_REASON = "tool_calls"` (`openai.ts:149`) is referenced **exactly once** in the whole file, at `openai.ts:542` — the **streaming** path only.
- **Measured live:** a `tools` request returned `tool_calls:[{id:"call_soft_69fa…",type:"function",function:{name:"get_weather",arguments:"{\"city\":\"Paris\"}"}}]` together with `finish_reason:"stop"` and `content:"Duck.ai said\nGenerating response"`.
- **Blast radius:** the canonical OpenAI SDK agent loop branches on `finish_reason == "tool_calls"` to decide whether to execute. It will **never execute**, will treat the empty-content message as a final answer, and — because B3 already breaks the round trip — will loop. `finish_reason` also never takes `"length"`, so truncation is unrepresentable.
- **What it takes:** one ternary arm — `parsedCall ? "tool_calls" : (restricted ? "content_filter" : "stop")` — plus setting `content: null` when `parsedCall` is set (OpenAI requires null, not the scraped preamble). **Cheapest high-value fix in this audit.** Add a test that asserts parity between the two paths, since the whole class of bug is a path that forgot to learn about the other path.

### C2. File upload / vision as a message part — **capability-only, structurally unreachable**
- **Status:** missing from `/v1`; the capability genuinely exists on two sites.
- **Where:** `file-attach.ts` is imported by exactly `src/capabilities/{youtube,duckduckgo,kimi,gemini}.ts` and `posture.ts:48` (config constants only). **`src/prompt/openai.ts` does not import it — zero references.** The only route is `http.ts:1136` → `POST /capability/<site>` `{"capability":"kimi_file_upload","args":{…}}` → `caps.run` at `http.ts:1176`. The `/v1` router (`http.ts:840-862`) passes only `pool, profilesById, validateAccount, softTools`.
- **Request shape that works today (not OpenAI):** `POST /capability/kimi {"capability":"kimi_file_upload","args":{"file":{…}}}`.
- **What it takes:** extend the content-parts filter at `openai.ts:300-303` to *detect* an `image_url`/`input_file` part and **400 explicitly** rather than erase it (that alone is a 3-line honesty fix and should land first). Actually delivering it means staging the bytes through `validateAttachRequest` + `attachPayload` (`file-attach.ts:349`, `:110`) and driving the site's real `setInputFiles` before the prompt — i.e. a new pre-prompt step in `handleOpenAIRoutes`, plus the `UI2API_ATTACH_ROOTS`/`ATTACH_MAX_BYTES` trust gates that are currently capability-scoped. **Real work, and it is the single biggest gap between "full feature" and reality**, because two sites can genuinely do it and the OpenAI socket cannot ask.

### C3. `response_format` / JSON mode — **absent, and silently so**
- **Status:** missing. `grep -rn "response_format" src/` → **2 hits, both in `src/mapper/llm.ts:33,67`**, which is the *outbound* client for the optional `--llm` mapper. **Zero** in `src/prompt/`.
- **Measured live:** `{"response_format":{"type":"json_object"}}` → **200, prose, not JSON.** A consumer that then calls `json.loads(content)` gets a `JSONDecodeError` with zero server-side signal. This is the most consumer-damaging of the silent ignores, because JSON mode is a *contract*, not a preference.
- **Honest approximation — the seam already exists and is one line wide.** `openai.ts:388-392` already does the exact class of injection for tools: `if (toolInstruction) prompt = \`${prompt}\n\n${toolInstruction}\``. A `jsonInstruction` built the same way (`soft-tools.ts:134` as the template) gives prompt-level JSON steering.
- **What it takes, and the honesty requirement:** implement it as a **prompt-level approximation, explicitly labelled as such** — echo `response_format` back in the `ui2api` block with a `guarantees:false` marker, or add `ui2api.responseFormatHonoured:"prompt-level"`. The site cannot be made to *guarantee* valid JSON. Shipping it unlabelled would convert a missing feature into a new silent lie — strictly worse than the 404 the surface gives today.

### C4. `GET /v1/models/{id}` — 404
`client.models.retrieve("gemini")` fails, and most model-picker UIs call it. Live: `404` (with a correct envelope). **What it takes:** one branch in `handleOpenAIRoutes` filtering `data` by id. Trivial.

### C5. `usage` — see D2. Not buildable; only an estimate is possible, and it must be labelled as one.

### C6. Embeddings / audio — see D6/D7. **Correctly absent. Do not build.**

---

## SILENTLY IGNORED PARAMETERS — LIVE DECEPTION RISK

All measured against a stable 4/4 baseline (`len=143`, byte-identical). **The surface is LOOSE, not strict: an unknown key is accepted and dropped with 200.**

| Param | Measured | Verdict | Deception severity |
|---|---|---|---|
| `temperature` (0.1 **and** 1.9) | byte-identical to baseline | **VERIFIED-IGNORED** | HIGH — consumers tune it and believe it worked |
| `max_tokens: 5` | full 30-item list returned, no truncation | **VERIFIED-IGNORED** | HIGH |
| `stop: ["said"]`, `["20, 21, 22"]` | no truncation | **VERIFIED-IGNORED** | HIGH |
| `seed: 42` | no observable change | VERIFIED-IGNORED *(mechanism unprovable from outside — a knob could be plumbed and inert)* | MEDIUM |
| `top_p: 0.1` | no change | **VERIFIED-IGNORED** | HIGH |
| `n: 2` | `choices` length **1** | **VERIFIED-IGNORED** | HIGH |
| `response_format: {json_object}` | 200, **non-JSON prose** | **VERIFIED-IGNORED** | **HIGHEST** — downstream `JSONDecodeError` |
| `stream_options: {include_usage}` | no usage chunk | **VERIFIED-IGNORED** | MEDIUM |
| `tool_choice: "none"` / `"required"` | no effect (`"required"` failed to force any call) | **VERIFIED-IGNORED** | HIGH |
| `parallel_tool_calls` | no change | **VERIFIED-IGNORED** | LOW |
| `user`, `metadata` | no change | **VERIFIED-IGNORED** | LOW |
| `totally_fake_param: true` | **HTTP 200** | **VERIFIED-IGNORED** | **the strictness failure itself** |
| `logprobs` (request) | hardcoded `null` in response | ABSENT | LOW |

`max_tokens` and `temperature` are **documented as accepted in the file's own header** (`openai.ts:13`) yet never read in the body — the doc comment is itself a small lie.

### Two further honesty failures, not parameter-related
1. **Readback failures are laundered into successes.** One probe returned `HTTP 200, finish_reason:"stop"`, `doneReason:"stable"`, with the answer body silently truncated (the number list gone). A client cannot distinguish "the model answered briefly" from "the scraper lost the answer." No `ok:false`, no distinct `finish_reason`.
2. **Cross-request content contamination.** Responses carried page text from other conversations: `ui2api.title` was `"Weather in Paris"` / `"French capitals"` / `"What is the capital of France? One word only."` on unrelated requests, and `"…PARITY-OK\n\n2nd opinion"` — a sibling UI panel's content — landed inside `message.content`. A consumer that logs responses is ingesting another session's page text. The per-ask freshness baseline (`driver.ts:461-473`) guards the *answer*; the *envelope* fields and the surrounding chrome are not guarded.

---

## ERROR ENVELOPE — VERDICT

**Path-dependent. Conforming on 4xx/502, non-conforming on 500.**

- Conforming (all four keys present, measured): unknown model → `404 {message, type:"invalid_request_error", code:"unknown_model", param:"model"}`; bad JSON → `400`; empty prompt → `400 {…param:"messages"}`; every unknown `/v1/*` path → `404 {…code:"not_found", param:null}`; driver failure → `502 {message, type:"server_error", code:"ui2api_driver_error", param:null}` — the **best error in the surface**, naming the exact file to tune.
- **Non-conforming:** `{"model":"zenmux"}` and `{"model":"xiaomimimo"}` both → `HTTP 500 {"error":{"code":"internal_error","message":"internal error"}}` — **no `type`, no `param`**, and a message that names neither the site nor the reason. Source: the outer catch at `http.ts:1286` and `:1309`. openai-python parses this, but LangChain maps exceptions off `type`, and an operator cannot diagnose the failure.

---

## THE NON-CHAT HALF — HOW AN OPENAI-ONLY CONSUMER REACHES IT

**Measured inventory:** `/registry` → 33 packages, **161 tools**. **8 are capability-only** (`chat:false`): `adapta`(1), `araprat`(9), `chatglm`(8), `conol`(1), `doubao`(12), `gmail`(5), `google-ai-search`(1), `tinycms`(1), `xiaomimimo`(3), `zenmux`(1).

**The discovery blackout — the real problem.** `/v1/models` returns **24** entries; `/health` says `chatModels: 22`. An OpenAI-only consumer discovers models **exclusively** via `/v1/models`, so **all 11 capability-only packages — `youtube`, `araprat`, `doubao`, `chatglm`, `gmail`, … — are invisible to it.** Worse, the two *extra* entries relative to the health count are **`zenmux` and `xiaomimimo`, which are advertised and then hard-500** (verified above). A consumer enumerating `/v1/models` builds 24 providers, 2 of which fail on first use. The cause is the chat gate working correctly (no driveable composer ⇒ no `chat` key) colliding with `/v1/models` being the only discovery channel.

**Options, honestly graded:**

| Option | Real? | Assessment |
|---|---|---|
| (a) OpenAI function-calling bridge | **Aspirational as a ui2api feature** | The `tools:` array is prompt-level and the **caller** executes (`openai.ts:386-390`). A consumer *could* implement `youtube_search` itself as an SDK-side function — but ui2api provides no dispatch. B1+B3 make it unreliable regardless. |
| (b) Model id per capability | **Real, unbuilt, cheap** | Hook: `siteIdFromModel` (`openai.ts:280`). Today `model:"youtube"` dies at `profileById` with `unknown site`. `CAPABILITY_DISPATCH` (`capability-dispatch.ts:68`) is already data keyed by site, and `http.ts:1174-1176` already constructs + runs. **But shipping this alone is wrong**: capability ids would collide with the 22 real chat models and make `/v1/models` meaningless. |
| (c) MCP | **Real and shipped** | `plugin/serve.ts:33-55` registers every plugin tool on an `McpServer`. **stdio only** — line 55 throws on ws, no HTTP/SSE transport. Works today for Claude Code / Cursor. Does **not** help an OpenAI-only HTTP client. |
| (d) `GET /v1/tools` + server-side dispatch | **Real, unbuilt — the correct answer** | Hook: `http.ts:840` (`url.startsWith("/v1/")`) + a new branch beside the models route. Build the list from the **same data `/registry` already serves** (`buildRegistryPackages()`), and execute `tool_calls` **server-side** through `CAPABILITY_DISPATCH` so the daemon — not the caller — runs the capability. This is (b) with the id riding in `tools[].function.name` instead of `model`. |

**Recommendation:** **(d), built on (b)'s hook.** One table lookup, one existing runner constructor, zero new browser code, and it preserves the ban-safety argument (the site still runs its own UI). It is also the **discovery channel** that fixes the blackout without pretending `youtube` is a chat model. Ship (c) as-is for MCP-native clients; its missing HTTP transport is a separate, cheap gap at `serve.ts:55`.

---

## (B)-CLASS ITEMS THAT ARE ACTUALLY WIRE-COMPATIBILITY BUGS

Restating, because they are the ones that break off-the-shelf libraries rather than merely qualify a feature:

1. **Non-stream tool call returns `finish_reason:"stop"`** (`openai.ts:590`) — every agent loop keyed on `"tool_calls"` never runs the tool. *Fix: one ternary arm.*
2. **`usage` absent in both modes** — `response.usage` is `None`; token accounting crashes.
3. **`system_fingerprint` absent**; `logprobs`/`refusal`/`ui2api` inconsistent between modes — strict-schema clients reject.
4. **`GET /v1/models/{id}` 404s** — `client.models.retrieve()` fails.
5. **500-path envelope lacks `type` and `param`** (`http.ts:1286`, `:1309`).
6. **`/v1/models` advertises 2 models that hard-500** (`zenmux`, `xiaomimimo`) — verified live.
7. **Assistant `tool_calls` turn silently dropped** by the flattener (`openai.ts:305`) — the model never sees what it requested.
8. **Readback failures return 200 + `finish_reason:"stop"`.**

The repo's honesty layer is genuinely good *in the metadata* — `streamingMode:"replay"`, `tools:"soft"`, `NATIVE_TOOL_CALL_SUPPORTED = false`, non-compliance → `null` never a guess, invented tool names rejected against the offered set. **The weakness is that this honesty lives in envelope metadata, not in the HTTP contract** — so a standard client that reads only OpenAI fields is told a much stronger compatibility story than it is getting. That gap, not the missing features, is what would make a consumer's agent quietly wrong.

---

## WHAT I COULD NOT MEASURE, AND WHY

1. **Mixed text+image silent drop** — proven by code (`openai.ts:300-303`, unconditional, no branch can warn) but **not** by a completed live round-trip. Three attempts died on unrelated site grounds: `copilot` → `no composer found`, `perplexity` → Cloudflare `Just a moment…`, `kimi` → 110 s timeout (exit 124). I was told not to launch a browser of my own.
2. **Whether `seed`/`temperature` are plumbed-but-inert vs never plumbed** — undecidable from outside. No observable effect is established; absence of plumbing is not.
3. **Per-site tool-call compliance** — the repo's "0-for-1" is **n=1 on duck.ai**, recorded only in commit `62cc6d6`. There is no census. I got one heuristic hit on duckduckgo this run, which is a *different* signal from the recorded one; the sample is too small to generalise.
4. **`copilot` selector rot** — `502 no composer found` is selector-shaped, but I cannot exclude that concurrent probing wedged the warm page. **COULD-NOT-DISTINGUISH.**
5. **Load contamination** — box load average was **30.6** and promptd respawned once mid-audit (3 concurrent calls → `HTTP=000`). Timing-sensitive measurements may be skewed; all parameter comparisons were re-run serially against a 4/4 stable control.
6. **True site-side context windows / model identity** — unknowable without instrumenting the site's own network, which the no-fabrication rule forbids. Hence `context_length` is honestly absent everywhere.
7. **Whether `xiaomimimo`/`zenmux` could ever serve** — DNS-dead / dormant per the repo; confirmed only that they 500 today.
