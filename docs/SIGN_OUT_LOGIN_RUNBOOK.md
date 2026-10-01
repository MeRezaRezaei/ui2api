# SIGN-OUT LOGIN RUNBOOK — the 11 rows that need a human

> **This page is a HUMAN checklist, not a code fix.** Nothing in this repository
> can log you in. Eleven rows in `capabilities/model-verification.json` carry
> `class: "SIGN-OUT"` — the server landed on a sign-in page, or told us in its
> own message that the site requires sign-in. The remedy is a person opening a
> browser and signing in. Any code change that "fixed" these rows would be
> fabrication, because a program cannot authenticate as you.
>
> Every row, URL, command and account name below was **read out of this repo on
> 2026-10-01**, from the files cited. Nothing is copied from a wiki or memory.
> If a command here does not do what it says, that is a bug in this page and
> `test/model-verification-consistent.test.ts` (RULE 12) is the gate that should
> have caught it.
>
> <!-- sign-out-count: 11 -->

## 1. What a SIGN-OUT row is, and is not

The record's own rule (`src/prompt/verification-class.ts`, the code that decides
the class — not a sweep convention) produces `SIGN-OUT` from exactly two
observed things:

1. **The page the server reported IS a sign-in surface** — its URL path matched
   `/\/login/`, `/\/signin/`, `/\/sign[-_]?in/`, or `/\/auth\/(login|signin)/`,
   or its title matched `sign in` / `log in` / `continue with`. Four of the 11
   rows are this shape (`claude`, `deepseek`, `huggingchat`, `poe`); they carry
   an `observedPage` block you can read in the record.
2. **The server's own message names a sign-in requirement** — it matched
   `/requires sign-in|sign in once|requires login|not logged in|unauthenticated/`.
   The other seven are this shape (`chatgpt`, `copilot-m365`, `hunyuan`,
   `inner-ai`, `kimi`, `manus`, `tencent-aistudio`).

That message is built at `src/prompt/driver.ts:632`, and it interpolates the
site's own `loginHint` from `capabilities/<id>/profile.json` when
`loginRequired` is true:

```
no answer appeared on <id> within <N>ms. This site requires sign-in. <loginHint>.
```

**So the hint the server printed is already the runbook step** — every entry
below quotes that same hint rather than inventing a procedure.

**An honest caveat about that runtime message, because it changes how you read
it.** The runtime does **not** detect a sign-out. `src/prompt/driver.ts:629-634`
picks its wording from *static profile metadata* — `loginRequired: true` yields
`This site requires sign-in. <loginHint>.`, `false` yields `The page may be
behind a consent wall`. Nothing in that `throw` inspects the page. So:

- The **classification** (`SIGN-OUT` vs everything else) IS measured — that is
  what `src/prompt/verification-class.ts` does from the server-reported page and
  message, and the record's `evidence` strings carry what it saw.
- The **runtime message** is a profile-authored string, not a diagnosis. Treat it
  as "here is the remediation this site's author wrote", not "the tool verified
  you are signed out".

This matters for `huggingchat`, whose profile says `loginRequired: false` — see
§5.1.

**What SIGN-OUT is NOT.** It is not a broken model, not a stale selector, and
not rate limiting. Those are three *different* classes with three different
actions (`WALL-CHALLENGE` → wigolo tier, never a retry loop; `COMPOSER-DRIFT` →
retune selectors; `CONTENDED-TIMEOUT` → re-measure at an idle pool). Filing any
of them as `SIGN-OUT` would assert a credential problem the measurement does not
show, which is why the classifier refuses rather than guesses.

**Before and after.** Before: `POST /v1/chat/completions {model:"<id>"}` returns
HTTP 502 with that named message, at an idle pool, reproducibly. After a
successful login + re-capture, a *new sweep* must be run to move the row; this
page does not and cannot rewrite the record's `class` value. Until a real
measured round trip returns HTTP 200 with real answer text, the row stays
`SIGN-OUT` — **logging in is necessary but not sufficient evidence**, and
`test/model-verification-consistent.test.ts` will keep failing the record as
stale until it is re-measured.

## 2. Cost order — pick the cheapest one that unblocks you

Ranked by what the login costs *you*, cheapest first. Cost claims are read off
the cited file for each site; the file that says a row needs 2FA or a work
account is the evidence.

| # | id | cost | what makes it this expensive |
|---|---|---|---|
| 1 | `chatgpt` | **medium** | Both stored `chatgpt.com` accounts are **anonymous and unusable** (`GET /health` vault accounting: `osbulk` and `merezarezaei@gmail.com`, each reason `anonymous (no cookies and no localStorage - the GOAL 49 write gate refuses to create this)`). Plain email/password; no work account needed. |
| 2 | `manus` | **medium** | OAuth via **Google or GitHub** — so it is free only if you already hold one of those accounts. |
| 3 | `deepseek` | **medium** | Email/phone registration. Its `session.lock.json` is **already `locked`**, so a session existed on 2026-09-18 and has since gone stale — a plain re-login is the whole fix. |
| 4 | `kimi` | **medium** | Also **already `locked`** (`capturedAt 2026-09-18`) — same story. `merezarezaei@gmail.com` is the stored account. Honest caveat: the record notes kimi has lower rate limits, so probe it serially. |
| 5 | `inner-ai` | **medium** | Login UI is a **different host** from the app: `https://platform.innerai.com/login.html` (inputs `#email`, `#password`, plus Google/Microsoft/Apple buttons). Sign in on the platform host or the capture captures an anonymous session. |
| 6 | `poe` | **medium-high** | `poe.com` is **Cloudflare-walled**: the package's own manifest records that static bundle analysis returned *only the challenge page, no JS bundles at all*. Expect an interstitial to solve before the login form. |
| 7 | `claude` | **high** | Cloudflare **and** hCaptcha attestation — the profile states the snapshot must come from a headed browser that actually solved the challenge. |
| 8 | `huggingchat` | **high (but probably unnecessary — see §5)** | The measurement showed a `/login?next=…` redirect, yet the package declares anonymous use works. Worth one cheap attempt before spending time; read §5 first. |
| 9 | `tencent-aistudio` | **high** | **iOA enterprise SSO** (QR-code scan via `POST /api/oalogin`) or WeChat. You need a Tencent iOA identity, not just an email. Also **headed-only**: Tencent Cloud EdgeOne blocks headless with HTTP 567. |
| 10 | `hunyuan` | **high** | Same EdgeOne/headed constraint plus an explicit anti-bot posture: the API sets `X-webdriver: 1` whenever `navigator.webdriver` is true, and the site runs Turing.js + QIMEI fingerprinting. There is **no session for this host anywhere on this box** — you must create the first one. |
| 11 | `copilot-m365` | **highest — may be impossible** | **Microsoft Entra ID only; MSA/consumer accounts are blocked** (`blockMsaFed:true`). You need a work or school tenant with an M365 Copilot licence. Conditional access (MFA/device) may additionally gate a fresh browser context. If you have no Entra tenant, **there is no unblock** — stop here rather than spending an afternoon. |

**If you only have consumer Microsoft or Google accounts and no Tencent iOA
identity, five of these eleven are not available to you at all.** That is stated
so you do not discover it by failing.

## 3. The shared mechanic — read this once

Every capture command below opens a **headed** browser window on your machine.
You sign in with your own hands; the tool then saves cookies + localStorage +
IndexedDB to the vault. The login happens in *your* profile, which is the only
place a session that these sites accept exists.

The captured session lands in the vault at (path shape only — never the
contents):

```
data/sessions/<host>/<account-slug>/state.json
```

Accounts are listed per host, and `ui2api requirements <site>` prints each
package's verdict with the capture age and a named reason.

**Two prerequisites for the headed step** (both from `docs/ONBOARDING.md` §2):

```bash
# a virtual display, so "headed" is true — a headless browser is what gets
# challenged, and UI2API_HEADED=1 without a display silently degrades
timeout -k 5 10 bash -c 'pgrep -x Xvfb >/dev/null && echo "Xvfb already running" || echo "Xvfb NOT running: start it with: Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &"'
export DISPLAY=:99
```

```bash
# pre-flight: does this box even have the browser + display it needs?
# exits nonzero on any not-ready, with the named reason per check
timeout -k 5 120 npx tsx src/cli.ts requirements
```

### The two ways to re-capture, and when to use which

```bash
# (A) INTERACTIVE — opens a browser for you to sign in by hand.
# This is the default capture mode; --login is implied and accepted explicitly.
timeout -k 5 300 npx tsx src/cli.ts profile capture "<url>"

# (A') same, but display-share the X server so a session logged into the
# dedicated `ui2api` user's Chrome lands in THAT user's vault. This is the
# route docs/ONBOARDING.md section 10 names for "the vault snapshot was captured
# but the site asks you to sign in again". Needs the xhost package.
timeout -k 5 300 npx tsx src/cli.ts profile capture "<url>" --assist

# (B) OFFLINE — no browser: reads the cookies+localStorage already sitting in a
# live Chrome profile on disk. Only works if you are ALREADY signed in there.
timeout -k 5 180 npx tsx src/cli.ts profile ingest <host>
```

**Use (B) when you are already signed into that site in your everyday Chrome** —
it costs seconds and opens no window. **Use (A) otherwise**, or (A') when the
vault is owned by the dedicated `ui2api` user.

> **KNOWN LIMIT OF (B) — verified in `src/cli.ts:929-953`.** `profile ingest`
> writes **only** the legacy flat snapshot `data/<host>/.session/state.json`. It
> does **not** create an identity-keyed `data/sessions/<host>/<slug>/` row, so it
> will not appear in `GET /accounts?site=` or the `/health` vault rollup. If a
> site is missing from the vault entirely (`claude`, `copilot-m365`, `huggingchat`,
> `hunyuan`, `inner-ai`, `manus`, `poe` — seven of the eleven), **use (A)/(A'),
> not (B)**: (B) cannot create the row that is missing. It also refuses loudly
> and exits nonzero when nothing matched: `nothing saved — no cookies and no
> localStorage matched <host> (logged out?)`.

Verify after capturing:

```bash
# what the vault now holds for that host — identities + verdict, never secrets
timeout -k 5 60 npx tsx src/cli.ts profile list <host>

# the package's readiness verdict + capture age + named reason
timeout -k 5 120 npx tsx src/cli.ts requirements <site-id>
```

Every command above is bounded with `timeout -k 5 <secs>` per this repo's
convention. **A capture that hits the 300s bound was killed, not completed** —
re-run it; do not assume it saved anything.

## 4. The 11 entries

Each entry is: what to open → the literal command → what "done" looks like.
The `hints` line quotes the site's own `loginHint` verbatim, so if the server
prints a different hint after a re-capture, the server is newer than this page.

---

<!-- sign-out-row: chatgpt -->

### 4.1 `chatgpt` — https://chatgpt.com

- **vault:** `chatgpt.com` — 2 stored accounts, both anonymous/unusable
- **lock:** `awaiting-capture`, `capturedAt: null`
- **hints:** `sign in once via \`ui2api analyse https://chatgpt.com --login\`, or reuse your real Chrome profile (UI2API_USER_DATA_DIR)`
- **why it is cheap-ish:** plain account login, but both existing vault slots
  hold *nothing* — the write gate refuses to create an anonymous snapshot, so
  a real sign-in is the only way these slots ever become usable.

```bash
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://chatgpt.com"
```

**Done when** `profile list chatgpt.com` shows an account that is no longer
`anonymous (no cookies and no localStorage …)`. Nothing else on this host can
change that verdict.

---

<!-- sign-out-row: claude -->

### 4.2 `claude` — https://claude.ai

- **vault:** `claude.ai` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **observed page:** `Sign in - Claude` at `https://claude.ai/login?from=logout&reauth=1&returnTo=%2Fnew%3F`
- **hints:** `sign in once via \`ui2api analyse https://claude.ai --login\`, or reuse your real Chrome profile (UI2API_USER_DATA_DIR); claude.ai needs a logged-in session (cookie sessionKey) and is Cloudflare-gated, so the snapshot must come from a headed browser that solved the challenge`

```bash
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://claude.ai"
```

**Note:** this one is **headed for a reason, not a formality.** The profile
states Cloudflare + hCaptcha attestation must be solved by the browser. If the
capture completes but the site still renders the challenge, the snapshot is
anonymous — check `profile list claude.ai` rather than trusting the exit code.

---

<!-- sign-out-row: copilot-m365 -->

### 4.3 `copilot-m365` — https://copilot.cloud.microsoft

- **vault:** `copilot.cloud.microsoft` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **id caveat, verified:** the package **directory**, `profile.json` id and the
  dispatch key are all `copilot-m365`, but the **manifest's own `id` field reads
  `copilot-m365-web`**. Use `copilot-m365` everywhere a site id is expected.
- **hints:** `Entra ID (Microsoft Entra) sign-in only — MSA/consumer accounts are blocked (blockMsaFed:true). Login redirect chain observed: /login -> /loginv2 -> https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=…`

```bash
# BEFORE spending 10 minutes: confirm you actually have an Entra tenant.
# A consumer Microsoft account will be refused by the site, not by this tool.
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://copilot.cloud.microsoft"
```

**This is the row most likely to be unfixable by you.** MSA/consumer accounts are
blocked by the site (`blockMsaFed:true`); you need a work/school tenant with an
M365 Copilot licence, and conditional access (MFA/device) may gate the fresh
browser context even then. The auth is a *server-side ASP.NET session cookie*, so
there is no client token to synthesise — only a real browser sign-in produces
one. **No code change in this repo can move this row.**

---

<!-- sign-out-row: deepseek -->

### 4.4 `deepseek` — https://chat.deepseek.com

- **vault:** `chat.deepseek.com` — accounts `merezarezaei@gmail.com` and
  `osbulk`, plus a large legacy flat snapshot (≈198 KB — a real one)
- **lock:** **`locked`**, `capturedAt 2026-09-18T14:42:47Z` — a session DID exist
- **observed page:** `DeepSeek - Into the Unknown` at `https://chat.deepseek.com/sign_in`
- **hints:** `capture a chat.deepseek.com session once: ui2api analyse https://chat.deepseek.com --login`

```bash
# (B) first — free if your everyday Chrome is still signed in to DeepSeek.
# This host HAS a vault account row, so (B) is legitimate here (see §5.6).
timeout -k 5 180 npx tsx src/cli.ts profile ingest chat.deepseek.com

# (A) if (B) finds nothing, or to also refresh the identity-keyed vault row
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://chat.deepseek.com"
```

**Done when** `profile list chat.deepseek.com` shows an account whose verdict is
not the `/sign_in` page. This site's auth is a localStorage `userToken` replayed
as a bearer — so an empty-cookie-but-populated-localStorage capture is a *valid*
login here; do not read "no cookies" as failure on this host.

---

<!-- sign-out-row: huggingchat -->

### 4.5 `huggingchat` — https://huggingface.co/chat

- **vault:** `huggingface.co` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **observed page:** `Hugging Face - The AI community building the future.` at `https://huggingface.co/login?next=https%3A%2F%2Fh`
- **profile says `loginRequired: false`** — read §5 before spending time here.

```bash
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://huggingface.co/chat"
```

---

<!-- sign-out-row: hunyuan -->

### 4.6 `hunyuan` — https://yuanbao.tencent.com/

- **vault:** `yuanbao.tencent.com` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **hints:** `HEADED session REQUIRED — the API sets \`X-webdriver: 1\` when navigator.webdriver is true, so headless Chrome is fingerprint-flagged (Turing.js + QIMEI). Capture once with a real, headed profile: \`ui2api analyse https://yuanbao.tencent.com --login\`, or reuse your signed-in Chrome via UI2API_USER_DATA_DIR. The chat console trusts the hy_user/hy_token session cookies.`

```bash
# MUST be headed. Verify the display exists first or this silently degrades
# to headless and gets fingerprint-flagged:
timeout -k 5 10 bash -c 'test -S /tmp/.X11-unix/X99 && echo "DISPLAY :99 OK" || echo "DISPLAY :99 ABSENT — Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &"'

export DISPLAY=:99
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://yuanbao.tencent.com/"
```

**Do not use `profile ingest` here as your only attempt** — the block is
`navigator.webdriver`, which is about *how* the browser was launched, not what is
on disk. And note: **there is no `hy_user`/`hy_token` session anywhere on this
box**; the AGENTS.md position is that these are domain cookies the user has
never generated. You are creating the first one.

---

<!-- sign-out-row: inner-ai -->

### 4.7 `inner-ai` — https://app.innerai.com

- **vault:** `app.innerai.com` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **hints:** `sign in once via \`ui2api analyse https://app.innerai.com --login\` (login UI: https://platform.innerai.com/login.html — inputs #email, #password + Google/Microsoft/Apple buttons), or reuse your real Chrome profile (UI2API_USER_DATA_DIR). Capture cookies token/email/deviceId.`

```bash
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://app.innerai.com"
```

**The trap:** the login form lives on a **different host**,
`https://platform.innerai.com/login.html`, and the credentials it produces are
cookies `token` / `email` / `deviceId` on the app host. Sign in on the platform
host during the capture window, or you will capture an anonymous app session and
believe it worked.

---

<!-- sign-out-row: kimi -->

### 4.8 `kimi` — https://www.kimi.ai

- **vault:** `www.kimi.ai` — account `merezarezaei@gmail.com`
- **lock:** **`locked`**, `capturedAt 2026-09-18T14:42:47Z`
- **hints:** `VERIFIED auth (from token-CrFSxcOs.js): sessions live in localStorage under keys access_token, refresh_token, msh_user_id; access_token is replayed as 'Authorization: Bearer …' against the Connect host https://notilo.kimi.com/apiv2 …`
- **honest caveat from the record:** kimi has lower rate limits, so when you
  re-verify, probe it **serially and at most twice** — a burst or a retry loop
  is how a good session gets rate-limited into the same 502 you are fixing.

```bash
# (B) first — kimi's vault already holds a real session; refresh it offline.
# This host HAS a vault account row, so (B) is legitimate here (see §5.6).
timeout -k 5 180 npx tsx src/cli.ts profile ingest www.kimi.ai

# (A) if (B) finds nothing, or to also refresh the identity-keyed vault row
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://www.kimi.ai"
```

---

<!-- sign-out-row: manus -->

### 4.9 `manus` — https://manus.im

- **vault:** `manus.im` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **hints:** `login once via \`ui2api analyse https://manus.im --login\` — OAuth (Google/GitHub); capture preserves cookies + localStorage (manus_session / *_session / manus_account keys)`

```bash
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://manus.im"
```

OAuth via **Google or GitHub** — so this row needs an account on one of those.
Auth is cookie **plus** JWT **plus** localStorage, so a capture that saves only
cookies is an incomplete login here.

---

<!-- sign-out-row: poe -->

### 4.10 `poe` — https://poe.com

- **vault:** `poe.com` — **no directory at all**, zero accounts
- **lock:** `awaiting-capture`, `capturedAt: null`
- **observed page:** `Poe - Fast, Helpful AI Chat` at `https://poe.com/login?redirect_url=%2F`
- **hints:** `capture a poe.com session once: ui2api analyse https://poe.com --login`

```bash
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://poe.com"
```

**Expect a Cloudflare challenge first.** The package manifest records that
static analysis of `poe.com` returned *only the challenge page — no JS bundles*,
so the site is walled against non-browser clients. Solve the interstitial in the
headed window before signing in.

---

<!-- sign-out-row: tencent-aistudio -->

### 4.11 `tencent-aistudio` — https://aistudio.tencent.ai

- **vault:** `aistudio.tencent.ai` — account `merezarezaei@gmail.com`
- **lock:** **`locked`**, `capturedAt 2026-09-18T14:42:47Z`
- **hints:** `HEADED session REQUIRED — cookie auth: hunyuan_token + hunyuan_user + hunyuan_source on .tencent.ai. Capture once: npx tsx src/cli.ts profile ingest aistudio.tencent.ai, or reuse your signed-in Chrome via UI2API_USER_DATA_DIR. iOA QR code scan login via /api/oalogin + /api/getuserinfo.`

```bash
export DISPLAY=:99

# (B) first — the hint names this command explicitly, and a session existed here.
# This host HAS a vault account row, so (B) is legitimate (see §5.6 for what (B)
# does NOT do: it never refreshes the identity-keyed row, only the flat one).
timeout -k 5 180 npx tsx src/cli.ts profile ingest aistudio.tencent.ai

# (A) if (B) finds nothing — headed; EdgeOne blocks headless with HTTP 567
timeout -k 5 300 npx tsx src/cli.ts profile capture "https://aistudio.tencent.ai"
```

**Two independent obstacles, both of which need you:** headed-only (EdgeOne,
HTTP 567), and iOA/WeChat identity — a QR-code scan via `/api/oalogin`, or the
WeChat button. The cookies are `hunyuan_token` / `hunyuan_user` /
`hunyuan_source` on `.tencent.ai` — **note these are NOT `hy_user`/`hy_token`**,
which belong to the different site `hunyuan` (§4.6). iOA sessions expire: a
`/_logout/?url=…` redirect or a 401/403 means re-login, not a code bug.

## 5. Findings — reported, NOT silently changed

These are discrepancies I found while building this page. I have **not** touched
any row's `class`, and none of these are corrected in the record.

### 5.1 `huggingchat` — the profile contradicts the classification

- The **record** files `huggingchat` as `SIGN-OUT`, re-derived from the page the
  server reported: `https://huggingface.co/login?next=https%3A%2F%2Fh`. By the
  rule in `src/prompt/verification-class.ts`, that IS a sign-in surface, so the
  filing is **correct as a classification of that measurement**.
- But `capabilities/huggingchat/profile.json` says `loginRequired: false`, and
  `capabilities/huggingchat/manifest.json` says `auth.required: false`,
  `anonymousSupported: true`, with the note: *"Anonymous works (GET
  /chat/api/v2/user = null; 140 models + full chat flow reachable signed-out)."*
- **Reading:** the two are not necessarily in conflict — the manifest records a
  static/bundle observation, the record records a live 2026-09-30 measurement
  that landed on a login redirect. Anonymous *may* still work; the measurement
  says that on 2026-09-30, headed, at an idle pool, it did not.
- **Consequence for you:** this is the cheapest row to *test* and the most likely
  to need no login at all. Re-probing it costs one request; a fresh capture costs
  five minutes. **Try the re-probe first.** I have not reclassified anything.

### 5.2 `copilot-m365` — the manifest's `id` disagrees with everything else

The package dir, `profile.json`'s `id`, and the dispatch key are all
`copilot-m365`; the **manifest's own `id` field is `copilot-m365-web`**. Anything
that keys on the manifest id will not find the dispatch key. Flagged, not fixed —
it is outside this page's scope, and `test/capability-dispatch.test.ts` has not
caught it.

### 5.3 `hunyuan` — a stale claim inside its own manifest

`capabilities/hunyuan/manifest.json` says it is *"not yet registered as a
built-in in src/profile/profile.ts"*. **That is false today** — `hunyuan` IS a
built-in (`src/profile/profile.ts:420`). The same sentence in
`capabilities/poe/manifest.json` is still **accurate** (`poe` is genuinely not a
built-in). Flagged, not fixed.

### 5.4 Three login commands exist only in package JSON, never in `src/`

`analyse https://app.innerai.com --login`, `Entra ID`, and `blockMsaFed` appear
only under `capabilities/**` and the record's evidence — never in `src/`. This is
**expected and not a defect**: `inner-ai`, `copilot-m365`, `manus` and `poe` are
all absent from `BUILTIN_PROFILES`, so nothing mirrors them into `profile.ts`.
Recorded so a future reader does not mistake it for a removed claim. Note the
runbook above uses `profile capture`, which **is** dispatched for all of them.

### 5.5 The brief's field name

The brief called these rows' "condition value". The field is **`class`** (values
from `VERIFICATION_CLASSES`); `prereq` is a free-text description of what is
missing. Nothing is lost, but a grep for `condition` finds nothing.

### 5.6 `profile ingest` cannot create a vault account row

Verified at `src/cli.ts:947` — it calls `saveSnapshot(snapshotPath(dataDir, host), …)`
and nothing else. `cmdProfileCapture` (`src/cli.ts:898`) is the one that calls
`saveAccountSnapshot`. **Consequence:** `tencent-aistudio`'s own `loginHint`
tells the operator to run `profile ingest aistudio.tencent.ai`, which refreshes
the flat snapshot but cannot create the identity-keyed vault row. For the seven
sites with **no vault directory at all**, `profile ingest` is the wrong command
and will leave the site missing. Reported, not fixed — it is a product question
outside a documentation lane's scope.

### 5.7 The three "three documents say three different things" contradictions

Each verified, each left standing (fixing prose I was not asked to fix would be
scope creep, and `docs/ONBOARDING.md` is not mine to edit):

1. **Command spelling is inconsistent three ways.** The CLI's own usage strings
   say `ui2api profile capture …` (`src/cli.ts:1592`); the `loginHint` strings
   say `ui2api analyse … --login`; `README.md`, `docs/ONBOARDING.md` and
   `docs/UNLOCK.md` say `npx tsx src/cli.ts …`. **This page uses the `npx tsx`
   form throughout** because that is what `test/ci-contract-doc-commands.test.ts`
   parses as a runnable command, and it is what the operator-facing docs use. The
   `hints` line under each entry quotes the site's own wording verbatim, so the
   two are visibly different rather than silently reconciled.
2. **"Sessions expire" vs "the session is no longer sufficient".**
   `docs/ONBOARDING.md:370` frames a signed-out site as expiry; the record's
   `tencent-aistudio` row calls it *"a regression … the session behind it is no
   longer sufficient, and that is a finding, not an inference"*. Neither is
   established. `src/runtime/requirements.ts:97` (`SESSION_STALE_DAYS = 14`) is
   the only age signal in the product and its own comment calls age *"a risk
   signal, never an 'expired' verdict"*. **Treat age as one hypothesis here, not
   the answer.**
3. **`--assist` vs `--login`.** `docs/ONBOARDING.md:371` names `--assist` for
   re-capture; the failing sites' `loginHint`s name `--login`. Both are
   dispatched and both reach a headed browser (`src/cli.ts:815` vs `:267`) — they
   differ in *which vault* the login lands in (display-shared `ui2api` user's
   Chrome vs your own). §3 gives both.

## 6. What this page cannot do, stated plainly

- **It cannot log you in.** No command in this repository authenticates as you.
  Every entry above opens *your* browser and waits for *your* hands.
- **It cannot move a row's `class`.** Only a re-sweep that measures a real
  round trip can. This page deliberately does not edit
  `capabilities/model-verification.json`.
- **It cannot promise a login will fix the row.** A login is necessary, not
  sufficient: `claude`, `poe` and `hunyuan` carry a bot challenge *as well as* a
  sign-in, and a successful capture that stores an anonymous snapshot looks
  identical on the command line. Always confirm with `profile list <host>`.
- **It cannot help if you lack the account.** `copilot-m365` needs an Entra
  tenant; `tencent-aistudio` needs a Tencent iOA identity; `manus` needs Google
  or GitHub. For those three the honest answer may be "no unblock exists for
  me", and this page says so rather than implying a trick.

## 7. After you log in

1. Confirm the vault actually holds a usable session:
   `timeout -k 5 60 npx tsx src/cli.ts profile list <host>`
2. Confirm the package's verdict and capture age:
   `timeout -k 5 120 npx tsx src/cli.ts requirements <site-id>`
3. Re-probe **serially**, one site at a time — do not burst these sites, and
   never retry-loop them (a challenge on a real account is the one failure this
   project cannot recover from). A signed-in site that still returns HTTP 502 is
   a *different* class with a different fix: re-derive it with
   `classifyOutcome()` rather than logging in again.
4. The record is dated; a fresh sweep is what actually moves a row. This page is
   the human-action list, not the measurement.

## Related

- `capabilities/model-verification.json` — the record, its `honestyRule`, and the
  per-row `evidence` strings this page quotes
- `src/prompt/verification-class.ts` — the rule that decides `SIGN-OUT`
- `src/prompt/driver.ts:632` — where the server's own "requires sign-in" message
  is built, from the profile's `loginHint`
- `docs/UNLOCK.md` — the attach-your-real-Chrome path, for auth that is
  browser-bound and cannot be replayed
- `docs/WIGOLO_BYPASS.md` — for `WALL-CHALLENGE` rows, which are a *different*
  blocker and must never be fixed by logging in again