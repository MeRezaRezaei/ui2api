# Vision

> Status: live. This file is the design contract for anyone (human or AI) working
> on UI2API. Read it before touching analyze, generate, serve, or the hub.

## The core idea

**UI2API turns any website the user is logged into into an API — where the
"browser" is the user's own Chrome, with the user's own data.**

The service must be able to:

1. **Drive the user's Chrome** — the *user's* installed Chrome, running with the
   *user's* profile/data. Not a bundled Chromium, not a synthetic profile.
2. **Automate any site** through that Chrome, with **zero bot fingerprint**.
3. Because the Chrome and the data are real, **captchas are not a concern**; the
   session is indistinguishable from the user's own browsing.

### Why "real Chrome + real data" is the whole trick

Every action our tools perform runs inside the user's genuine browser session and
reflects the code the site owner wrote. From the site's perspective nothing is
wrong — it is just a user interacting. There is nothing synthetic to fingerprint,
and existing auth (cookies, session storage, device trust) is already in place
because it is the user's own account.

**The single requirement:** the user signs into their accounts in their own Chrome
*before* letting UI2API act on those sites (one `ui2api analyse --login`). After
that, analyse / serve / hub / wigolo all run inside that same session.

## How this is implemented

- **`--login` / "cookie capture" is a means, not an end.** The durable truth is:
  drive the user's Chrome, reuse the user's profile. Cookie capture is only the
  fallback for environments that cannot attach to a real profile (CIs, servers).
- `UI2API_CHROME=1` (or `UI2API_CHROME_PATH=...`) + `UI2API_USER_DATA_DIR=...`
  select the user's real Chrome and profile everywhere:
  - `analyse` runs in it (analysis of authenticated apps needs the login);
  - generated `serve`/`hub run` contexts launch it and reuse the profile;
  - **wigolo daemon** gets the same profile via `WIGOLO_CHROME_PROFILE_PATH`
    (copies of the user profile) or `WIGOLO_CDP_URL` (drives the user's actually
    running Chrome). `use_auth` is only ever on in this mode.
- The bundled Chromium stays ONLY as a zero-config fallback (quick demos/CI).
  It must never be presented as the product's "mode of operation".

### Fingerprint discipline (read before changing args)

- The user's real Chrome is launched with **no hardening flags**
  (`--no-sandbox`, `--disable-gpu`, `--disable-dev-shm-usage` are ONLY for the
  bundled headless Chromium). `--window-size` only. See
  `buildLaunchOptions()/userChromeLaunchArgs()` in `src/runtime/browser.ts`.
- Do not spoof anything. The whole point is there is nothing to spoof — it IS the
  user's browser. Adding UA/WebGL/navigator trickery would be a fingerprint tell
  and a violation of the vision.
- Never "improve" stealth by injecting into the real user session beyond what
  ui2api's instrumentation needs to record action recipes (the `__ui2api`
  capture buffer during `analyse`, removed for normal serving flows by design).

## The engines

| Work                         | Runtime                                                        |
|------------------------------|----------------------------------------------------------------|
| `analyse` (capture recipes)  | user Chrome + profile (fallback: bundled Chromium + captured cookies) |
| `replay` (captured API call) | plain HTTP + same session cookies/user profile; SSRF-guarded   |
| `call` / `live-js`           | in-page JS on the live user session                            |
| `dom.click/type/waitFor`     | user Chrome (native) or wigolo daemon browser actions          |
| `dom.extract`                | wigolo extract (selector) or native page read                  |
| wigolo delegation            | loopback HTTP to a local `wigolo serve`; auth reuse on the SAME profile (WIGOLO_CHROME_PROFILE_PATH / WIGOLO_CDP_URL) |

`native` engine = UI2API drives the browser itself (still with the user's Chrome
when configured). `wigolo` engine = the wigolo daemon drives the browser for
fetch/extract/actions; the daemon is pointed at the same user profile, so the
"real user session" property holds for both engines.

## Guardrails (non-negotiable)

- **Only sites the user owns or is authorized to use.** The project's responsibility
  statement applies; bots/BYOIP/captcha-bypass services are out of scope.
- **Privacy boundary:** the user's profile is used in place; ui2api only persists
  what the flow needs (session cookies for cookie-gated sites, gitignored). Never
  exfiltrate or share the user's login data.
- **`trusted:false` maps require `--trust`** before they can run — generated tool
  surfaces are reviewed, not blindly executed.
- **Engine swap is license-clean:** MIT ui2api + AGPL wigolo talk over loopback
  HTTP only; no wigolo code is imported or vendored.

## Definition of done for a change

A change to UI2API is "vision-correct" when a user can:

1. run `ui2api analyse --login https://their-app.com` with their Chrome/profile,
2. `generate` + `serve` (or `hub run`), and
3. have their AI agent call the site's actions as MCP/ACP tools — all inside the
   user's own logged-in Chrome, no bundled browser, no captchas, no fingerprint
   difference from just using the site.

If a change makes the demo work only with the bundled Chromium + cookie capture,
it is a fallback, not the feature — call it out as such.