# Abstraction leak audit — 2026-09-29

Goal (verbatim): *"...mapping to an open ai compatible so we can connect other ai agents
to those sites **without anything ever know how the behind the scene works**."*

Gate: `test/abstraction-leak-truth.test.ts` — 14 tests, 9 pass, 5 fail.
The 5 failures are REAL, verified leaks (red by design until fixed).
Anti-vacuity proven both ways (see "Mutation reds" below).

## Method
Live service probed over HTTP on 127.0.0.1:9797 (read-only GETs + POST /v1/chat/completions),
plus three read-only code auditors fanned out in parallel. Every item below is
confirmed at `file:line` and, where marked, reproduced live.

## L1 — `src/prompt/openai.ts:573` — the ONLY /v1 error path does not redact
```ts
const msg = e instanceof Error ? e.message : String(e);
return sendJson(res, 502, { error: { message: msg, type: "server_error", code: "ui2api_driver_error", param: null } });
```
The redaction the brief refers to lives at `http.ts:1286`/`1309` — a DIFFERENT route.
Nothing on `/v1` redacts, so every driver throw reaches the consumer verbatim.

Live proof (copilot): HTTP 502 body contained
`no composer found on copilot (https://copilot.microsoft.com) — the site UI may have changed. Tune copilot in src/profile/profile.ts or ship a JSON override (--profile FILE). Page title: Microsoft Copilot, url: https://copilot.microsoft.com/`
→ leaks repo source path, private CLI flag, live page URL and title.

Live proof (huggingchat) — **a live OAuth secret**: the same template emitted
`...url: https://huggingface.co/login?...&code_challenge=U_pTsATnyaFb-AIzvWyCzSatFgGV7Q8LE7JUdxH18Co&state=eyJ4...`
→ a PKCE `code_challenge` + `state` + `client_id` in an unauthenticated 502 body.

FIX: named-message allowlist → 400/404; everything else → generic
`upstream_unavailable`, with the real error `console.error`'d. Never `e.message` on the wire.

## L2 — `src/prompt/driver.ts` — the throwing vocabulary that reaches L1
- `:456` `no composer found on ${id} (${url}) — the site UI may have changed. Tune ${id} in src/profile/profile.ts...`
- `:451` `page died reading the composer — Target page, context or browser has been closed`
- `:261` `throw new Error(lastErr)` — rethrows a stored Playwright message (selector chain + call log + `Timeout Nms exceeded`)
- `:340` `newChat reset not verified on ${id}: after clicking "${profile.newChat}"` → raw CSS selector
- `:547` `no fresh answer appeared ... (stale-echo guard, GOAL 46)`
- `:558` `answer-echo on ${id} ... Re-tune the profile's answer selector`
- `:582` `no answer appeared ... behind a consent wall — tune the profile's 'dismiss' selectors.`
- `:227` `no stored session for ${id} account "${account}" on ${host} — capture it first (ui2api profile capture <url> --login)`

## L3 — `/v1/models` publishes the mechanism as model metadata
- `openai.ts:249` `requiresRealBrowser: Boolean(profile.realProfileOnly)` — the NAME is the leak, and it is `false` for every current model (live), including tencent-aistudio whose own `via` says it needs a real headed Chrome. The one machine-readable anti-bot signal is present and always wrong.
- `openai.ts:246` `provenance: "builtin" | "packaged"` — tells the consumer the model came from a locally installed package.
- `openai.ts:245` `status: "verified" | "unverified-candidate" | "dormant" | "dead-end" | "builtin"` — an internal verification pipeline; `dormant`/`dead-end` have no upstream analogue.
- `openai.ts:339` `loginRequired` — states the "model" is a web account the operator is signed into.
- `openai.ts:674`-equivalent sink `registry.ts:674` `verified = {since, evidence, via, scope}` — `via` is the package's own prose, republished unfiltered. Live values include:
  - `"session-locked vault replay (gemini.google.com, localStorage BARD_EMBED_CHAT_STORAGE_KEY_V2 + cookies)"`
  - `"session-locked vault replay (localStorage access_token Bearer + x-msh-shield-data on notilo.kimi.com/apiv2)"`
  - `"headed real-Chrome only (Tencent Cloud EdgeOne blocks headless, HTTP 567) + session.lock injected snapshot; cookies hunyuan_token/..."`
  → cookie names, a localStorage credential key, a request header, the anti-bot vendor, the browser engine, Xvfb, `UI2API_HEADED`.

FIX: serve `verified: {since}` (or a boolean). `via`/`evidence`/`scope` belong on disk and on a token-gated `/registry/debug`.

## L4 — every successful answer carries a `ui2api` block naming the live page
`openai.ts:568`: `ui2api: { site, chunkCount, doneReason, url, title }`.
Live: `"url":"https://gemini.google.com/app/815a2bcc43490cca","title":"Casual Greeting - Google Gemini"`.
The strongest mechanism disclosure there is — it hands the consumer the site's own
conversation URL. `chunkCount` has no OpenAI analogue. `restrictions[].matched`
(`:461`) republishes the raw profile marker pattern.
FIX: drop the key; `doneReason:"restricted"` is already expressible as `finish_reason:"content_filter"` + a generic `refusal`.

## L5 — unauthenticated operator surfaces
All of these are reachable with no token (`posture.auth: "localhost-only"`, `/registry` → `auth.required: false`):
- `/health`, `/status` — `http.ts:378` `vault.root: "/home/me/Documents/projects/ui2api/data/sessions"`; `http.ts:300` / `pool.ts:276` `browserProbe: "browser.isConnected() === true"`; `posture.headful/headless/chromeNoSandbox/realProfileInPlay`; `pool.workers[].site/account/busyMs`.
- `posture.ts:178` `"chrome sandbox disabled (--no-sandbox) — ... UI2API_CHROME_NO_SANDBOX!=0"`; `:192` `"attach path form refused (no UI2API_ATTACH_ROOTS)"`.
- `session-store.ts:548` `VAULT_ANONYMOUS = "anonymous (no cookies and no localStorage — the GOAL 49 write gate refuses to create this)"` — one literal, reused by `/health`, `/accounts` and `/registry.accountsSummary`. **Highest-leverage single edit in this audit.**
- `/accounts` — `session-store.ts:760` `profileDir: "/home/me/.config/google-chrome"` (the operator's real Chrome profile path), plus account emails.
- `/requirements` — `requirements.ts:588` `"UI2API_ATTACH_PORT=9222 reachable (CDP /json/version answered)"`; `:552` `"headed (UI2API_HEADED=1) — display :99"`; `:410` OS username + `/home/ui2api/...` paths; `/usr/bin/google-chrome-stable 152.0.7977.82`; `ui2api profile add-all --known` CLI.
- `/registry` + `/capabilities/<site>` — `registry.ts:687` `method: "ui-path (...)"`; descriptions carrying raw selectors (`a[href*='/v/']`, `ytd-video-renderer`, `a#video-title`) and `CDP :9222`; `registry.ts:702` `dispatch: "declared-only"`.
- `/capabilities?site=&account=` — `http.ts:977` enumerates every stored account to an unauthenticated caller; `:989` hands out a CLI invocation.

FIX: reduce unauthenticated `/health` to `{ok, counts}`; gate `/status`, `/requirements`, `/accounts` and a `/registry/debug` on the bearer token; drop `profileDir`; strip the gate names from `VAULT_ANONYMOUS`.

## L6 — the 404 hands out our fleet map
`openai.ts:277` `unknown site "${id}" — try one of ${Object.keys(profilesById).join(", ")}`.
Live: a mistyped model returned the full 22-site list. A stock OpenAI 404 never enumerates the provider's fleet.
FIX: `model "${site}" does not exist`. The roster is already on `GET /v1/models`.

## L7 — account refusal leaks host + every stored identity
`no stored account "x" for "gemini.google.com"; available: [osbulk, merezarezaei@gmail.com]`
(`http.ts:977`, matched by the `SHAPE_MESSAGES` allowlist so it is deliberately preserved).
FIX: generic `invalid_request_error`, `param: "account"`, no host, no slugs.

## L8 — the 504 names the browser and hands out an env knob
`http.ts:1332-1341`: `"...the browser work outlived the daemon's aggregate deadline; raise UI2API_REQUEST_TIMEOUT_MS..."`.
On a `stream:true` request this can land after `writeHead(200)`, so the consumer sees a **truncated stream with no `[DONE]`** and cannot distinguish it from a short answer. That is a correctness bug as well as a leak.

## L9 — can `/v1/models` alone pick a working model? NO.
- anonymous-vs-login: stated (`loginRequired`), but inconsistently with `/registry`'s `authRequired`, which is derived from `manifest.auth` rather than the vault.
- regional / anti-bot blocking: **stated nowhere machine-readable.** The only place it appears is accidentally, inside the `via` prose (L3). `requiresRealBrowser` exists and is always `false`.
- Concretely unanswerable by a normal consumer as shipped: `tencent-aistudio` (headless-blocked), `google-ai-search` (external sign-in), `hunyuan` (no session exists on the box), `zenmux` / `xiaomimimo` / `adapta` (parked/dead-end), plus every `unverified-candidate` — which is never stated to mean "never verified live".
FIX: one derived field, e.g. `answerable: "yes" | "needs-login" | "needs-headed-chrome" | "never-verified"`, computed from the same seam `/requirements` uses, and list `/requirements` in the registry `endpoints` contract.

## L10 — tool calling: silent failure, not a leak
Measured 0-for-1. A consumer with an agentic client cannot distinguish "cannot call tools" from "chose not to". `finish_reason:"stop"` + absent `tool_calls` is schema-valid and leaks nothing — but it is a SILENT FAILURE, and a silent failure is worse than a leak for correctness. The honest fix is a capability flag the consumer can branch on *before* it depends on the feature (a field saying "tools unreliable on this surface"), not a mechanism disclosure.
`openai.ts:564` already sets `finish_reason: "tool_calls"` when a call IS parsed, and the parser fails closed (`:483`), so nothing is fabricated. The gate pins exactly that honesty and asserts nothing about success.

## Mutation reds (anti-vacuity, both demonstrated)
- **A — redaction removed from the error path.** Applied a generic-message redaction at `openai.ts:573`: 14 tests → **14 pass / 0 fail**. Reverted. This proves the 5 reds are caused by exactly that missing line, and nothing else.
- **B — model-list / servable agreement broken.** Dropped one advertised model from the `/v1/models` response: 14 → **6 pass / 8 fail**, with the bidirectional-agreement test naming the divergence. Reverted.
  - Note: my first attempt at B removed the `dormant`/`dead-end` exclusion in `registry.ts` and produced **no new red** — because `/v1/models` and the reference both read the same function, so a shared-source change cannot diverge them. That is a weakness in any single-source comparison, and it is why the gate asserts the relation against the served HTTP response rather than only against the imported function. The replacement mutation is the honest one.
- Both source files were restored; `git status src/` shows only the pre-existing `src/capabilities/kimi.ts` edit, which was dirty before this audit began.

## Could not measure
- The hub `GET /` runtime (not running on this box; the missing token gate at `src/hub/api.ts:22-23` is read from code, not observed).
- Whether a 502 can additionally carry a cookie/bearer VALUE. `injectSnapshot` and Playwright error text are plausible carriers; not traced. Treat as unverified — the L1 redaction gap makes it a risk regardless.
- Tool-calling cooperation at 0-for-1 was taken from the prior measurement, not re-measured here (a live tools round-trip needs a browser this audit is not permitted to drive).
- `hunyuan` having no session anywhere is from AGENTS.md, not re-probed.
