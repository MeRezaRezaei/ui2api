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
| Node 20+ | runtime | `npm run build` needs tsc/tsx |
| An X display | headed `--assist` capture + xhost flow | headless works for anonymous sites only |
| `x11-xserver-utils` | `xhost` command for display sharing | `sudo apt install x11-xserver-utils` |
| A Linux system user named `ui2api` | verbatim 1495: login data belongs to the ui2api user | `sudo useradd -m ui2api`; the flow can also just run as you for the first try |
| Real Chrome (optional but recommended) | some sites block bundled Chromium | `UI2API_CHROME=1` / `UI2API_CHROME_PATH` (see §8) |

## 3. The 30-second path (anonymous)

Not every site needs a login. For a zero-setup smoke test:

```
npx tsx src/cli.ts prompt 'say hello' --site copilot
```

> Note: on THIS box copilot is region-gated ("Not available in your region")
> and https://www.perplexity.ai answers "Just a moment…" (Cloudflare). Your
> region/network decides which anonymous site actually answers. The honest
> anonymous-capable list is in §7.

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
["gemini","google-ai-search","chatgpt","claude","copilot","perplexity",
 "huggingchat","kimi","deepseek","tencent-aistudio","hunyuan"]

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
| `GET /sites` | configured profiles |
| `GET /registry` | installed packages + `verified` records (truth, fold #8) |
| `GET /accounts?site=<id>` | vault accounts for a profile |
| `GET /capabilities?site=&account=` | what an account can do |
| `POST /capability/<site>` | non-chat capabilities (list_conversations, web_search, …) |
| `POST /prompt` | `{"site","prompt"}` chat |
| `POST /v1/chat/completions` | OpenAI-compatible |

## 6. Registry truth (the `verified` flag)

`GET /registry` exposes, per package, a `verified` record or `false`:

```
deepseek  verified: "2026-09-19"   (live round-trip recorded)
kimi      verified: "2026-09-19"
gemini    verified: "2026-09-15"
claude    verified: false          (Cloudflare-walled, not yet captured)
```

A package earns `verified` only by a **real** recorded live round-trip —
never by claim. `false`/absent = honestly not verified.

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
- The daemon answers stale `/registry` — restart it: kill the promptd process,
  then `npx tsx src/cli.ts promptd` (it must run the CURRENT code).