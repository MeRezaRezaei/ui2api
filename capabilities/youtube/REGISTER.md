# REGISTER.md — youtube wiring spec for the controller

Everything here is copy-pasteable. I did NOT touch any shared file (parallel
agent `araprat` in flight). Status of this package: **scaffold,
DOM-UNVERIFIED — no live round-trip performed.**

## (a) src/profile/profile.ts builtin entry

**NONE NEEDED.** YouTube is not a chat site (no composer/answer surface), so
no builtin ChatDriver profile is required. The packaged
`capabilities/youtube/profile.json` (id "youtube", empty composer/answer) is
enough for the http.ts route's packaged-JSON fallback. Only add a builtin if
you want `prompt --site youtube` warm-pool behavior later — not recommended
(it would advertise a chat surface that does not exist).

## (b) src/prompt/http.ts — /capability/youtube route

Add the import near the other capability imports (e.g. after the
DeepSeekCapabilities import):

```ts
import { YouTubeCapabilities } from "../capabilities/youtube.js";
```

Add this route block mirroring the deepseek one (place it next to the other
`/capability/<site>` blocks):

```ts
      // YouTube capability surface: video search + transcript read-back
      // (NOT a chat site — no ChatDriver flow). SCAFFOLD, DOM-UNVERIFIED.
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/youtube") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("youtube", profilesById);
        } catch {
          profile = resolveProfile("capabilities/youtube/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new YouTubeCapabilities(profile, { browser: shared, dataDir });
        try {
          const result = await caps.run(capability, (body.args ?? {}) as Record<string, unknown>);
          return send(res, result.ok ? 200 : 502, result);
        } catch (e) {
          return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });
        } finally {
          await caps.close().catch(() => {});
        }
      }
```

Note: `idFrom("youtube", …)` will throw until a builtin exists — that is
fine; the catch falls back to the packaged profile.json (this is the same
registry-first/fallback pattern every route uses).

## (c) capabilities/README.md inventory line

Add under the appropriate inventory section (scaffold/pending):

```markdown
- `youtube` (www.youtube.com) — SCAFFOLD, DOM-UNVERIFIED (2026-09-20). Capability surface, NOT a chat site: `youtube_search` (results page navigation + ytd-video-renderer read-back), `youtube_transcript` (watch page → "Show transcript" panel read-back). Auth optional-cookie (anonymous works; session only pre-answers consent wall). No chat capability — none observed. Selectors are unverified candidates; runner wired in src/capabilities/youtube.ts, honest ok:false "scaffold-dom-unverified" on live-DOM misses.
```

## (d) AGENTS.md site-status line

Add to the "Site status" section (e.g. after the walled/scaffold bullet):

```markdown
- **Scaffold, DOM-UNVERIFIED**: `youtube` (www.youtube.com) — capability surface, NOT a chat site (no chat capability registered; none exists). `youtube_search` + `youtube_transcript` wired (`src/capabilities/youtube.ts`, `/capability/youtube`) with honest ok:false `scaffold-dom-unverified` on live-DOM misses; selectors (ytd-video-renderer, transcript panel) are unverified candidates pending first live capture. Auth optional-cookie.
```

## Also remember at fan-in

- `test/capability-dispatch.test.ts` enforces manifest↔runner sync — after
  wiring (b), the two youtube capabilities + their `youtube_`-prefixed names
  must match the manifest ids (they do: `youtube_search`, `youtube_transcript`).
- `test/validate-packages.test.ts` discovery list (`expected` array) does NOT
  include youtube — the suite auto-walks `capabilities/`, so youtube gets its
  own `capability package: youtube` test automatically; adding it to the
  `expected` list is optional hardening (up to you; I did not touch tests).
- `session.lock.json` exists with status `awaiting-capture` (the pending
  pattern used by blackbox/google-ai-search) because validate-packages check D
  REQUIRES the file for every package dir.
