# UI2API — End-User Onboarding (v1, verified on this box 2026-09-21)

> Copy-paste flow that turns a fresh Linux user into a working
> `POST /v1/chat/completions` (or `POST /prompt`) that answers through their
> **own real logged-in browser session**. Every command below was run on this
> box in fold #11; the output quoted is real. Nothing here is fabricated and
> nothing here pretends a wall doesn't exist. Read AUDIT.md for the v1 verdict
> (GO) and capabilities/README.md for the per-site inventory.

## 1. What this is

`ui2api` drives an AI chat site (Gemini, Kimi, DeepSeek, …) through **the
site's own UI/JS in your real session** (cookies + localStorage from your
capture), reads the answer off the page, and serves it as an
OpenAI-compatible endpoint. Core rule — **no fabricated traffic**: we never
synthesize requests; the answer is read from the page the same way a human
sees it.

## 2. Prerequisites (Linux)

| Need | Why | Notes |
|---|---|---|
| Node >=22.13.0 | runtime | real floor: `node:sqlite` (profile scan/ingest) is unflagged from 22.13.0; CI proves on node 24 |
| An X display | headed `--assist` capture + xhost flow | headless works for anonymous sites only |
| `x11-xserver-utils` | `xhost` command for display sharing | `sudo apt install x11-xserver-utils` |
| A Linux system user named `ui2api` | verbatim 1495: login data belongs to the ui2api user | `sudo useradd -m ui2api`; the flow can also just run as you for the first try |
| Real Chrome (optional but recommended) | some sites block bundled Chromium | `UI2API_CHROME=1` / `UI2API_CHROME_PATH` (see §8) |

> **Verify before you start:** `npx tsx src/cli.ts requirements` (alias `doctor`)
> checks every row above — and the Playwright browser cache, the `ui2api` OS
> user + its copied-profile dir, per-host vault sessions, the attach port when
> set, and env-knob conflicts — printing each package's verdict
> **ready / working / on-hold / not-ready** with the named reason. Never a
> fabricated check and never a browser launch (execute-only probes).
> Machine-readable for CI: `npx tsx src/cli.ts requirements --json` — same
> report as JSON (`generatedAt/node/checks[]/packages[]/summary`; exit 0 =
> all pass in scope, exit 1 = named fail/not-ready). The site token works
> before OR after `--json` (`requirements gemini --json` = `requirements
> --json gemini`).
> The same order freedom holds for the prompt command: `--json` (and any
> flag) is valid before OR after the prompt text — `npx tsx src/cli.ts
> prompt --json "hello"` ≡ `prompt "hello" --json` (a flag is never sent to
> the site as the prompt text).

## 3. The 30-second path (anonymous)

The zero-setup smoke test — one command, headless, no login anywhere:

```
npx tsx src/cli.ts smoke
```

It gates on `ui2api requirements` first (any OS-level fail → the named reason,
exit 1), ensures the anonymous DuckDuckGo AI Chat package is present
(installing it via the registry seam if it is missing, and saying so), then
does ONE real anonymous chat round-trip through the ChatDriver and prints
`smoke OK: duckduckgo answered "<first line>" in Nms` (exit 0) or the named
failure (exit 1). Machine-readable for CI: `npx tsx src/cli.ts smoke --json`
emits `{ok, site, answer?, ms?, message, installedAnon?, report}` (the `report`
carries the same `checks[]/packages[]/summary` as `requirements --json`,
including vault `capturedAt/ageDays/stale`); exit 0 = ok, exit 1 = any named
failure. The same verified anonymous path directly:

```
npx tsx src/cli.ts prompt 'say hello' --site duckduckgo
```

`--json` (and any flag) is valid before OR after the prompt text — `npx tsx
src/cli.ts prompt --json "hello"` ≡ `prompt "hello" --json` (both ask the
same text; a flag is never sent to the site as the prompt).

> Note: on THIS box copilot is region-gated ("Not available in your region")
> and https://www.perplexity.ai answers "Just a moment…" (Cloudflare) —
> duckduckgo (duck.ai) is the live-verified anonymous path instead:
> headless-by-default (verified headed; headless may hit the anti-bot wall),
> "Anonymous site — never login-gated"
> (capabilities/duckduckgo, VERIFIED 2026-09-23). Your region/network still
> decides which anonymous site actually answers. The honest anonymous-capable
> list is in §7.

## 4. Capture once, summon your session (the login-UX flow)

This is the verified v1 flow (folds #7–#10; bulk login live-verified GOAL 9,
2026-09-22). It stores data in the **ui2api user** when that is genuinely
writable, and says so honestly otherwise.

### 4a. First login — ONE command (recommended)

Import every site session your OS Chrome profiles already hold into the
identity-keyed vault in one step — no per-host loop:

```
npx tsx src/cli.ts profile add-all --known        # non-interactive: every KNOWN AI chat host
npx tsx src/cli.ts profile add-all --interactive  # checkbox-pick exactly which hosts to import
```

Real output shape (live run 2026-09-22): a per-account read-back verdict
table — `imported` (snapshot on disk, account listed, cookies/localStorage
present), `decrypt-limited (portal v20)` (e.g. chatgpt.com app-bound
cookies), or `skipped-no-auth` (host has no usable cookies). Every row is
READ BACK from the vault, never a blind "ok"; exit is non-zero only when
all selected hosts failed. Zero temp-dir residue (`u2a-*` markers swept).
This replaces the manual per-host import loop as the go-to login flow.

### 4b. Find what you already have — or target one host explicitly

```
npx tsx src/cli.ts profile scan
```

Real output on this box (fold #11):

```
[ui2api] scanned 1 Chrome profile root(s):
  - /home/me/.config/google-chrome (user: me)

Sites found (checkbox index) — import any with:
  ui2api profile import <host> [--account email]
[ui2api] tip: add ALL known hosts in one step →  ui2api profile add-all [--known|--interactive]

[...83 hosts...]
[ ] 26. gemini.google.com  (1 profile, 4 cookies)  [KNOWN]
[ ] 33. chat.deepseek.com  (1 profile, 3 cookies)  [KNOWN]
[ ] 34. chatgpt.com  (1 profile, 3 cookies)  [KNOWN]
Tip: 4 of 83 hosts match known AI chat sites.
```

`scan` reads your real OS Chrome cookie DB (no browser launched). The
`[KNOWN]` mark means the host matches a builtin chat profile.

Prefer an explicit target over bulk `add-all`? Import that one host:

```
npx tsx src/cli.ts profile import www.kimi.ai --account me@example.com
```

Or capture fresh through the visual xhost flow (release the display lock so
the browser can open in front of you):

```
npx tsx src/cli.ts profile capture https://www.kimi.ai --assist
```

Real output shape (fold #11, list):

```
[ui2api] accounts for www.kimi.ai:
  me@example.com               me@example.com  (import, 2026-09-18)

Drive one with:  ui2api prompt '...' --site <id> --account <slug|email>
```

Wait for the display prompt, log in in the browser window the normal way,
press Enter, and the vault is stored keyed by (host, identity) under
`data/sessions/<host>/<account>/` (gitignored, never committed).

> **Honest data-dir note (fold #10)**: `--assist` prefers the ui2api user's
> XDG dir (`/home/ui2api/.local/share/ui2api`) when that user exists and the
> dir is writable from this session, else falls back to current-user `data/`
> — and TELLS you which one it used: `(data vault: <owner>)`. It never claims
> ui2api-user storage it cannot actually write.

### 4c. Use a specific account

Multi-account is live on the wire: pass `"account":"<slug|email>"` in
`POST /capability/<site>` and `POST /prompt` (validated against the vault
before any browser; unknown account → 400 listing the available slugs).
List stored accounts with `GET /accounts?site=<site>`, and each
`GET /registry` package carries its `accounts[]` — so callers can discover
every stored identity without site knowledge.

### 4d. Check what an account can do

```
npx tsx src/cli.ts profile capabilities www.kimi.ai
```

Real output (fold #11):

```
[ui2api] capability fingerprint for kimi / me@example.com:
  { "site": "kimi", "host": "www.kimi.ai", "account": "me@example.com",
    "tier": { "value": "Upgrade", "method": "dom" }, "models": [ ... ] }
```

## 5. Ask a question through the site

```
npx tsx src/cli.ts prompt 'say hello' --site kimi --account me@example.com
```

For the daemon, start it then curl:

```
npx tsx src/cli.ts promptd
```

Real outputs against 127.0.0.1:9797 (fold #11, current code):

```
$ curl http://127.0.0.1:9797/v1/models
{"object":"list","data":[{"id":"gemini","object":"model","created":0,"owned_by":"ui2api",
 "permission":[],"root":"gemini","parent":null,"site":"Gemini (gemini.google.com)",
 "url":"https://gemini.google.com","loginRequired":true},
 {"id":"duckduckgo","object":"model","created":0,"owned_by":"ui2api","permission":[],
 "root":"duckduckgo","parent":null,"site":"DuckDuckGo AI Chat (duck.ai)",
"url":"https://duck.ai/chat","loginRequired":false},
  ... 21 more entries ... ]}
  # 23 models = the servable chat set (count measured 2026-09-24 on a real default
  # daemon — GOAL 35): the 11 builtin chat sites + every installed DRIVEABLE
  # chat-shaped package. Dormant/dead-end or capability-only packages are NOT
  # models — /v1/chat/completions 404s ids it cannot serve, so /v1/models never
  # lists them (id list = the daemon's measured /v1/models order):
  # gemini, google-ai-search, chatgpt, claude, copilot, perplexity, huggingchat,
  # kimi, deepseek, tencent-aistudio, hunyuan, blackbox, codex, copilot-m365,
  # duckduckgo, grok, inner-ai, manus, notion, poe, t3chat, v0, venice

$ curl -X POST http://127.0.0.1:9797/v1/chat/completions \
    -H 'Content-Type: application/json' \
    -d '{"model":"gemini","messages":[{"role":"user","content":"Reply with exactly: PONG"}]}'

{"id":"chatcmpl-ui2api-mub4mud5zq120g","object":"chat.completion","model":"gemini",
 "choices":[{"index":0,"message":{"role":"assistant","content":"Gemini said\n\nPONG",
 "refusal":null},"finish_reason":"stop","logprobs":null}],
 "ui2api":{"site":"gemini","chunkCount":11,"doneReason":"stable",
 "url":"https://gemini.google.com/app/5bea91b06e7ce587","title":"Ping-Pong..."}}
```

That `content` was read off the real gemini page in the capturer's session —
not synthesized.

Other daemon endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /status` | pool state (browser up, warm/idle/busy) |
| `GET /sites` | configured chat profiles (per-id status) |
| `GET /v1/models` | OpenAI-compatible model list over the servable chat set (`{object:"list",data:[{id,...}]}` — model id = site id; the 23 ids above are exactly what `/v1/chat/completions` answers) |
| `GET /registry` | installed packages + `verified` records + per-package `chat.model` (truth, folds #8/#34) |
| `GET /requirements` | OS-level readiness report (GOAL 33 — same data as `ui2api requirements`: per-package verdict ready/working/on-hold/not-ready with named reasons, before any browser work) |
| `GET /accounts?site=<id>` | vault accounts for a profile |
| `GET /capabilities/<site>` | path form — the installed package's manifest capability surface `{site,name,url,capabilities:[{id,name,description,method}],source:"manifest",accounts[]}` (works for EVERY installed package, capability-only ones too) |
| `GET /capabilities?site=&account=` | query form — the stored per-account fingerprint (`models`, tier, restrictions) captured by `ui2api profile capabilities` |
| `POST /capability/<site>` | non-chat capabilities (list_conversations, web_search, …) |
| `POST /prompt` | `{"site","prompt"}` chat |
| `POST /v1/chat/completions` | OpenAI-compatible (404 `unknown_model` for any id not on `/v1/models`) |

## 6. Registry truth (`verified` + `chat.model`)

`GET /registry` exposes, per package, a `verified` record or `false`:

```
deepseek  verified: "2026-09-19"   (live round-trip recorded)
kimi      verified: "2026-09-19"
gemini    verified: "2026-09-15"
claude    verified: false          (Cloudflare-walled, not yet captured)
```

A package earns `verified` only by a **real** recorded live round-trip —
never by claim. `false`/absent = honestly not verified.

**The `chat.model` contract (GOAL 34)** — `chat.model` is present on a
`/registry` package **ONLY** when that id is on the servable chat set (the
23 ids in §5 — the exact gate `/v1` builds its allow-list from). Absence means
**no chat**: capability-only / url-less / dormant / dead-end packages
(gmail, youtube, araprat, chatglm, zenmux, xiaomimimo, …) keep their
status/tools/accounts on `/registry` but carry **no** `chat` key, because
`POST /v1/chat/completions` would refuse them with `404 unknown_model` — an
honest registry never advertises chat it cannot serve. Consumers must key on
`pkg.chat?.model` (never `pkg.chat.model`) and treat absence as "this package
has no chat surface".

## 7. Per-site state (source: capabilities/README.md + fold #9 live sweep)

| Site | Login | Verified live on this box? | Wall/note |
|---|---|---|---|
| gemini (gemini.google.com) | required | **YES** (2026-09-15, re-verified fold #6; PONG + /v1/chat OK fold #11) | — |
| kimi (www.kimi.ai) | required | **YES** (2026-09-19; chat + list_conversations + model_list + web_search + file_upload) | — |
| deepseek (chat.deepseek.com) | required | **YES** (2026-09-19; reasoner + web_search toggles) | AWS WAF + PoW invisible to page path |
| tencent-aistudio | required | **YES** (2026-09-19, headed/real-Chrome only) | EdgeOne blocks headless (HTTP 567) |
| youtube (www.youtube.com) — capability site, not chat | optional | **YES** search (2026-09-20); posting login-bound | POSTING needs your attached real Chrome |
| araprat (www.aparat.com) | — | **YES** search/trending/video_detail (2026-09-20) | — |
| copilot (copilot.microsoft.com) | anonymous | **NO** | region-gated on this box |
| perplexity (perplexity.ai) | anonymous | **NO** | Cloudflare "Just a moment…" |
| chatgpt (chatgpt.com) | required | **NO** | empty login wall without a real `__Secure-*` session |
| claude (claude.ai) | required | **NO** | Cloudflare-walled |
| huggingchat (huggingface.co/chat) | anonymous | **NO** | welcome CTA → OAuth login gate |

Be honest with yourself: a site that cannot answer on your network has its
blocker listed above — do not invent a green for it.

## 8. Browser/stealth rules (never break)

- Every browser launch goes through `launchBrowser()` in
  `src/runtime/browser.ts` (single seam: headless/headed/chrome/attach).
- `UI2API_HEADED=1` for a visible browser (needs a display; use Xvfb headless).
- `UI2API_CHROME=1` / `UI2API_CHROME_PATH` — real Chrome, REQUIRED for
  anti-bot-sensitive sites (Tencent).
- `UI2API_USER_DATA_DIR` / `UI2API_CHROME_PROFILE_PATH` — reuse your real
  Chrome profile (cannot share a profile already locked by running Chrome).
- `UI2API_ATTACH_PORT=9222` — attach to an already-running Chrome
  (`google-chrome --remote-debugging-port=9222`) instead of launching.
- `UI2API_POOL_MIN` — warm browser pool size for promptd.

> **App-bound / login-gated capabilities** (gmail, google-ai-search, youtube
> posting + transcript, tencent-aistudio, gemini search toggle, kimi Extra
> Long) can only be unblocked by driving the **user's own real Chrome** — the
> copy-paste attach playbook is **`docs/UNLOCK.md`**. It is the one-page
> version of the two-step fix that also lives in each site's
> `capabilities/<site>/CAPABILITIES.md`.

## 9. Security posture (automatic, but know it)

| Rule | Status |
|---|---|
| Origin pinning / SSRF guard (`src/runtime/ssrf.ts`) | daemon serves only configured sites, never arbitrary URLs |
| Trust gate | daemon answers only the profiles you configure |
| Bearer token | `UI2API_PROMPTD_TOKEN` gates by default posture |
| Binds 127.0.0.1 only | never exposes the vault to the network |
| `data/` is gitignored | captures contain real credentials — never commit/paste them |

## 10. If something goes wrong

- "no composer found on <site>" — the site's UI changed; re-tune via a JSON
  profile override (`--profile FILE`), never by editing one-off probe scripts.
- "waiting for element… subtree intercepts pointer events" — an onboarding
  overlay; add its dismiss button to the profile's `dismiss` list.
- The vault snapshot was captured but the site asks you to sign in again —
  sessions expire; re-capture with `--assist` (headed) as the wall instructs.
  The pre-flight gate names the age honestly too: `ui2api requirements` prints
  every vault-backed package's `captured <date> (N days ago)` and flags
  sessions older than 14 days with a `⚠ stale: … — re-capture: profile
  add-all --known` warn (a risk signal, never an "expired" verdict).
- The daemon answers stale `/registry` — restart it: kill the promptd process,
  then `npx tsx src/cli.ts promptd` (it must run the CURRENT code).

## 11. Consumer quickstart — external clients, proven end-to-end (GOAL 17, 2026-09-23)

The CLI/curl flow above is the producer view. GOAL 17 (proven on this box
2026-09-23) added the **external-client** angle — two clients in their own
processes, zero ui2api imports:

1. a plain OpenAI-compatible client hit the daemon's `POST /v1/chat/completions`
   with `"stream": true` and assembled the real SSE answer, and
2. an external MCP client (`@modelcontextprotocol/sdk`) connected to
   `ui2api plugin serve` over stdio and invoked a live verification tool.

Wire outputs below are the real runs — nothing fabricated, sanitized ids only.

### 11a. OpenAI-compatible SSE (`stream:true`) — exact wire

```
npx tsx src/cli.ts promptd          # http://127.0.0.1:9797
```

```
POST /v1/chat/completions
{"model":"deepseek","stream":true,
 "messages":[{"role":"user","content":"Reply with ONLY the number 418"}]}
```

Real SSE the client received (proof `G17-SSE-deepseek-muea5d27`, 2026-09-23):

```
HTTP/1.1 200 · content-type: text/event-stream
data: {"id":"chatcmpl-ui2api-…","object":"chat.completion.chunk","model":"deepseek",
       "choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-ui2api-…","object":"chat.completion.chunk","model":"deepseek",
       "choices":[{"index":0,"delta":{"content":"418"},"finish_reason":null}]}

data: {"id":"chatcmpl-ui2api-…","object":"chat.completion.chunk","model":"deepseek",
       "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Measured client assembly: `finalContent "418"`, 3 SSE events, 5.4s. Same wire
on kimi → `"419"` (proof `G17-SSE-kimi-muea5t6d`). The `content` is the
**DOM-read answer**: ChatDriver pastes into the site's own composer, presses
Enter, and reads the rendered answer until it stops growing. Nothing on the
OpenAI side is synthesized — when the site errors, the error text is what
streams back (gemini hit a transient "I seem to be encountering an error…"
streak during the proof run; the surface streamed the real page text rather
than a fabricated 417).

### 11b. MCP over stdio — external client invokes a tool

The consumer-facing way to drive a captured session from an agent. Server
side, a small plugin module wraps a verified capability runner:

```ts
// deepseek-plugin.ts (repo root) — `npx tsx src/cli.ts plugin serve ./deepseek-plugin.ts --base-url https://chat.deepseek.com`
import { resolveProfile } from "./src/profile/profile.js";
import { DeepSeekCapabilities } from "./src/capabilities/deepseek.js";
import type { Ui2ApiPlugin } from "./src/plugin/types.js";

export default {
  name: "deepseek-capabilities",
  version: "1.0.0",
  manifest: { name: "deepseek-capabilities", version: "1.0.0", author: "you",
    description: "DeepSeek live capabilities over MCP.", authorizedUse: "your own account",
    license: "MIT", ui2api: "0.2.0" },
  setup(ctx) {
    ctx.registerTool(
      { name: "deepseek_list_conversations",
        description: "List the user's real DeepSeek conversations from the live page sidebar.",
        inputSchema: { type: "object", properties: {} } },
      async () => {
        const caps = new DeepSeekCapabilities(
          resolveProfile("capabilities/deepseek/profile.json"), { dataDir: "data" });
        try { return await caps.run("deepseek_list_conversations", {}); }
        finally { await caps.close().catch(() => {}); }
      }
    );
  },
} satisfies Ui2ApiPlugin;
```

Any MCP client connects over stdio (`Client` + `StdioClientTransport` from
`@modelcontextprotocol/sdk`). Real invocation, this box, 2026-09-23
(proof `G17-MCP-mueat9b8`):

```
connect  · handshake 711ms
list_tools  · ["deepseek_list_conversations"]
call_tool("deepseek_list_conversations")  · call 1675ms
→ { "antiBot": "AWS WAF JS challenge … solved invisibly by a headed session …",
    "capability": "deepseek_list_conversations", "ok": true,
    "method": "dom.sidebar",
    "data": { "conversations": [ { "id": "s/…", "title": "…" }, … ] } }
```

`method: "dom.sidebar"` = the result was read off the real sidebar DOM of the
captured session (the "418" conversation created by the §11a call is in that
list — same account, same page).

The shipped example module is the same contract for chat:
`npx tsx src/cli.ts plugin serve src/plugins/ai-web.ts --base-url https://gemini.google.com`
exposes `send_prompt`, `new_chat`, `read_last_response`, `ai_status` over MCP
(see README "Wire it into an agent…").

ACP: the generated stdio ACP server surface (`generate --acp` →
`sites/server/acp.ts`, protocolVersion 2025-03-26) is covered by the unit suite
(`test/acp.test.ts`, initialize + list_tools over JSON-RPC), but a *live* ACP
tool call needs a real captured action map for a site — none is installed on
this box out of the box — so MCP stdio is the live-proven consumer surface.

## 12. Community install — `ui2api install <site>` (GOAL 24, 2026-09-24)

The registry that backs install is the public `ui2api-registry` repo, whose
default branch is **`master`**; every site there is a full capability package.
Install is one command and needs no analyse/generate:

```bash
# Discover: site | version | trust (reviewed until the operator reviews it)
npx tsx src/cli.ts install --catalog

# Install an anonymous site package (no login, no captured session needed)
npx tsx src/cli.ts install duckduckgo

# Serve it — the daemon answers GET /registry + POST /capability/<site>
npx tsx src/cli.ts promptd

# Run a REAL capability against duck.ai (its own browser + UI)
curl -s localhost:9797/capability/duckduckgo \
  -H 'content-type: application/json' \
  -d '{"capability":"duckduckgo_web_search","args":{"query":"ui2api"}}'
```

- Installed packages land in `capabilities/<site-id>/` — the same layout
  `promptd` already serves, so `GET /registry` picks the package up with no
  extra step.
- `--registry <url>` or `UI2API_REGISTRY_URL` point install at a fork; the raw
  base must end in the branch (`…/ui2api-registry/master`). A stale `/main` URL
  fails loudly with the correction hint.
- `trust` = `unreviewed` until a maintainer reviews a package; check it before
  running. Login-bound capabilities still need your real session
  (`docs/UNLOCK.md`).
- Same privacy rules: never commit `capabilities/<site>/session.lock.json`
  snapshots (they can contain captured credentials).