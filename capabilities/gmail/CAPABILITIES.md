# Gmail (mail.google.com) — capability surface

> MISSION (docs/verbatim.md:313): "as working with gmail agent without paying
> for google ai plan" — mail.google.com buttons and abilities callable as API.
> The user's flagship adoption pitch. Everything here is HONEST: capabilities
> are listed only where gmail's own UI genuinely has them; NOTHING is claimed
> verified without a live round-trip.
>
> STATUS GOAL 19 (2026-09-23): **SCAFFOLD — DOM-UNVERIFIED. mail.google.com is
> 100% behind the Google auth wall (measured below): no SPA shell, no JS
> bundles, no static asset is fetchable unauthenticated. Zero Gmail selectors
> are statically observable.** The capability list below comes from the
> well-known STABLE Gmail UI surfaces (conversation list rows, search box,
> composer) and is explicitly marked `DOM-unverified — needs captured session`
> until a live round-trip on a real logged-in session proves it. The read
> capabilities are implemented as real Playwright UI paths in
> `src/capabilities/gmail.ts` and will honestly report whatever a real session
> actually shows — never a fabricated ok:true.
>
> **ATTACH-CLASS site** — Google auth cookies are app-bound; the only honest
> two-step is the user's own signed-in Chrome attached over CDP
> (`UI2API_ATTACH_PORT=9222`). See [`docs/UNLOCK.md`](../../docs/UNLOCK.md) §1
> for the copy-paste commands. No captured replay is promised.

## Static wire analysis (2026-09-23, no browser, no login probe)

Every observable fact below was measured with `curl` from this box — NO
browser, NO play of credentials:

### What is observable without a session — everything 302s to accounts.google.com

| probe | result (measured 2026-09-23) |
|---|---|
| `GET https://mail.google.com` (bare) | **301** → `/mail/` (no body, `content-length: 0` surface, `server: GSE`) |
| `GET https://mail.google.com/mail/` | **301/302 chain** (round-robin host shim) |
| `GET https://mail.google.com/mail/u/0/` (+ browser UA/Accept headers) | **302** → `https://accounts.google.com/ServiceLogin?service=mail&passive=1209600&osid=1&continue=https://mail.google.com/mail/u/0/&followup=…&emr=1` — `server: ESF`, `content-type: application/binary`, `cache-control: no-cache, no-store, must-revalidate`, `content-length: 0`, `strict-transport-security: max-age=10886400; includeSubDomains`, `cross-origin-resource-policy: same-site`. **No Set-Cookie. No body. No JS.**
| `GET https://mail.google.com/mail/u/0/h/` (legacy basic-HTML mode) | **302** → accounts.google.com (same)
| `GET https://mail.google.com/mail/u/0/_/scs/` (the JS-bundle mount path) | **302** → accounts.google.com — the **bundles themselves are auth-gated**
| `GET https://mail.google.com/mail/u/1/` (alt account) / `?zx=1` cache-buster | **302** → accounts.google.com (same)
| `GET https://accounts.google.com/ServiceLogin?service=mail&…` | **302** (requires consent/profile cookies; login page is itself a redirect chain) |

**Verdict: zero statically observable Gmail UI.** Gmail is a single-page app
whose shell, JS bundles, internal endpoints (`/mail/u/0/_/scs/`, the
`/mail/u/iv/…` RPC-bridge paths are the well-known long tail — all behind the
same wall) and every rendered composer/send selector live behind the
authenticated session. Per the no-browser red line, no further auth-wall
probing was performed. Recorded honestly: **not observable.**

### What this means for the package

- Every capability below is implemented as a **real UI path** (open
  mail.google.com in the user's own logged-in session, click the site's own
  buttons, type in the site's own fields, read the site's own rendered DOM) —
  the same no-fabricated-traffic contract as every other ui2api site.
- Selectors are **known-stable Gmail UI surface names** (the conversation list
  row, the search box, the composer) — NOT observed in this repo yet, therefore
  **DOM-unverified**. Each read will honestly re-check what actually renders.
- The auth reality for Gmail is the **Google app-bound-cookie class** — the
  same measured blocker class as youtube posting / gemini account surfaces:
  portable replay of captured cookies into ephemeral contexts renders
  anonymous (Google cookies are browser/app-bound). The ONLY reliable seam is
  the **user's own real Chrome attached** with mail.google.com already signed
  in (`UI2API_ATTACH_PORT=9222`, needed exactly like `tencent-aistudio`).

## Live-round-trip status (measured 2026-09-23)

**No seam present → honest blocked, NOT verified.**

Measured on this box (GOAL 19): no `:9222` listening (no attached Chrome with
a debug port), no `data/sessions/mail.google.com*` vault account, no gmail
cookie file. The user's real Chrome (chrome-remote-desktop session) may well
hold a signed-in mail.google.com tab, but a portable unauth'd probe cannot
reach it. No gmail capability is claimed verified.

**Exact two-step unblock for the user** (mirrors the youtube/tencent class):

1. **Sign in to mail.google.com in the user's real Chrome** (any normal
   browser usage: open mail.google.com, log in). Leave that Chrome session
   alive.
2. **Attach + drive the real session**:
   ```
   google-chrome --remote-debugging-port=9222   # start real Chrome with a debug port (same profile you signed in with)
   UI2API_ATTACH_PORT=9222 npx tsx src/cli.ts promptd
   curl -s localhost:9797/capability/gmail -d '{"capability":"gmail_read_inbox"}'
   ```
   Alternatively, once a portable capture succeeds in a headed env:
   `npx tsx src/cli.ts profile capture https://mail.google.com --login` (or
   `ui2api profile add-all --known` for the one-command bulk login), then it
   lands in the vault (`data/sessions/mail.google.com/<email>/`) and
   `/capability/gmail` picks it up via the standard adjudicated ladder. NOTE:
   given Google's app-bound cookies the portable capture may still render
   anonymous — the attached-Chrome seam is the honest primary path.

NEVER fabricate ok:true. Until the seam exists, every read answers whatever
the wall actually returns (sign-in interstitial → honest ok:false), and
`gmail_send` stays login-gated by design.

## Capability surface

| id | flow | status |
|---|---|---|
| `gmail_read_inbox` | open `mail.google.com/mail/u/0/` in the session, read the rendered conversation list rows (sender, subject, snippet, date, unread) | **DOM-unverified** (needs captured/attached session) |
| `gmail_list_threads` | same row read, parameterized: `#label/<Label>` or `#search/<q>` hash route (a folder or filtered list) | **DOM-unverified** |
| `gmail_open_thread` | click the site's own row → read the opened thread (subject, from, date, body text) | **DOM-unverified** |
| `gmail_search` | type into the site's own search box (`input[aria-label="Search mail"]` / `[name="q"]`), let its JS run, read results | **DOM-unverified** |
| `gmail_send` | click the site's own Compose → fill to/subject/body in the site's own composer → click the site's own Send → read back sent state | **login-gated, DOM-unverified** (mutation; never until a real session proves a read-back) |

Implementation: `src/capabilities/gmail.ts`, dispatch `POST /capability/gmail`.

## Wire facts

- Internal RPC bridge: Gmail drives everything through the `/mail/u/*/` SPA's
  own XHR/batchexecute-style bridge (the `/_/` RPC endpoints). NOT captured,
  NOT driven; per the no-fabricated-traffic rule the runner never synthesizes
  `gmail.google.com` batchexecute traffic. Reads are DOM-only.
- Auth: **google web session (app-bound cookies caveat)** — see live-round-trip
  status above.
- Anti-bot: not probed (no session). Google's bot posture on gmail is
  documented-industry-known (login walls, device-bound cookies); the attached
  real Chrome path avoids it entirely.