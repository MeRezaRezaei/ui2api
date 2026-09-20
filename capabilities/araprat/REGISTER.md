# araprat — controller wiring spec

Copy-pasteable blocks for the fan-in wiring. The package + runner are
self-contained; nothing below is applied yet (parallel-agent safety — the
controller owns shared files).

Identity note: user's "araprat" → **Aparat** (www.aparat.com, Persian
video-sharing platform), resolved via web search; the araprat.* domains do
not exist. NOT a chat site — video discovery surface. Scaffold, nothing
live-verified.

## (a) src/profile/profile.ts — builtin profile entry

Insert into the `BUILTIN_AI_SITES` object (e.g. after `tencent-aistudio`):

```ts
  araprat: {
    id: "araprat",
    name: "Aparat (www.aparat.com) — Persian video-sharing platform",
    url: "https://www.aparat.com",
    loginRequired: false,
    loginHint: "anonymous browsing works for search/watch; capture a logged-in session only for account-scoped actions: npx tsx src/cli.ts profile capture https://www.aparat.com --login",
    composer: [],
    send: { kind: "keyEnter" },
    answer: [],
    captureMs: 60000,
    stableMs: 3000,
    urlTemplate: "https://www.aparat.com/search/{q}",
    note: "SCAFFOLD — video platform, not a chat site ('araprat' resolved to Aparat via web search). composer/answer intentionally empty (no ChatDriver flow); runners read a[href*='/v/'] grids + og: meta off rendered pages — UNVERIFIED until first live capture.",
  },
```

## (b) src/prompt/http.ts — /capability/araprat route

1. Import (next to the other capability runners):

```ts
import { ArapratCapabilities } from "../capabilities/araprat.js";
```

2. Route handler (mirror the deepseek block; registry-first,
packaged-JSON-fallback profile resolution):

```ts
      // Aparat capability surface: video search / trending / video-detail.
      // SCAFFOLD: every capability returns honest ok:false scaffold-dom-unverified
      // until selectors survive a live capture (not a chat site — no ChatDriver).
      // Registry-first, packaged-JSON-fallback profile resolution.
      if (req.method === "POST" && req.url === "/capability/araprat") {
        const body = await readJson(req);
        const capability = String(body.capability ?? "");
        if (!capability) return send(res, 400, { error: "capability is required" });
        let profile: ChatSiteProfile;
        try {
          profile = idFrom("araprat", profilesById);
        } catch {
          profile = resolveProfile("capabilities/araprat/profile.json");
        }
        const shared = await pool.sharedBrowser();
        const caps = new ArapratCapabilities(profile, { browser: shared, dataDir });
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

Note: `test/capability-dispatch.test.ts` enforces manifest ↔ runner sync —
wiring this route likely requires adding the araprat capability ids to that
test (controller's call; the runner implements exactly the three manifest
capabilities: `araprat_search`, `araprat_trending`, `araprat_video_detail`).

## (c) capabilities/README.md — inventory line

Add under the scaffold/pending section:

```md
- `araprat` — Aparat (www.aparat.com, Persian video platform; "araprat" resolved via web search — araprat.* domains don't exist). SCAFFOLD, DOM-UNVERIFIED: search/trending/video-detail recipes only; runner returns honest ok:false. NOT a chat site. Session awaiting-capture.
```

## (d) AGENTS.md — site-status line

Add under "Site status":

```md
- **Scaffold (identity-resolved, unverified)**: `araprat` = Aparat
  (www.aparat.com) — Persian video-sharing platform ("araprat" resolved via
  web search; literal araprat.* domains don't exist). NOT a chat site;
  surface = search/trending/video-detail reads. All selectors UNVERIFIED
  candidates; runner returns ok:false "scaffold-dom-unverified" until a live
  capture (start with `npx tsx src/cli.ts analyse https://www.aparat.com`).
```
