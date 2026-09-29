# Probe D — code truth on VISION / response_format / EMBEDDINGS / silent-ignore

Read-only code audit. Every claim carries a file:line. No suite run, no browser, no edits.

## A) VISION / image_url

`messagesToPrompt` — src/prompt/openai.ts:559-604.
- :560 empty/non-array `messages` -> `""`.
- :566 string `content` kept verbatim.
- :567-573 array content parts: **filter keeps only `type === "text"` or `"input_text"`**,
  maps `.text`, joins with `\n`. An `{"type":"image_url",...}` part has neither type,
  so it is **filtered out and silently discarded** — no warning, no error.
- Comment at :568-569 states the refusal explicitly: *"image/file parts are refused on
  /v1 for now (site file/vision flows live on /capability/<site>)"*.
- :575 `if (!content.trim()) continue;` — a request whose ONLY part is an image yields
  an empty prompt, which then 400s at openai.ts:697-701
  (`"messages must contain at least one non-empty text part"`).
- Corroboration: `grep -rn "base64\|data:image" src/prompt/` -> **zero hits**; there is
  no base64 decode path in the prompt layer at all.

Real upload UI in the packages (declared + runner):

| site | capability | manifest | runner | real UI drive? |
| --- | --- | --- | --- | --- |
| gemini | `gemini_file_upload` | capabilities/gemini/manifest.json | src/capabilities/gemini.ts:242,551-633; `setInputFiles` at :598 | YES — hidden `input[type='file']`, chip read-back (:618 honest timeout message) |
| kimi | `kimi_file_upload` | capabilities/kimi/manifest.json | src/capabilities/kimi.ts:348,648-710; `setInputFiles` at :681 | YES — verified |
| duckduckgo | `duckduckgo_file_upload` | capabilities/duckduckgo/manifest.json | src/capabilities/duckduckgo.ts:236,576-660; `setInputFiles` at :623 | YES — verified 2026-09-23 |
| youtube | `youtube_upload` (video) | capabilities/youtube/manifest.json | src/capabilities/youtube.ts:639-670; `setInputFiles` at :661 | YES but video-only + login-bound |
| chatglm | `chatglm_file_upload`, `chatglm_image_gen` | capabilities/chatglm/manifest.json | src/capabilities/chatglm.ts:34,38 -> `loginGatedResult` (:11,:29-43) | NO — login-gated stub |
| tencent-aistudio | `tencent_aistudio_file_upload`, `_image_gen` | capabilities/tencent-aistudio/manifest.json | src/capabilities/tencent-aistudio.ts:200-210, :177-188 | NO — honest ok:false, "NO input[type=file] … in the live DOM (measured 2026-09-23)" |
| copilot | `copilot_image_gen` | capabilities/copilot/manifest.json | src/capabilities/copilot.ts:175,285-300 | NO — "honest not-yet-live stub" |
| venice | `venice_image` | capabilities/venice/manifest.json | src/capabilities/venice.ts:282+ | NO — REST api-path, not a browser UI |

All real uploads go through the shared gate `validateAttachRequest`
(src/runtime/file-attach.ts:349) and `attachPayload` (:110) — i.e. they take a **file
path/bytes on disk under `UI2API_ATTACH_ROOTS`**, not an inline base64 data URL. There is
no code anywhere that converts a `data:image/...;base64,` string into an attach payload.

**A verdict: NO image can reach any model through `POST /v1/chat/completions` today —
`messagesToPrompt` drops every `image_url` part at src/prompt/openai.ts:571, and the only
real upload UIs (gemini/kimi/duckduckgo) live on `/capability/<site>`, out of reach of
the /v1 flattener.**

## B) response_format / JSON mode

`grep -rn "response_format\|json_object\|json_schema\|guided_json" src/ capabilities/`:
- src/mapper/llm.ts:33 and :67 — the **outbound mapper LLM client**, sending
  `response_format:{type:"json_object"}` to an external provider. This is a client
  calling out, not a served feature.
- Zero hits in src/prompt/** — the /v1 surface never reads the field.

Approximation available today: `src/prompt/soft-tools.ts`
- `buildToolInstruction(tools)` :134 — renders a JSON-Schema-ish tool spec into the prompt.
- `parseToolCall(raw, tools)` :317 — parses the model's JSON back out, rejecting any
  function name the caller did not offer.
- `stripToolCall(raw)` :383 — removes the envelope from the visible answer.
- Wired at src/prompt/openai.ts:690-696 (inject), :758-777 (parse), :814-815 (strip).

Reusability for response_format: **the machinery is reusable but is NOT reusable as-is.**
`buildToolInstruction` is parameterised on OpenAI `ToolSpec` (:72) and `parseToolCall`
hard-requires a caller-offered function name (the anti-invention filter, soft-tools.ts:317+).
A JSON-mode approximation would mean (a) synthesising a one-shot tool spec from
`response_format.json_schema`, (b) routing it through the same two functions, (c) emitting
`content: JSON.parse(argumentsJson)` — that code does not exist today.

Exact request shape a consumer can use **today**:
```
POST /v1/chat/completions
{"model":"deepseek","messages":[
  {"role":"system","content":"Reply with ONE strict JSON object and nothing else: {\"city\":string}"},
  {"role":"user","content":"Weather in Paris?"}],
 "tools":[{"type":"function","function":{"name":"emit_json","description":"Emit the JSON object",
   "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}]}
```
The model answers with a `tool_calls` entry whose `function.arguments` is the JSON string;
`choices[0].ui2api.toolCall.mechanism` will read `"soft-prompt"`, `executed:false`
(openai.ts:799-810).

**B verdict: `response_format` is not implemented anywhere in the served /v1 surface
(only two hits, both in the outbound mapper client src/mapper/llm.ts:33,67); the honest
today-equivalent is the soft-tool mechanism in src/prompt/soft-tools.ts:134/317, which is a
prompt-level APPROXIMATION with an explicit `executed:false` stamp — not OpenAI JSON mode.**

## C) EMBEDDINGS / AUDIO

Routing truth:
- src/prompt/http.ts:841 — `if (req.url?.startsWith("/v1/"))` dispatches the whole `/v1/`
  prefix into `handleOpenAIRoutes`.
- src/prompt/openai.ts:622 — the only GET route: `/v1/models`.
- src/prompt/openai.ts:650 — the only POST route: `/v1/chat/completions`.
- src/prompt/openai.ts:975-982 — terminal 404: `"ui2api serves GET /v1/models and POST
  /v1/chat/completions"`; the comment at :968-970 names `/v1/embeddings` and
  `/v1/completions` as the paths that used to hang and are now refused.
- http.ts:287 — the capability regex matches `/capabilities/`, `/capability/`, `/v1/chat`
  only.

No embeddings/vector code: `grep -rni "embedding" src/` -> **one hit, a comment**
(src/prompt/openai.ts:969). No `tts`/`speech` route anywhere: hits are all inside
capability runners/comments, never a route.

Per-site TTS/voice reality:

| site | capability | manifest | runner | executable? |
| --- | --- | --- | --- | --- |
| tencent-aistudio | `tencent_aistudio_tts` | manifest.json:187-191 | src/capabilities/tencent-aistudio.ts:211-220 | NO — "/tts answers 'Current Page Does Not Exist' (measured 2026-09-23)" |
| tencent-aistudio | `_podcast` | manifest.json:202-204 | :221-229 | NO — same, ok:false |
| chatgpt | `chatgpt_voice` | manifest.json:95-97 | src/capabilities/chatgpt.ts:179,321-334 | NO — "NOT built", unverified body |
| hunyuan | `hunyuan_voice_mode` | manifest.json:98-102 | src/capabilities/hunyuan.ts:160,292-315 | NO — recipe `scriptable:false`, needs real mic |
| doubao | `doubao_audio-voice` | manifest.json:106 | src/capabilities/doubao.ts:44-45 | NO — `loginGatedResult` |
| inner-ai | `inner_ai_voice` | manifest.json:91-95 | src/capabilities/inner-ai.ts:38-39 | NO — `loginGatedResult` |
| v0 | `v0_voice_input` | manifest.json:80-82 | src/capabilities/v0.ts:40-41 | NO — `loginGatedResult` |
| venice | `venice_audio` | manifest.json:75-79 | src/capabilities/venice.ts:174,323-332 | NO — "not executable yet" |

**C verdict: there is no `/v1/embeddings`, `/v1/audio/*`, or `/v1/completions` route — every
such path is refused by the terminal 404 at src/prompt/openai.ts:975; and no site has a
drivable TTS/voice UI (all 8 are honest ok:false / login-gated), so embeddings and audio
have no backing surface anywhere in this repo.**

## D) The silent-ignore surface

Every `body.<name>` occurrence in src/prompt/openai.ts (the ONLY request-body reads in
the file):
- :657 `body.stream`
- :658 `body.model`
- :673 `body.messages`
- :691 `body.tools`
- :723 `body.new_chat`
- :724 `body.account`
(:704, :710 are comments, not reads.)

That is the complete list. Every other field is unvalidated and unused.

| field | code truth |
| --- | --- |
| `stop` | NOT READ. The only `stop` strings are output `finish_reason:"stop"` at :889, :924, :941. No `body.stop`. |
| `temperature` | NOT READ. Sole mention is the doc comment at :13 (`temperature?, max_tokens?`) — a comment claiming support the code does not implement. |
| `max_tokens` | NOT READ — same comment-only mention, :13. |
| `max_completion_tokens` | NOT READ ANYWHERE (zero hits in all three files). |
| `seed` | NOT READ ANYWHERE (zero hits). |
| `top_p` | NOT READ ANYWHERE (zero hits). |
| `n` | NOT READ ANYWHERE (zero hits as a body field). |
| `frequency_penalty` | NOT READ ANYWHERE (zero hits). |
| `presence_penalty` | NOT READ ANYWHERE (zero hits). |
| `logprobs` | Only WRITTEN, hardcoded `logprobs: null` at :925. A request's `logprobs:true` is ignored. |
| `user` | NOT READ as a body field. All `user` hits are the word in prose (:5, :563, :578, :586, :596, :972; http.ts:311, driver.ts:101-210). |
| `service_tier` | NOT READ ANYWHERE (zero hits). |
| `stream_options` | NOT READ ANYWHERE (zero hits). The SSE path at :818-892 emits no `usage` frame and ignores `include_usage`. |

`/prompt` and the driver add nothing here either: driver.ts:411 `async ask(prompt, opts)`
takes a string prompt plus `PromptOptions` — no sampling parameters are plumbed at all.

**D verdict: exactly six body fields are read (`stream`, `model`, `messages`, `tools`,
`new_chat`, `account`); all twelve of `stop`/`temperature`/`max_tokens`/`seed`/`top_p`/`n`/
`frequency_penalty`/`presence_penalty`/`logprobs`/`user`/`service_tier`/`stream_options` are
silently ignored — and `temperature`/`max_tokens` are even advertised as supported in the
file's own header comment at src/prompt/openai.ts:13.**
