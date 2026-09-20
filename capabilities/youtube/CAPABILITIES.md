# YouTube (www.youtube.com) — capability surface

> STATUS: **SCAFFOLD, DOM-UNVERIFIED — no live round-trip performed.**
> Registered 2026-09-20 because the user said "we need them later." Nothing
> below has been observed in a browser; no static bundle analysis was run.
> Every selector is a **candidate** from prior public UI knowledge, phrased
> as *expected/likely, unverified*.

## What YouTube is (and is not) here

YouTube is **NOT an AI chat site**. It has no composer→answer surface, so:

- No chat capability is registered (none observed to exist).
- No ChatDriver flow; `profile.json` ships empty `composer`/`answer` and only
  a `urlTemplate` pointing at the site's own results URL.
- The surface we register is: **video search** + **transcript read-back**.

## Capability surface

| id | flow | status |
|---|---|---|
| `youtube_search` | navigate `https://www.youtube.com/results?search_query={q}` (the site's own page), read rendered rows | scaffold, DOM-UNVERIFIED |
| `youtube_transcript` | open `/watch?v=<id>`, expand description, click the site's own "Show transcript" toggle, read panel segments | scaffold, DOM-UNVERIFIED |

## Known selectors (all unverified candidates)

- Search box: `input#search` (expected, unverified — NOT used by the runner;
  we navigate the results URL directly, which is the same page the box lands
  on).
- Results rows: `ytd-video-renderer` with title link `a#video-title`
  (href carries `?v=<videoId>`); compact variant `ytd-compact-video-renderer`
  (expected, unverified). Channel: `ytd-channel-name`; metadata line:
  `#metadata-line` (expected, unverified).
- Transcript path: description expander `tp-yt-paper-button#expand` /
  `#description-inline-expander #expand` → "Show transcript" button
  (`button[aria-label*="Show transcript"]` or
  `ytd-video-description-transcript-section-renderer button`, expected,
  unverified) → segments `ytd-transcript-segment-renderer` with
  `.segment-timestamp` / `.segment-text` (expected, unverified).
- Consent wall (EU): accept button `button[aria-label*="Accept the use"]`,
  `button[aria-label*="Accept all"]` (expected, unverified — captured as
  `dismiss[]` candidates in profile.json).

## Wire facts

None observed. YouTube's internal API (likely innertube `/youtubei/v1/*`,
**expected, unverified**) is deliberately NOT driven directly — that would
violate the no-fabricated-traffic rule. Every request is issued by the page
itself after a real navigation/click.

## Auth

Optional-cookie. Anonymous search works; a captured session
(`ui2api profile capture "https://www.youtube.com"`) only pre-answers the
consent wall and reflects region/account. See `session.lock.json`
(status `awaiting-capture`).

## First live capture checklist (for the verifying agent)

1. Headed/real-Chrome run per repo bench rules (`launchBrowser()` seam only).
2. Verify results selectors on `/results?search_query=`; pierce shadow DOM if
   needed (ytd-* web components).
3. Verify the transcript toggle path on a video known to offer transcripts.
4. Record honest proof (PASS id) and flip statuses from scaffold to verified;
   update `capabilities/README.md` + AGENTS.md via the controller.
