# Aparat (آپارات) — capability analysis

**Status: scaffold, UNVERIFIED — no live round-trip.** Everything in this
package is identity resolution + route-shape evidence. No bundle analysis, no
wire capture, no browser run. Never treat any selector here as real until a
live capture confirms it.

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
  "please enable JavaScript") — the content is a JS-rendered SPA.

## What this means for the package

Aparat is **NOT an AI chat site**. There is no chat composer; ChatDriver's
composer/answer flow does not apply (profile.json ships empty `composer` /
`answer` arrays by design). The honest ui2api surface is **video discovery**:
search, trending, and video-detail reads driven through the site's own
rendered pages — the same no-fabricated-traffic posture as every other
package: we load real pages in the user's own browser session and read what
the site's own JS renders.

## Capabilities (all DOM-UNVERIFIED candidates)

| id | what it does | evidence level |
|---|---|---|
| `araprat_search` | load `/search/<q>`, read rendered result grid | route evidenced (SPA shell served, not 404); result-grid selectors GUESSED |
| `araprat_trending` | load homepage, read trending grid | homepage evidenced; grid selectors GUESSED |
| `araprat_video_detail` | load `/v/<id>`, read title/description (og: meta fallback) | `/v/<id>` is the known Aparat URL convention, NOT verified this session; selectors GUESSED |

The only selector with any grounding is `a[href*='/v/']` (video anchors) and
`meta[name='og:title']` / `meta[name='og:description']` (og: tags are a
platform convention) — both still candidates until a live capture.

## Wire facts

None captured. Aparat exposes internal JSON APIs under `/api/fa/v1/...`
(a probe of `/api/fa/v1/video/video/search/q/tehran` returned HTTP 400 —
wrong params/headers; not explored further, honestly left unmapped). A
proper wire capture (`npx tsx src/cli.ts analyse https://www.aparat.com`)
should map the real search/feed/video endpoints before any RPC-style
capability is attempted.

## Auth / session

Anonymous browsing appears supported for search/watch (public site, no login
wall on fetch) — `auth.required: false`, `session.lock.json` is
`awaiting-capture`. Account-scoped actions (upload, likes, playlists) are out
of scope for this scaffold. Anti-bot posture UNKNOWN: the first live capture
must record whether headless Chromium receives real content or is
blocked/degraded.

## Next steps to make this real

1. `npx tsx src/cli.ts analyse https://www.aparat.com` — wire capture of the
   search/trending/video-detail XHRs; record real API endpoints.
2. Live DOM verification of the candidate selectors; fix profile/recipes.
3. `npx tsx src/cli.ts profile capture https://www.aparat.com --login` if
   account-scoped capabilities are ever added; lock the session.
4. Live round-trip of all three capabilities before any "verified" wording.
