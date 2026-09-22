# YouTube (www.youtube.com) — capability surface

> STATUS (2026-09-20/22): **live-probed on the attached real Chrome 152 (CDP
> attach via `launchBrowser()`, UI2API_ATTACH_PORT=9222).**
> - `youtube_search` — **VERIFIED** (live round-trip: 11 results read; ok:true
>   rows re-verified through the wire fold #17f).
> - `youtube_transcript` — **UI path VERIFIED to the network gate; segment
>   read-back LOGIN-GATED** (site's own `get_transcript` → HTTP 400
>   "Precondition check failed" for anonymous sessions).
> - **POSTING surface** (`youtube_comment` / `youtube_like` /
>   `youtube_subscribe` / `youtube_upload` / `youtube_playlist_add`) —
>   **implemented + dispatched 2026-09-21 but LOGIN-BOUND** (Google
>   app-bound auth; the only credentialed path is the user's OWN real Chrome
>   attached — see below). Never claimed verified.

## What YouTube is (and is not) here

YouTube is **NOT an AI chat site**. It has no composer→answer surface, so:

- No chat capability is registered (none observed to exist).
- No ChatDriver flow; `profile.json` ships empty `composer`/`answer` and only
  a `urlTemplate` pointing at the site's own results URL.
- The surface we register is: **video search** + **transcript read-back**
  (plus POSTING actions, login-bound — see below).

## Capability surface

| id | flow | status |
|---|---|---|
| `youtube_search` | navigate `https://www.youtube.com/results?search_query={q}` (the site's own page), read rendered rows | **verified-2026-09-20** (re-verified fold #17f) |
| `youtube_transcript` | open `/watch?v=<id>`, expand description, click the site's own "Show transcript" toggle, read panel segments | UI path verified 2026-09-20; segments login-gated (see below) |
| `youtube_comment` / `youtube_like` / `youtube_subscribe` / `youtube_upload` / `youtube_playlist_add` | posting actions on `/capability/youtube` | **implemented + dispatched 2026-09-21, LOGIN-BOUND** — never claimed verified (see below) |

## Verified selectors (observed 2026-09-20, Chrome 152)

### youtube_search — VERIFIED

- Results layout for `?search_query=`: **list**, rows `ytd-video-renderer`
  (10 rows on probe). The grid shape `ytd-rich-item-renderer` did NOT render
  for search (0 rows); `ytd-compact-video-renderer` 0 rows (home/related
  feed tag only).
- Title link: `ytd-video-renderer a#video-title` — **light DOM** (no shadow
  pierce needed), 10/10 rows. `a#video-title-link`: 0 matches on the results
  page. `href` carries `?v=<videoId>`.
- Channel: `ytd-channel-name` (2 per row); metadata: `#metadata-line`.
- Search box on the results page: `input[name="search_query"]`
  (`input#search` absent until masthead focus) — not used; the runner
  navigates the results URL directly.
- No consent wall appeared (anonymous, this egress region).

### youtube_transcript — UI path verified, endpoint login-gated

Observed in order (per attempt, multiple videos):

1. Description expander `tp-yt-paper-button#expand` (inside
   `ytd-text-inline-expander`) — click opens the **structured-description
   modal** (`tp-yt-iron-overlay-backdrop.opened` appears and INTERCEPTS
   Playwright pointer clicks — click via DOM `el.click()` instead; the
   site's own handlers receive it).
2. `button[aria-label="Show transcript"]` — **two copies** exist inside
   `ytd-video-description-transcript-section-renderer`; exactly ONE is laid
   out (`rect.w>0`) — and only AFTER the expand (before it, 0x0 box).
   Playwright `isVisible()` returns false for the 0-box quirk → probe
   `getBoundingClientRect()` in-page. Also present but 0-box: a "Transcript"
   button in a hidden engagement panel and a "Close transcript" button.
3. The click flips
   `ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"]`
   to `visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"` — VERIFIED.
4. The site's own JS then issues `POST /youtubei/v1/get_transcript?prettyPrint=false`
   → **HTTP 400 `{"error":{"code":400,"message":"Precondition check failed."}}`
   for the ANONYMOUS profile** (no SAPISID/LOGIN_INFO/SID; Sign-in button
   present). Panel stays header-only ("In this video / Chapters /
   Transcript" + a lone `ytd-continuation-item-renderer`); segments
   `ytd-transcript-segment-renderer` never render.

Ruled out as causes (all live-tested, same 400): SOCS/CONSENT consent
cookies; the `HeadlessChrome` UA token (normalized → still 400); per-video
caption availability (4 different captioned videos); player gear/kebab menu
paths (no transcript entry in this UI revision); `c` CC shortcut (captions
do not engage anonymously either — the player issued one `api/timedtext`
200 on dQw4w9WgXcQ only).

**Conclusion:** `get_transcript` is session-gated (login or
account-bound precondition). The UI selectors are correct and verified.
**MEASURED (fold #17f, 2026-09-22): a portable logged-in YouTube session is
NOT producible by capture.** Google auth cookies on this box are
**app-bound** (Chrome 152 "portal" encryption — the same gate that blocks
google-ai-search). Replaying the vault
(`data/sessions/youtube.com/merezarezaei@gmail.com/`, source=import) OR a copy
of the real Chrome profile into fresh ephemeral contexts renders **anonymous**
(no account) AND trips YouTube's own "Sign in to confirm you're not a bot".
The **only** working path for transcript read-back AND posting is the user's
**own real Chrome attached** (`UI2API_ATTACH_PORT=9222` / live profile), exactly
like `tencent-aistudio`. Until that attached session is proven, the runner
reports the gate honestly (ok:false with the 400 explanation, or
loginGated:true for posting).

## Wire facts (observed, not driven)

- `/youtubei/v1/get_transcript?prettyPrint=false` — issued BY THE SITE after
  the real "Show transcript" click; 400-gated anonymously. We never call it
  ourselves (no fabricated traffic).
- `/api/timedtext?v=…` — issued by the player for CC on some videos;
  not related to the transcript panel and not driven by us.

## Auth

Optional-cookie for search (anonymous works). **Required (observed) for
transcript segments and ALL posting actions — but a portable session is NOT
capturable (measured fold #17f)**: Google auth cookies are **app-bound**
(Chrome 152 portal encryption), so `ui2api profile capture
"https://www.youtube.com" --login` CANNOT produce a transcript/posting session
that replays into fresh ephemeral contexts — replaying the vault OR a copy of
the real Chrome profile renders anonymous AND trips "Sign in to confirm you're
not a bot". The only credentialed path is the user's OWN real Chrome attached
(`UI2API_ATTACH_PORT=9222` / live profile), exactly like `tencent-aistudio`.
`session.lock.json` stays `awaiting-capture`. For the general one-command bulk
login of every OS Chrome-profile session run `ui2api profile add-all --known`.

## Posting surface (comment / like / subscribe / upload / playlist_add) — LOGIN-BOUND

Implemented + dispatched 2026-09-21 on `/capability/youtube` (were "unknown
youtube capability"): the runner's `openPage()` gained a vault-account ladder
(`data/sessions/<host>/<slug>/` first, then legacy flat snapshot, then cookie
file). **MEASURED login-bound (fold #17f)**: a real account vault EXISTS on the
box (data/sessions/youtube.com/merezarezaei@gmail.com/, source=import) but
Google auth cookies are **browser/app-bound** — replaying the vault OR the real
Chrome profile copy into fresh ephemeral contexts renders anonymous AND trips
YouTube's "Sign in to confirm you're not a bot". Posting therefore needs the
user's OWN real Chrome attached (`UI2API_ATTACH_PORT` / live profile), exactly
like `tencent-aistudio`. These posting caps are dispatched honestly as
login-gated — **never a fabricated post**, and never claimed verified until a
real attached session proves the flip.

## Remaining checklist

1. Attach the user's OWN real Chrome (`UI2API_ATTACH_PORT=9222` / live
   profile) — the only credentialed path (portable `capture --login` is
   disproven, fold #17f).
2. Re-run `youtube_transcript` from that attached session; confirm
   `ytd-transcript-segment-renderer` rows render and
   `.segment-text`/`.segment-timestamp` read back.
3. Record PASS proof and flip transcript + posting status to verified; update
   `capabilities/README.md` + AGENTS.md via the controller.

## Proof (2026-09-20 probe, one line each)

- search: `results?search_query=node.js+crash course` → ytd-video-renderer
  10, `ytd-video-renderer a#video-title` 10, deduped 11 results (first:
  "Node.js Crash Course" — Traversy Media, 32M1al-Y6Ag).
- transcript: expand → button[aria-label="Show transcript"] (w=130 after
  expand) clicked → searchable-transcript panel EXPANDED → site's own
  get_transcript **400 Precondition check failed** → 0 segments (4 videos,
  3+ attempts, anonymous profile).
