// Aparat capability runner — exposes the JS-visible surface of www.aparat.com
// as typed callable capabilities over the SAME browser + session machinery as
// ChatDriver.
//
// WHAT THIS SITE IS ("araprat" identity resolution):
//   The user's "araprat" does not resolve as a domain (araprat.com/.ai/.io all
//   fail DNS); web search for "araprat AI chat site" surfaces www.aparat.com —
//   Aparat (آپارات), Iran's largest Persian-language video-sharing platform
//   (the "Iranian YouTube"). Confirmed live by fetch: title
//   "آپارات - سرویس اشتراک ویدیو", JS-required SPA shell. It pairs with the
//   concurrent youtube package (video platforms, not AI chat sites).
//
//   Aparat is NOT a chat site: no composer, no ChatDriver flow. The ui2api
//   surface is video discovery (search / trending / video-detail) read off
//   the site's own rendered pages — same no-fabricated-traffic posture.
//
// LIVE-VERIFIED 2026-09-20 (attached real Chrome 152 over CDP :9222, all
// selectors below observed on the rendered SPA — full log in
// capabilities/araprat/CAPABILITIES.md):
//   - Search input  : header `input[name="search"]` (type=text, class "input";
//                     on /search pages it also carries id="search-input").
//                     Placeholder "جستجوی ویدیو در آپارات". The candidate
//                     `input[name="sarch-input"]` from the scaffold does NOT
//                     exist — the real name is "search".
//   - Search results: /search/<q> renders a grid of `a[href*="/v/"]` anchors
//                     (~60 for "موزیک", 58 for "طنز"; each video appears
//                     twice — thumbnail-anchor + title-anchor, dedupe by id).
//                     Typing into the header input + Enter navigates to
//                     /search/<q> through the site's own JS (VERIFIED).
//   - Trending      : homepage (redirects to /home) renders the same
//                     `a[href*="/v/"]` card grid — 52 anchors observed, card
//                     wrappers `[class*="poster"]` + `[class*="thumb-wrapper"]`
//                     (styled-components hashes: sc-d956e845-0 thumb-wrapper,
//                     sc-2b236230-0 poster column video — hash-rot prone, the
//                     a[href*="/v/"] anchor is the stable selector).
//   - Video detail  : /v/<id> renders `h1` (class "heading title") with the
//                     video title; description in `div.description`; related
//                     videos again as `a[href*="/v/"]` (~22–32 anchors).
//                     IMPORTANT: the SPA does NOT populate og:/twitter: meta
//                     tags on the video route (only og:site_name site-wide) —
//                     the og:* candidates from the scaffold are dead; h1 +
//                     div.description are the verified reads.
//
// Wire facts: none captured. Aparat serves internal JSON APIs under
// /api/fa/v1/... (a probe of /api/fa/v1/video/video/search/q/<q> returned
// HTTP 400 — wrong params/headers, honestly left unmapped). Run
// `npx tsx src/cli.ts analyse https://www.aparat.com` to map the real
// search/feed/video endpoints before attempting any read.
import { launchBrowser, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadAccountSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface ArapratCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
}

export interface ArapratCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Wire-level note — what the RPC path needs before it can be driven directly. */
  wireNote?: string;
  /** Anti-bot posture note. */
  antiBot?: string;
  /** Human note about the verified mechanism / posture. */
  note?: string;
  /** Honest login-gated marker: no captured session exists; recipe shipped, not executable. */
  loginGated?: boolean;
}

const ANTI_BOT_NOTE =
  "none observed 2026-09-20 — the attached real Chrome (CDP :9222) received fully rendered " +
  "content on /home, /search/<q> and /v/<id> (52/60/22 /v/ anchors respectively); no block " +
  "page, no CAPTCHA. Headless-fresh contexts were not separately probed.";

const VERIFIED_NOTE =
  "live-verified 2026-09-20 against the rendered SPA in the attached real Chrome (CDP :9222): " +
  "search 'موزیک' → 60 a[href*='/v/'] result anchors on /search/موزیک; homepage /home → 52 " +
  "a[href*='/v/'] trending anchors; /v/mindkye → h1 title + div.description + 22 related anchors.";

const WIRE_NOTE =
  "wire RPC unmapped — Aparat's internal /api/fa/v1/... JSON APIs exist (a naive probe " +
  "returned 400) but were not captured. Run: npx tsx src/cli.ts analyse https://www.aparat.com";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

// Page-side extraction of a[href*='/v/'] cards — one evaluate body, no nested
// closures (esbuild's __name helper must not leak into the page).
function extractCards(page: Page) {
  return page.evaluate(() => {
    const out: Array<{ id: string; title: string; url: string }> = [];
    const seen = new Set<string>();
    for (const a of document.querySelectorAll("a[href*='/v/']")) {
      const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
      const id = href.replace("/v/", "").split(/[?#/]/)[0];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const img = a.querySelector("img");
      const anchor = a as HTMLAnchorElement;
      let title = ((img && img.alt) || anchor.title || (a.textContent ?? "").trim() || "").trim();
      // thumbnail anchors carry only a duration ("2:03:10") as img.alt — the
      // title anchor for the same id (deduped away here) holds the real text;
      // durations are dropped so the title field stays honest.
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(title)) title = "";
      out.push({ id, title, url: "https://www.aparat.com/v/" + id });
    }
    return out;
  });
}

// Second pass to backfill titles for ids whose first anchor was the thumbnail
// (duration-only): read the longest text among ALL anchors of each id.
function extractCardsFull(page: Page) {
  return page.evaluate(() => {
    const byId = new Map<string, { id: string; title: string; url: string }>();
    for (const a of document.querySelectorAll("a[href*='/v/']")) {
      const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
      const id = href.replace("/v/", "").split(/[?#/]/)[0];
      if (!id) continue;
      const img = a.querySelector("img");
      const raw = ((img && img.alt) || (a as HTMLAnchorElement).title || (a.textContent ?? "").trim() || "").trim();
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw)) continue;
      const prev = byId.get(id);
      if (!prev) byId.set(id, { id, title: raw, url: "https://www.aparat.com/v/" + id });
      else if (raw.length > prev.title.length) prev.title = raw;
    }
    return Array.from(byId.values());
  });
}

export class ArapratCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;
  private readonly account?: string;

  constructor(private readonly profile: ChatSiteProfile, opts: ArapratCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
    this.account = opts.account;
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  // Open a fresh context with any captured session injected (anonymous
  // browsing VERIFIED for search/watch on 2026-09-20 — no auth needed).
  private async openPage(url?: string): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    });
    const host = new URL(this.profile.url).host;
    if (!usingUserChrome()) {
      let snap: ReturnType<typeof loadSnapshot> | null = null;
      if (this.account && this.account !== "default") {
        // Identity-keyed account vault (data/sessions/<host>/<slug>/): load the
        // requested identity's snapshot and inject IT — never a silent fallback
        // to the legacy default identity.
        snap = loadAccountSnapshot(this.dataDir, host, this.account);
        if (!snap) {
          throw new Error(
            `no stored session for ${this.profile.id} account "${this.account}" on ${host} — capture it ` +
              `first (ui2api profile capture <url> --login) or omit account for the legacy default snapshot`
          );
        }
      } else {
        snap = loadSnapshot(snapshotPath(this.dataDir, host));
      }
      if (snap) {
        await injectSnapshot(context, snap);
      }
    }
    const page = await context.newPage();
    if (url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    } else {
      await page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    return page;
  }

  // Hydration gate: the SPA shell paints anchors only after JS boots; a
  // readyState wait is not enough — wait for the actual /v/ nodes (observed
  // ~7–10s after domcontentloaded on this host).
  private async awaitGrid(page: Page, timeoutMs = 30000): Promise<boolean> {
    try {
      await page.waitForSelector("a[href*='/v/']", { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<ArapratCapabilityResult> {
    switch (capability) {
      case "araprat_search":
        return this.search(args);
      case "araprat_trending":
        return this.trending();
      case "araprat_video_detail":
        return this.videoDetail(args);
      // Account-scoped posting surface: declared in the manifest and
      // dispatched HONESTLY as login-gated. Aparat posting actions require a
      // captured logged-in session (none exists in this package — session.lock
      // stays awaiting-capture). Ok:false login-required, no browser opened,
      // no fabricated traffic. Wired in audit fold #17f so manifest ↔ dispatch
      // stay IN-SYNC instead of posting caps falling into the unknown branch.
      case "araprat_comment":
      case "araprat_like":
      case "araprat_follow":
      case "araprat_subscribe":
      case "araprat_upload":
      case "araprat_playlist":
        return this.loginGated(capability);
      default:
        return { capability, ok: false, data: undefined, error: `unknown araprat capability: ${capability}` };
    }
  }

  // Honest login-gated short-circuit: no captured Aparat session exists, so a
  // posting action can only ever return ok:false login-required — NEVER a
  // fabricated success or a dead dispatch. No browser is launched.
  private loginGated(capability: string): ArapratCapabilityResult {
    return {
      capability,
      ok: false,
      data: undefined,
      error:
        `login-required: ${capability} needs an authorized captured Aparat session ` +
        `(ui2api profile capture https://www.aparat.com --login first); recipe shipped, not yet executable`,
      loginGated: true,
    };
  }

  // --- araprat_search: navigate /search/<q>, read the JS-rendered grid ---
  private async search(args: Record<string, unknown>): Promise<ArapratCapabilityResult> {
    const q = String(args.q ?? args.query ?? "").trim();
    if (!q) {
      return { capability: "araprat_search", ok: false, data: undefined, error: "q (search query) is required" };
    }
    const started = Date.now();
    let page: Page | undefined;
    try {
      page = await this.openPage(`https://www.aparat.com/search/${encodeURIComponent(q)}`);
      const hydrated = await this.awaitGrid(page);
      if (!hydrated) {
        return {
          capability: "araprat_search",
          ok: false,
          data: undefined,
          method: "dom.grid",
          latencyMs: Date.now() - started,
          error:
            `no a[href*='/v/'] result anchors rendered on /search/${encodeURIComponent(q)} within 30s ` +
            "(SPA hydration timeout or degraded serve — retry; if persistent, re-verify selectors)",
          antiBot: ANTI_BOT_NOTE,
          wireNote: WIRE_NOTE,
        };
      }
      const results = (await extractCardsFull(page)).slice(0, 40);
      return {
        capability: "araprat_search",
        ok: true,
        method: "dom.grid",
        latencyMs: Date.now() - started,
        data: { query: q, count: results.length, results },
        note: VERIFIED_NOTE,
        wireNote: WIRE_NOTE,
      };
    } catch (e) {
      return this.fail("araprat_search", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- araprat_trending: homepage /home grid ---
  private async trending(): Promise<ArapratCapabilityResult> {
    const started = Date.now();
    let page: Page | undefined;
    try {
      page = await this.openPage(this.profile.url);
      const hydrated = await this.awaitGrid(page);
      if (!hydrated) {
        return {
          capability: "araprat_trending",
          ok: false,
          data: undefined,
          method: "dom.grid",
          latencyMs: Date.now() - started,
          error:
            "no a[href*='/v/'] anchors rendered on the homepage within 30s " +
            "(SPA hydration timeout or degraded serve — retry; if persistent, re-verify selectors)",
          antiBot: ANTI_BOT_NOTE,
          wireNote: WIRE_NOTE,
        };
      }
      const videos = (await extractCardsFull(page)).slice(0, 40);
      return {
        capability: "araprat_trending",
        ok: true,
        method: "dom.grid",
        latencyMs: Date.now() - started,
        data: { count: videos.length, videos },
        note: VERIFIED_NOTE,
        wireNote: WIRE_NOTE,
      };
    } catch (e) {
      return this.fail("araprat_trending", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- araprat_video_detail: /v/<id> title + description + related ---
  private async videoDetail(args: Record<string, unknown>): Promise<ArapratCapabilityResult> {
    const rawId = String(args.id ?? "").trim();
    if (!rawId) {
      return {
        capability: "araprat_video_detail",
        ok: false,
        data: undefined,
        error: "id (aparat video id, e.g. mindkye) or url is required",
      };
    }
    const id = rawId.includes("/v/") ? rawId.split("/v/")[1].split(/[?#/]/)[0] : rawId.replace(/^https?:\/\/[^/]+/, "").replace(/^\/+/, "");
    const url = `https://www.aparat.com/v/${id}`;
    const started = Date.now();
    let page: Page | undefined;
    try {
      page = await this.openPage(url);
      let sawH1 = true;
      try {
        await page.waitForSelector("h1", { timeout: 20000 });
      } catch {
        sawH1 = false;
      }
      // h1 lands BEFORE the description + related grid finish hydrating
      // (observed: h1 at ~3.5s, div.description + related a[href*='/v/']
      // later) — gate on the related anchors too, then settle.
      await page.waitForSelector("a[href*='/v/']", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const detail = await page.evaluate((vid: string) => {
        const h1 = document.querySelector("h1");
        const title = h1 ? (h1.textContent ?? "").trim() : "";
        const desc = document.querySelector("div.description");
        const description = desc ? (desc.textContent ?? "").trim() : "";
        const related: Array<{ id: string; title: string; url: string }> = [];
        const seen = new Set<string>();
        for (const a of document.querySelectorAll("a[href*='/v/']")) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const rid = href.replace("/v/", "").split(/[?#/]/)[0];
          if (!rid || rid === vid || seen.has(rid)) continue;
          seen.add(rid);
          const img = a.querySelector("img");
          let t = ((img && img.alt) || (a as HTMLAnchorElement).title || (a.textContent ?? "").trim() || "").trim();
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) t = "";
          related.push({ id: rid, title: t, url: "https://www.aparat.com/v/" + rid });
        }
        return {
          title,
          description,
          related: related.slice(0, 20),
          relatedCount: related.length,
          docTitle: document.title,
        };
      }, id);
      if (!sawH1 || !detail.title) {
        return {
          capability: "araprat_video_detail",
          ok: false,
          data: undefined,
          method: "dom.detail",
          latencyMs: Date.now() - started,
          error:
            `no h1 title rendered on /v/${id} within 20s — the video may not exist or the SPA ` +
            "served a degraded shell (verify the id manually; og: metas are NOT populated by this SPA)",
          antiBot: ANTI_BOT_NOTE,
          wireNote: WIRE_NOTE,
        };
      }
      return {
        capability: "araprat_video_detail",
        ok: true,
        method: "dom.detail",
        latencyMs: Date.now() - started,
        data: {
          id,
          url,
          title: detail.title,
          description: detail.description || undefined,
          related: detail.related,
          relatedCount: detail.relatedCount,
        },
        note: VERIFIED_NOTE,
        wireNote: WIRE_NOTE,
      };
    } catch (e) {
      return this.fail("araprat_video_detail", e, started);
    } finally {
      await this.teardownPage(page);
    }
  }

  private async teardownPage(page?: Page) {
    if (!page) return;
    try {
      await page.close();
      const ctx = page.context();
      if (ctx) await ctx.close().catch(() => {});
    } catch {
      // gone
    }
  }

  private fail(capability: string, e: unknown, started: number): ArapratCapabilityResult {
    return {
      capability,
      ok: false,
      data: undefined,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
      antiBot: ANTI_BOT_NOTE,
    };
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) {
      try {
        await this.browser?.close().catch(() => {});
      } catch {
        // gone
      }
    }
    this.browser = undefined;
  }
}
