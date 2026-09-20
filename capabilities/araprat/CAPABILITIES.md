# Aparat (آپارات) — capability analysis

**Status: LIVE-VERIFIED 2026-09-20** (attached real Chrome 152 over CDP
`127.0.0.1:9222`, via `launchBrowser()` + `UI2API_ATTACH_PORT`). All three
capabilities completed real round-trips against the JS-rendered SPA. Anti-bot:
none observed — no block page, no CAPTCHA; the attached Chrome received full
content on every route. Proof line: **search "موزیک" → 60 `a[href*='/v/']`
result anchors on `/search/موزیک`**; homepage `/home` → 52 anchors; typed
search "طنز" via header input + Enter → 58 anchors; `/v/mindkye` → `h1` title
`کالکشن 20 موزیک ویدیوی فانک کلاسیک و رقص- شماره 174` + 22 related anchors.

## Identity resolution ("what did the user mean by 'araprat'?")

The user's word "araprat" does not name a resolvable site directly:

- `https://araprat.com`, `www.araprat.com`, `araprat.ai`, `araprat.io` — all
  fail to resolve (transport errors; no such hosts).
- DuckDuckGo web search for "araprat AI chat site" surfaces **www.aparat.com**
  as the top organic hit (the Persian video-sharing service), plus unrelated
  AI-chat sites. The search engine itself normalizes "araprat" toward Aparat.
- **Ruling**: "araprat" = **Aparat** (آپارات, https://www.aparat.com), Iran's
  largest Persian-language video-sharing platform — the "Iranian YouTube".
  This also pairs naturally with the concurrent `capabilities/youtube`
  package (video platforms, not AI chat sites).
- Site confirmed live by fetch: title `آپارات - سرویس اشتراک ویدیو`
  ("Aparat — video sharing service"). The server returns a JS-required shell
  (`برای اجرای این برنامه لطفا جاوا اسکریپت دستگاه خود را فعال کنید` =
  "please enable JavaScript") — the content is a JS-rendered SPA. Raw HTML
  carries **zero** anchors (verified by curl: `/home` 196 KB with no `<a>`,
  `/search/<q>` 47 KB with no `<a>`) — every read below is post-hydration.

## What this means for the package

Aparat is **NOT an AI chat site**. There is no chat composer; ChatDriver's
composer/answer flow does not apply (profile.json ships empty `composer` /
`answer` arrays by design). The honest ui2api surface is **video discovery**:
search, trending, and video-detail reads driven through the site's own
rendered pages — the same no-fabricated-traffic posture as every other
package: we load real pages in the user's own browser session and read what
the site's own JS renders.

## Observed DOM facts (2026-09-20, rendered SPA in attached Chrome)

| fact | selector | observed |
|---|---|---|
| header search input | `input[name="search"]` | type=text, class `input`, placeholder `جستجوی ویدیو در آپارات`; carries `id="search-input"` on /search pages. The scaffold's `input[name="sarch-input"]` does NOT exist. Typing + Enter navigates to `/search/<q>` via the site's own JS — VERIFIED live ("طنز" → 58 results). |
| video anchors (all grids) | `a[href*="/v/"]` | homepage 52, search "موزیک" 60, search "طنز" 58, video page related ~22–32. Each video = TWO anchors (thumbnail + title); hrefs carry `?discovery=1` / `?refererRef=search` suffixes — strip to bare `/v/<id>` and dedupe. |
| card wrappers | `[class*="thumb-wrapper"]`, `[class*="poster"]` | styled-components hashes (`sc-d956e845-0 … thumb-wrapper`, `sc-2b236230-0 … poster column video`) — hash-rot prone; the `/v/` anchor is the stable selector. |
| thumbnail duration | `a[href*="/v/"] img` `alt` | duration strings like `2:03:10` — must NOT be used as titles (filtered in the runner). |
| video title | `h1` | class `heading title` (`sc-510d386d-0`); `document.title` mirrors it. |
| description | `div.description` | full Persian description text. |
| related videos | `a[href*="/v/"]` on `/v/<id>` | ~22–32 anchors, dedupe + strip query. |
| channel block | `div[class*="info"]` | followers/comments/action row (`… دنبال کننده … دیدگاه …`); **no** `a[href*="/profile/"]` anchors on the current UI — channel name read is NOT wired (honest omission). |
| og:/twitter: meta | — | **DEAD on this SPA**: only `og:site_name` exists site-wide; `/v/<id>` does NOT populate og:title/og:description/og:video. The scaffold's og:* candidates are dead — h1 + div.description are the verified reads. |
| hydration timing | — | anchors appear ~7–10 s after `domcontentloaded`; `readyState=complete` happens BEFORE content — always gate on `waitForSelector("a[href*='/v/']")`. |

## Capabilities

| id | what it does | status |
|---|---|---|
| `araprat_search` | load `/search/<q>`, read rendered result grid | **VERIFIED 2026-09-20** (موزیک → 60 anchors) |
| `araprat_trending` | load homepage `/home`, read trending grid | **VERIFIED 2026-09-20** (52 anchors) |
| `araprat_video_detail` | load `/v/<id>`, read `h1` title + `div.description` + related | **VERIFIED 2026-09-20** (/v/mindkye → h1 + 22 related) |

## Wire facts

None captured. Aparat exposes internal JSON APIs under `/api/fa/v1/...`
(a probe of `/api/fa/v1/video/video/search/q/tehran` returned HTTP 400 —
wrong params/headers; not explored further, honestly left unmapped). A
proper wire capture (`npx tsx src/cli.ts analyse https://www.aparat.com`)
should map the real search/feed/video endpoints before any RPC-style
capability is attempted. The DOM paths above are the honest live surface.

## Auth / session

**Anonymous browsing VERIFIED** (2026-09-20): search, trending and video
pages fully rendered with no login wall — `auth.required: false` confirmed
live. `session.lock.json` stays `awaiting-capture` (nothing account-scoped
is exposed). Anti-bot: none observed against the attached real Chrome;
headless-fresh contexts were not separately probed (honest caveat).

## Next steps (optional hardening)

1. `npx tsx src/cli.ts analyse https://www.aparat.com` — wire capture of the
   search/trending/video-detail XHRs; record real API endpoints.
2. Channel-name read (the `div[class*="info"]` block) once a stable selector
   is confirmed.
3. `npx tsx src/cli.ts profile capture https://www.aparat.com --login` if
   account-scoped capabilities are ever added; lock the session.
