# UNLOCK.md — Unblocking attach-, plan-, and login-bound capabilities

> One page for the capabilities ui2api cannot unlock by itself. Every blocker
> below is **measured** (a live probe recorded it — see the per-site
> `capabilities/<site>/CAPABILITIES.md` for the raw evidence, and GOALs
> 4/15/19/21 in `.brain/verbatim-goals.md`). Nothing here is invented, and no
> capability is declared unblocked until a **real round-trip answers `ok:true`**
> on your machine. When the honest answer is "no unblock exists", this page says
> so plainly instead of promising a trick that cannot work.

## The one copy-paste path (your real Chrome, attached)

The blocker class behind most of these rows is the same: **Google's auth
cookies are app-bound** (Chrome 152 "portal" os_crypt v20 — bound to the
original OS user + Chrome install). A captured/imported cookie replay into a
fresh browser context renders **anonymous** (measured on gmail, google-ai-search,
youtube posting, gemini — see each site's CAPABILITIES.md). No capture trick
fixes that; only the **user's own real Chrome, live and signed in**, carries a
session the site accepts.

So the whole playbook is one seam, three commands:

```bash
# 1. Start your real Chrome with a debug port — the same profile you are
#    signed into; have the target site(s) open so they're logged in
#    (mail.google.com, youtube.com, gemini.google.com, www.google.com, …).
#    If normal Chrome is already running, close it first — one profile can
#    only be held by one Chrome process.
google-chrome --remote-debugging-port=9222

# 2. Start the daemon in attach mode (it adopts YOUR Chrome over CDP,
#    loopback only — it never spawns or kills a browser)
UI2API_ATTACH_PORT=9222 npx tsx src/cli.ts promptd

# 3. Call the capability through your session
curl -s localhost:9797/capability/<site> \
  -H 'content-type: application/json' \
  -d '{"capability":"<capability>"}'
```

`UI2API_ATTACH_PORT=9222` is the same knob documented in
[`docs/ONBOARDING.md`](ONBOARDING.md#8-browserstealth-rules-never-break) (§8).
Everything called this way runs in your real logged-in page — the site sees a
normal signed-in user, exactly like `tencent-aistudio` (which is how that site's
chat is verified).

For sites in the portable-capturable class there is a second, weaker path (see
the per-site rows): `ui2api profile add-all --known` (one-command bulk OS-Chrome
import) or `ui2api profile capture "https://<site>" --login`. **Know the
caveat**: for the Google app-bound class that portable replay may still render
anonymous — the attached real Chrome is the primary, honest path.

## Per-capability unlock

Each row gives the **measured blocker** first, then the unlock that actually
fits it. Two rows have **no unblock** — say so loudly.

### gmail — 5 capabilities (`gmail_read_inbox`, `gmail_list_threads`, `gmail_open_thread`, `gmail_search`, `gmail_send`)

- **Blocker (measured, GOAL 19, 2026-09-23)**: `mail.google.com` is 100% behind
  the Google auth wall — every static probe (`/mail/u/0/`, the `/_/scs/` JS
  bundles) 302s to `accounts.google.com/ServiceLogin`. Zero Gmail selectors are
  observable anonymously; all 5 capabilities are **DOM-unverified** and honestly
  answer whatever the wall returns until a real session exists.
- **Unlock**: sign in to mail.google.com in your real Chrome (step 1 above, with
  mail.google.com open), attach, then any `POST /capability/gmail` call drives
  the signed-in page. Two-step in detail: `capabilities/gmail/CAPABILITIES.md`.
- **Portable alternative**: `profile add-all --known` / `profile capture
  https://mail.google.com --login` lands a vault account — but Google app-bound
  cookies may still replay anonymous; attach is the honest primary path.
- **Read-back rule**: `gmail_read_inbox`/`search`/`open_thread` return `ok:true`
  only when actual conversation rows render. `gmail_send` is login-gated by
  design (a mutation) and must prove a sent read-back before it is ever green.

### google-ai-search — 1 surface

- **Blocker (measured, GOAL 4, folds #17d/#17f, 2026-09-22)**: signed-in-only.
  `profile ingest www.google.com` read **2/19 cookies** (SEARCH_SAMESITE, SOCS —
  Google 152 portal app-bound); even injecting the gemini vault's
  `.google.com` SID/NID/__Secure-3PSID/SAPISID/HSID renders **signed-out**
  (`/search` + myaccount both show "Sign in"), and AI Mode answer blocks
  (`[data-attrid="ai_web_answer"]`, .Ants3c, #via-container) never render across
  3 distinct queries.
- **Unlock**: sign into www.google.com in your real Chrome, attach, and re-verify
  AI Mode (`udm=14`) — then the search `?q=<prompt>&udm=14` page renders the
  answer with citations. Until that live round-trip, the status stays honest
  **not-verified** (metadata.json `verified:false`).
- **Portable alternative**: after the real sign-in, `profile add-all --known`
  (bulk) or `profile capture "https://www.google.com" --login`; the session may
  then be vault-replayed. Same app-bound caveat as gmail.

### youtube — transcript + 5 posting caps (`youtube_transcript`, `youtube_comment`, `youtube_like`, `youtube_subscribe`, `youtube_upload`, `youtube_playlist_add`)

- **Blocker (measured, fold #17f, 2026-09-22)**: search is verified anonymous,
  but transcript segments are session-gated — the site's own
  `POST /youtubei/v1/get_transcript` answers **HTTP 400 "Precondition check
  failed"** anonymously (measured across 4 videos). Replaying the real vault
  (`data/sessions/youtube.com/merezarezaei@gmail.com/`) or a copy of the real
  Chrome profile into fresh contexts renders anonymous **and** trips YouTube's
  "Sign in to confirm you're not a bot". All 5 posting caps are
  **login-bound** — never claimed verified.
- **Unlock**: your real Chrome signed into youtube.com, attached (steps 1–2
  above), then `/capability/youtube`:
  - `youtube_transcript` → "Show transcript" → the site's own request succeeds
    and `ytd-transcript-segment-renderer` rows render/read back.
  - posting caps → the site's own buttons click through the real session.
  Until a real attached session proves the flip, the runner keeps reporting the
  gate honestly (`ok:false` 400 explanation, or `loginGated:true` for posting).
- Detail and verified selectors: `capabilities/youtube/CAPABILITIES.md`.

### gemini_search_toggle — 1 capability

- **Blocker (measured, GOAL 15, 2026-09-23)**: every stored gemini source
  (vault `osbulk`, vault `merezarezaei@gmail.com`, legacy
  `data/gemini.google.com/.session`) replays **SIGNED-OUT** — Google auth
  cookies are browser/app-bound (same phenomenon as youtube posting). The
  signed-out surface has **no** Search/Web-access toggle: the tools panel shows
  "Sign in to try tools", and the mode picker lists only the 3.5 Flash-Lite /
  3.6 Flash / 3.1 Pro models.
- **Unlock**: gemini.google.com signed in in the **attached** real Chrome → the
  composer's sources/extensions entry (`otAQ7b`: Search=1) appears and the
  Google-Search grounding toggle can be exercised → round-trip `ok:true` with a
  grounded answer. Same `UI2API_ATTACH_PORT=9222` path as youtube/gmail.
- Detail: `capabilities/gemini/CAPABILITIES.md` §2.

### kimi Extra Long (`kimi_long_context`) — plan-gated, NOT a Chrome trick

- **Blocker (measured, GOAL 15, 2026-09-23)**: applying the "XL Extra Long"
  model on this free account answers with the site's own upgrade modal:
  "Extra Long — Available to subscribers on the Max plan or higher / Cancel /
  Upgrade". The wire mechanism works; the plan gate is real.
- **Unlock**: subscribe to the **Max plan (or higher)** on the Kimi account
  that drives the request, then re-run `kimi_long_context` — the toggle applies
  and the answer streams. **An attached Chrome does not unlock a plan gate.**
  Standard/long-context (`kimi_long_context` Standard) already works free and is
  verified. Detail: `capabilities/kimi/CAPABILITIES.md`.

### tencent-aistudio — 8 no-UI capabilities — **no unblock exists**

- **Blocker (measured, GOAL 15, 2026-09-23)**: the product lacks the surface.
  Scanned the live Hy4 preview composer + every control-extra element:
  - `tencent_aistudio_web_search` — **no search/联网 toggle exists** on the
    composer (`searchDeepMode` is wire-proven in bundles only).
  - `tencent_aistudio_deep_think` — no deep-think **toggle** (deep-thought
    OUTPUT renders by default; there is simply no switch to expose).
  - `tencent_aistudio_image_gen` — no trigger in aistudio; `/image` →
    "Current Page Does Not Exist"; 3D Studio is a separate `hy3d.tencent.ai`
    app.
  - `tencent_aistudio_code_run` — no coder trigger; `/code` → "Current Page
    Does Not Exist".
  - `tencent_aistudio_file_upload` — the composer has a files zone but **no
    `input[type=file]` and no attach button** in the live DOM.
  - `tencent_aistudio_tts` — no TTS/朗读 control; `/tts` → dead route.
  - `tencent_aistudio_podcast` — no trigger; `/podcast` → dead route (a prior
    podcast thread exists, current trigger not located).
  - `tencent_aistudio_translations` — no translation control; `/translate` →
    dead route.
- **Unlock**: **none.** No Chrome trick, plan, or capture changes what the
  product does not offer. When the Tencent composer gains these controls
  (or aistudio routes them live), re-audit — until then every one of these
  answers its measured honest blocker. Tencent **chat** itself is verified and
  needs only the headed/real-Chrome path (`UI2API_CHROME=1` real profile or
  attach — EdgeOne blocks headless Chromium with HTTP 567).
- Detail: `capabilities/tencent-aistudio/CAPABILITIES.md` status table.

## How to tell an unlock actually happened (never trust a claim)

- A capability counts as unblocked **only** when a live round-trip through the
  daemon returns `ok:true` with a DOM read-back from the real signed-in page.
  `ok:false` carrying the wall text ("Sign in", "confirm you're not a bot",
  the upgrade modal, "Precondition check failed") means the session is not what
  you think — the capability is still gated.
- First calls per site after attaching: gmail → `gmail_read_inbox`;
  google-ai-search → the `udm=14` answer; youtube → `youtube_transcript` on a
  captioned video; gemini → `gemini_search_toggle` then a grounded prompt;
  kimi → `kimi_long_context` (Extra Long) on a Max-plan account.
- There is **no seam on a box that has no attached real Chrome** (no
  `google-chrome --remote-debugging-port=9222` running = no `:9222` listener =
  the attach class stays gated). That is not a bug; it is the measured state
  until you run step 1.

## Cross-links

- [`docs/ONBOARDING.md`](ONBOARDING.md#8-browserstealth-rules-never-break) —
  the `UI2API_ATTACH_PORT` knob, browser/stealth rules, capture + `add-all`
  login flow.
- Per-site detail (the full two-step + raw evidence):
  `capabilities/{gmail,google-ai-search,youtube,gemini,kimi,tencent-aistudio}/CAPABILITIES.md`.
- Full per-site inventory: `capabilities/README.md`.
- Nearest-to-production truth: `.brain/verbatim-goals.md` GOALs 4, 15, 19, 21.