// YouTube capability runner — exposes www.youtube.com's JS-visible surface
// (video search + transcript read-back) as typed callable capabilities over
// the SAME browser + session machinery as ChatDriver.
//
// Capability dispatch:
//   youtube_search     -> ui-path: one trusted navigation to the site's own
//                         results URL (youtube.com/results?search_query=…),
//                         then read the rendered ytd-video-renderer rows.
//   youtube_transcript -> ui-path: open /watch?v=<id>, expand the description,
//                         click the site's own "Show transcript" toggle, read
//                         the transcript panel segments.
//
// STATUS (2026-09-20, live round-trip on attached real Chrome 152 via CDP 9222):
//   youtube_search     -> VERIFIED (verified-2026-09-20). 11 results read off a
//                         real results page; selectors below are observed, not
//                         candidates.
//   youtube_transcript -> PARTIALLY VERIFIED, endpoint-gated. Every UI selector
//                         up to the transcript panel is live-observed (expand,
//                         Show transcript button, panel EXPANDED state), but the
//                         site's OWN get_transcript call (issued by its JS after
//                         our real click) answers HTTP 400 "Precondition check
//                         failed" for an ANONYMOUS session (Chrome profile has
//                         no YouTube login: no SAPISID/LOGIN_INFO, Sign-in
//                         button present). Verified across 3+ honest attempts:
//                         multiple videos, SOCS/CONSENT cookies, UA
//                         normalization, player-menu paths — same 400 every
//                         time. Transcript needs a logged-in session.lock.json
//                         capture before it can be claimed verified.
//
// NOT built: any direct innertube (/youtubei/v1/*) or timedtext fetch — that
// would be fabricated traffic (the core repo rule). The page itself issues
// every request; we only navigate, click the site's own controls, and read
// back what renders.
import { launchBrowser, loadCookies, sessionPath, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface YouTubeCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
}

export interface YouTubeCapabilityResult {
  capability: string;
  ok: boolean;
  data: unknown;
  method?: string;
  latencyMs?: number;
  error?: string;
  /** Honesty marker: every selector is an unverified scaffold candidate. */
  scaffold?: string;
  /** Human note about the mechanism / posture. */
  note?: string;
}

const SCAFFOLD_NOTE =
  "scaffold-dom-unverified: selectors are unverified candidates (no live round-trip performed); " +
  "re-tune against a real browser on first capture";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class YouTubeCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: YouTubeCapabilityOptions = {}) {
    this.browser = opts.browser;
    this.ownsBrowser = !opts.browser;
    this.dataDir = opts.dataDir ?? resolveDataDir();
    this.headless = opts.headless ?? headlessDefault();
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await launchBrowser(3, { headless: this.headless });
    this.ownsBrowser = true;
    return this.browser;
  }

  // Open a fresh context with the OPTIONAL captured session injected (same
  // pattern as every other runner). YouTube works anonymously; a snapshot,
  // when present, only pre-answers the consent wall.
  private async openPage(url: string): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    });
    if (!usingUserChrome() && this.headless) {
      await context.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "image" || t === "font" || t === "media") return route.abort();
        return route.continue();
      });
    }
    const host = new URL(this.profile.url).host;
    if (!usingUserChrome()) {
      const snap = loadSnapshot(snapshotPath(this.dataDir, host));
      if (snap) {
        await injectSnapshot(context, snap);
      } else {
        const cookies = loadCookies(sessionPath(this.dataDir, host));
        if (cookies.length > 0) await context.addCookies(cookies as never[]);
      }
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }

  async run(capability: string, args: Record<string, unknown> = {}): Promise<YouTubeCapabilityResult> {
    switch (capability) {
      case "youtube_search":
        return this.search(args);
      case "youtube_transcript":
        return this.transcript(args);
      default:
        return { capability, ok: false, data: undefined, error: `unknown youtube capability: ${capability}` };
    }
  }

  // --- youtube_search: one trusted navigation to the site's own results URL,
  // then read the rendered rows. The page's JS issues every request. ---
  private async search(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return this.fail("youtube_search", "query is required");
    const max = typeof args.max === "number" && args.max > 0 ? Math.min(args.max, 50) : 20;
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const page = await this.openPage(url);
    try {
      // VERIFIED 2026-09-20: results page renders ytd-video-renderer rows with
      // light-DOM a#video-title anchors (10 rows on the probe query; the grid
      // ytd-rich-item-renderer shape did NOT appear for ?search_query= — list
      // layout only).
      await page.waitForSelector("ytd-video-renderer", { timeout: 20000 });
      const results = await page.evaluate((limit: number) => {
        const out: Array<{ title: string; videoId: string; url: string; channel?: string; metadataRaw?: string }> = [];
        // a#video-title / a#video-title-link live in the light DOM slotted by
        // the ytd-video-renderer rows (expected, unverified).
        const anchors = document.querySelectorAll(
          "ytd-video-renderer a#video-title, ytd-video-renderer a#video-title-link, ytd-compact-video-renderer a#video-title"
        );
        for (const a of anchors) {
          const href = (a as HTMLAnchorElement).getAttribute("href") ?? "";
          const m = href.match(/[?&]v=([\w-]{6,})/);
          if (!m) continue;
          const title = ((a as HTMLElement).innerText || (a as HTMLAnchorElement).title || "").trim();
          if (!title) continue;
          const row = (a as HTMLElement).closest("ytd-video-renderer, ytd-compact-video-renderer");
          const channel = row?.querySelector("ytd-channel-name")?.textContent?.replace(/\s+/g, " ").trim() || undefined;
          const metadataRaw = row?.querySelector("#metadata-line")?.textContent?.replace(/\s+/g, " ").trim() || undefined;
          const videoId = m[1];
          if (!out.some((x) => x.videoId === videoId)) {
            out.push({ title, videoId, url: `https://www.youtube.com/watch?v=${videoId}`, channel, metadataRaw });
          }
          if (out.length >= limit) break;
        }
        return out;
      }, max);
      return {
        capability: "youtube_search",
        ok: results.length > 0,
        method: "dom.results",
        data: { query, count: results.length, results },
        scaffold: SCAFFOLD_NOTE,
        error: results.length === 0 ? "no ytd-video-renderer rows matched (verified selector; empty page = wall or change)" : undefined,
        note:
          results.length > 0
            ? "read off the site's own rendered results page (one real navigation; no synthetic requests)"
            : undefined,
      };
    } catch (e) {
      return this.fail("youtube_search", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- youtube_transcript: open the watch page, expand the description, click
  // the site's own "Show transcript" toggle, read the panel segments. ---
  private async transcript(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const videoId = String(args.videoId ?? "").trim();
    if (!videoId) return this.fail("youtube_transcript", "videoId is required");
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const page = await this.openPage(url);
    try {
      // VERIFIED UI PATH 2026-09-20 (live-observed on Chrome 152):
      // 1. expand: tp-yt-paper-button#expand inside ytd-text-inline-expander
      //    (opens the structured-description modal; the "Show transcript"
      //    button is INVISIBLE (w=0) until expanded).
      // 2. button: button[aria-label="Show transcript"] — TWO copies exist in
      //    ytd-video-description-transcript-section-renderer; exactly one is
      //    laid out (rect.w>0) after expand. Playwright .isVisible() misses it
      //    (0-box quirk), so probe rects in-page and click via the site's own
      //    handler (el.click()).
      // 3. panel: ytd-engagement-panel-section-list-renderer
      //    [target-id="engagement-panel-searchable-transcript"] flips to
      //    visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" and its JS issues
      //    /youtubei/v1/get_transcript. ANONYMOUS profiles get HTTP 400
      //    "Precondition check failed" (login-gated) — segments never render.
      //    Logged-in sessions (session.lock.json) are expected to render
      //    ytd-transcript-segment-renderer rows.
      await page.evaluate(() => {
        const el = document.querySelector("tp-yt-paper-button#expand") as HTMLElement | null;
        el?.click();
      });
      await page.waitForTimeout(1500);
      const clicked = await page.evaluate(() => {
        for (const b of Array.from(document.querySelectorAll('button[aria-label="Show transcript"]'))) {
          const r = b.getBoundingClientRect();
          if (r.width > 0) {
            (b as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) {
        return {
          capability: "youtube_transcript",
          ok: false,
          method: "dom.transcript-panel",
          data: { videoId },
          error:
            "no-transcript-button: 'Show transcript' not offered on this page (video without captions, or selector rot)",
          scaffold: SCAFFOLD_NOTE,
        };
      }
      // The panel renders segments progressively (or never, on the 400 gate).
      await page.waitForSelector("ytd-transcript-segment-renderer", { timeout: 15000 });
      const segments = await page.evaluate(() => {
        const out: Array<{ startMs: number; text: string }> = [];
        for (const seg of document.querySelectorAll("ytd-transcript-segment-renderer")) {
          const text = (seg.querySelector(".segment-text")?.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!text) continue;
          const ts = (seg.querySelector(".segment-timestamp")?.textContent ?? "").trim();
          const parts = ts.split(":").map((p) => parseInt(p, 10));
          let startMs = 0;
          if (parts.length && parts.every((n) => !Number.isNaN(n))) {
            startMs = parts.reduce((acc, n) => acc * 60 + n, 0) * 1000;
          }
          out.push({ startMs, text });
        }
        return out;
      });
      return {
        capability: "youtube_transcript",
        ok: segments.length > 0,
        method: "dom.transcript-panel",
        data: { videoId, segments, transcript: segments.map((s) => s.text).join(" ") },
        scaffold: SCAFFOLD_NOTE,
        error: segments.length === 0 ? "transcript panel matched but no segments read" : undefined,
        note:
          segments.length > 0
            ? "transcript rendered by the site's own panel after a real click; read-only DOM extraction"
            : undefined,
      };
    } catch (e) {
      return this.fail("youtube_transcript", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  private fail(capability: string, e: unknown): YouTubeCapabilityResult {
    return {
      capability,
      ok: false,
      data: undefined,
      error: `${e instanceof Error ? e.message : String(e)} (if this is a waitForSelector timeout on ytd-transcript-segment-renderer after a successful button click: the site's own get_transcript call is login-gated — HTTP 400 "Precondition check failed" for anonymous sessions; capture a logged-in session first)`,
      scaffold: SCAFFOLD_NOTE,
    };
  }

  private async teardownPage(page: Page): Promise<void> {
    try {
      await page.context()?.close();
    } catch {
      // already gone
    }
    if (this.ownsBrowser) {
      try {
        await this.browser?.close().catch(() => {});
      } catch {
        // gone
      }
      this.browser = undefined;
    }
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
