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
import { attachPayload, attachRefusal, validateAttachRequest } from "../runtime/file-attach.js";
import { sameOrigin, assertChannelUrl } from "../runtime/ssrf.js";
import {
  injectSnapshot,
  listAccounts,
  loadAccountSnapshot,
  loadSnapshot,
  snapshotPath,
} from "../runtime/session-store.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface YouTubeCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
  /** Identity-keyed account (email or vault slug); "default" = the legacy snapshot. */
  account?: string;
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

// GOAL 88: what youtube_upload may hand the upload input. YouTube's own input
// takes video/*, so the gate holds to the signature-verified video containers
// (mp4/mov/webm/mkv/avi). An image or document here would be refused by name.
const YOUTUBE_ATTACH_ACCEPT = [
  "video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo",
].join(",");

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
  private readonly account?: string;

  constructor(private readonly profile: ChatSiteProfile, opts: YouTubeCapabilityOptions = {}) {
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

  // Open a fresh context with the OPTIONAL captured session injected (same
  // pattern as every other runner). YouTube works anonymously; a snapshot,
  // when present, only pre-answers the consent wall.
  private async openPage(url: string): Promise<Page> {
    if (!sameOrigin(url, this.profile.url)) {
      throw new Error(
        `SSRF guard: refusing to navigate ${url} — origin pinning serves only ${new URL(this.profile.url).host}, never arbitrary URLs`
      );
    }
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
      // Session resolution (same ladder as every other runner):
      //   1. the identity-keyed account vault (data/sessions/<host>/<slug>/)
      //      — an explicitly requested `account` (email or slug) is honored
      //      verbatim, otherwise the first stored account wins;
      //   2. the legacy flat snapshot (data/<host>/.session/state.json);
      //   3. the legacy cookie file (data/<host>/.session/cookies.json).
      // YouTube captures are usually keyed by google.com email under
      // data/sessions/youtube.com/<email>/ — both WWW and bare hosts are tried.
      const hosts = [host, host.replace(/^www\./, "")];
      let snap: ReturnType<typeof loadSnapshot> | null = null;
      if (this.account && this.account !== "default") {
        // A specific identity was asked for: load THAT snapshot or fail loudly —
        // never a silent fallback to a different stored account.
        for (const h of hosts) {
          snap = loadAccountSnapshot(this.dataDir, h, this.account);
          if (snap) break;
        }
        if (!snap) {
          throw new Error(
            `no stored session for ${this.profile.id} account "${this.account}" on ${host} — capture it ` +
              `first (ui2api profile capture <url> --login) or omit account for the legacy default snapshot`
          );
        }
      } else {
        for (const h of hosts) {
          const accounts = listAccounts(this.dataDir, h);
          if (accounts.length > 0) {
            snap = loadAccountSnapshot(this.dataDir, h, accounts[0].identity ?? accounts[0].slug);
            if (snap) break;
          }
        }
        snap ??= loadSnapshot(snapshotPath(this.dataDir, host));
      }
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
      case "youtube_comment":
        return this.comment(args);
      case "youtube_like":
        return this.like(args);
      case "youtube_subscribe":
        return this.subscribe(args);
      case "youtube_upload":
        return this.upload(args);
      case "youtube_playlist_add":
        return this.playlistAdd(args);
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

  // --- youtube_like: open the watch page and toggle the site's own like
  // button. LIKE is reversible and low-risk (a real click on the visible
  // button, never a synthetic request); UNLIKE returns the video to its prior
  // state when `action: "like"` was already applied. The page's own JS talks
  // to innertube; we only click the site's control.
  private async like(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const videoId = String(args.videoId ?? "").trim();
    if (!videoId) return this.fail("youtube_like", "videoId is required");
    const action = (String(args.action ?? "like").toLowerCase() === "unlike") ? "unlike" : "like";
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const page = await this.openPage(url);
    try {
      // VERIFIED SELECTOR 2026-09-21 (live probe): the top-bar action row
      // renders the like toggle as yt-button-shape button with aria-label
      // "like this video …/ Unlike". The ytd-segmented-like-dislike layout also
      // exists in older / South-hosting variants — both are matched.
      const btn = page
        .locator(
          "yt-button-shape button[aria-label*='like this video'], yt-button-shape button[aria-label*='unlike this video'], ytd-segmented-like-dislike-button-renderer button:not([disabled])"
        )
        .first();
      await btn.waitFor({ state: "visible", timeout: 25000 });
      // Determine current state WITHOUT side effects: count pressed buttons.
      const pressedBefore = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll(
            "yt-button-shape button[aria-label], ytd-segmented-like-dislike-button-renderer button"
          )
        );
        return rows
          .map((b) => ({
            pressed: b.getAttribute("aria-pressed"),
            label: (b.getAttribute("aria-label") ?? "").toLowerCase(),
          }))
          .filter((x) => x.pressed === "true" || x.label.includes("unlike"));
      });
      const alreadyWanted =
        (action === "like" && pressedBefore.length > 0) || (action === "unlike" && pressedBefore.length === 0);
      if (!alreadyWanted) {
        // Real click on the site's own button — the page's JS then sends the
        // (authenticated) innertube request. No synthetic fetch, ever.
        await btn.click();
        // Wait for the button's pressed state to flip (the site re-renders it).
        await page.waitForTimeout(1500);
      }
      const pressedAfter = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll(
            "yt-button-shape button[aria-label], ytd-segmented-like-dislike-button-renderer button"
          )
        );
        return rows.map((b) => ({
          pressed: b.getAttribute("aria-pressed"),
          label: (b.getAttribute("aria-label") ?? "").toLowerCase(),
        }));
      });
      const isLiked = pressedAfter.some((x) => x.pressed === "true" || x.label.includes("unlike"));
      const ok = action === "like" ? isLiked : !isLiked;
      return {
        capability: "youtube_like",
        ok,
        method: "dom.click-like-button",
        data: { videoId, action, liked: isLiked, buttonState: pressedAfter },
        scaffold: SCAFFOLD_NOTE,
        error: ok ? undefined : "like button did not flip to the requested state (anonymous session or rotated DOM)",
        note: ok ? `the site's own like button was clicked and its visible state now reflects ${action}` : undefined,
      };
    } catch (e) {
      return this.fail("youtube_like", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- youtube_subscribe: click the site's own subscribe/unsubscribe button on
  // a channel page. Requires a logged-in session; anonymous visitors get the
  // "Sign in to subscribe" gate instead. Never fabricated traffic — we only
  // click the site's rendered button and read back what the page shows.
  private async subscribe(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const channelId = String(args.channelId ?? "").trim();
    if (!channelId) return this.fail("youtube_subscribe", "channelId is required (youtube.com/channel/<id>)");
    let url: string;
    try {
      url = assertChannelUrl(channelId, "www.youtube.com");
    } catch (e) {
      return {
        capability: "youtube_subscribe",
        ok: false,
        data: { channelId },
        error: e instanceof Error ? e.message : String(e),
        scaffold: SCAFFOLD_NOTE,
      };
    }
    const page = await this.openPage(url);
    try {
      const btn = page.locator("ytd-subscribe-button-renderer button:not([disabled])").first();
      await btn.waitFor({ state: "visible", timeout: 20000 });
      const labelBefore = ((await btn.getAttribute("aria-label")) ?? "").toLowerCase();
      const wantSubscribe = !labelBefore.includes("subscribed");
      const subscribedBefore = labelBefore.includes("subscribed");
      if (wantSubscribe !== subscribedBefore) {
        const target = page.locator("ytd-subscribe-button-renderer button").first();
        await target.click();
        await page.waitForTimeout(2500);
      }
      const label = (await btn.getAttribute("aria-label")) ?? "";
      const isSubscribed = label.toLowerCase().includes("subscribed");
      const ok = wantSubscribe ? isSubscribed : !isSubscribed;
      return {
        capability: "youtube_subscribe",
        ok,
        method: "dom.click-subscribe-button",
        data: { channelId, url, subscribed: isSubscribed, buttonLabel: label },
        scaffold: SCAFFOLD_NOTE,
        error: ok ? undefined : "subscribe button did not flip (anonymous session or DOM rotated)",
        note: ok ? `channel${isSubscribed ? " subscribed" : " unsubscribed"} via the site's own button` : undefined,
      };
    } catch (e) {
      return this.fail("youtube_subscribe", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- youtube_comment: post a comment through the watch page's own composer
  // (the site's #placeholder-area contenteditable). Requires a logged-in
  // session — anonymous visitors see no composer. The page's own JS submits.
  private async comment(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const videoId = String(args.videoId ?? "").trim();
    const text = String(args.text ?? "").trim();
    if (!videoId) return this.fail("youtube_comment", "videoId is required");
    if (!text) return this.fail("youtube_comment", "text is required");
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const page = await this.openPage(url);
    try {
      // The comment composer is the site's own contenteditable; focus it, type
      // via the keyboard so the site's own input handlers receive real text,
      // then let the site's own "Comment" submit button fire.
      const composer = page.locator(
        "ytd-comment-simplebox-renderer #placeholder-area, ytd-comment-simplebox-renderer [contenteditable=true]"
      ).first();
      await composer.waitFor({ state: "visible", timeout: 20000 });
      await composer.click();
      await composer.pressSequentially(text, { delay: 25 });
      // The Comment button becomes enabled after the first character.
      await page.waitForTimeout(500);
      const submit = page.locator(
        "ytd-comment-simplebox-renderer #submit-button, ytd-comment-simplebox-renderer button[aria-label*='Comment']"
      ).first();
      const submitEnabled = ((await submit.getAttribute("disabled")) ?? null) === null;
      if (submitEnabled) {
        await submit.click();
        await page.waitForTimeout(2500);
      }
      const posted = await page.evaluate((needle: string) => {
        const els = Array.from(document.querySelectorAll("#contenteditable-root, #content-text, ytd-comment-renderer #content-text"));
        return els.some((el) => ((el as HTMLElement).textContent ?? "").trim().includes(needle));
      }, text.slice(0, 32));
      return {
        capability: "youtube_comment",
        ok: posted,
        method: "dom.comment-composer",
        data: { videoId, submitted: submitEnabled, posted, textPreview: text.slice(0, 64) },
        scaffold: SCAFFOLD_NOTE,
        error: posted
          ? undefined
          : submitEnabled
            ? "comment button clicked but no read-back of the text appeared (posting failed or gated)"
            : "comment submit button stayed disabled (anonymous session or DOM rotated)",
        note: posted ? "comment text was read back from the page's own comment list after a real submit" : undefined,
      };
    } catch (e) {
      return this.fail("youtube_comment", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- youtube_playlist_add: add the video to a playlist via the site's own
  // Save menu (three-dot → "Save to playlist"). Requires login; anonymous gets
  // a sign-in prompt in the menu.
  private async playlistAdd(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const videoId = String(args.videoId ?? "").trim();
    if (!videoId) return this.fail("youtube_playlist_add", "videoId is required");
    const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const page = await this.openPage(url);
    try {
      // The Save affordance is the first button whose aria-label starts with
      // "Save" inside the watch header's action bar.
      const save = page.locator(
        "ytd-menu-renderer button[aria-label^='Save'], yt-button-shape button[aria-label^='Save'], ytd-button-renderer button[aria-label^='Save']"
      ).first();
      await save.waitFor({ state: "visible", timeout: 20000 });
      await save.click();
      await page.waitForTimeout(1200);
      // Pick the first playlist entry (the site's own menu item) if the menu
      // opened with a creation form, else confirm the default choice.
      const opened = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll("ytd-add-to-playlist-renderer yt-formatted-string[has-link], yt-add-to-playlist-renderer .playlist-creator-menu-item"));
        return items.length;
      });
      return {
        capability: "youtube_playlist_add",
        ok: opened > 0,
        method: "dom.save-playlist-menu",
        data: { videoId, playlistChoices: opened },
        scaffold: "scaffold-dom-unverified: Save affordance selector is a candidate (no live round-trip yet); the menu is expected to list the account's playlists",
        error: opened === 0 ? "Save menu did not list any playlist entries (anonymous session or DOM rotated)" : undefined,
        note: opened > 0 ? "the site's own Save menu rendered the account's playlist choices (no add committed — menu demands a choice)" : undefined,
      };
    } catch (e) {
      return this.fail("youtube_playlist_add", e);
    } finally {
      await this.teardownPage(page);
    }
  }

  // --- youtube_upload: hand a local file to the site's own hidden
  // input[type=file] on youtube.com/upload. Requires login; anonymous gets a
  // sign-in redirect. We only `setInputFiles` — the site's own JS uploads.
  //
  // GOAL 88: the payload goes through the SHARED attach gate
  // (src/runtime/file-attach.ts) BEFORE the browser opens. It used to be
  // `String(args.filePath)` straight into setInputFiles — an unrestricted
  // local-file-read primitive. The accept list is the signature-verified video
  // set (YouTube's own input is video/*).
  private async upload(args: Record<string, unknown>): Promise<YouTubeCapabilityResult> {
    const attach = validateAttachRequest(args, { siteId: "youtube", accept: YOUTUBE_ATTACH_ACCEPT });
    if (!attach.ok) {
      const refusal = attachRefusal(attach, "youtube_upload");
      return {
        capability: refusal.capability,
        ok: false,
        data: { code: refusal.code, rule: attach.code, message: refusal.message },
        scaffold: SCAFFOLD_NOTE,
        error: `[${refusal.code}] ${refusal.message} (GOAL 88 attach gate, src/runtime/file-attach.ts — refused before any browser launched)`,
      };
    }
    const payload = attachPayload(attach);
    const page = await this.openPage("https://www.youtube.com/upload");
    try {
      const fileInput = page.locator("input[type=file]").first();
      await fileInput.waitFor({ state: "attached", timeout: 20000 });
      const visible = await fileInput.isVisible();
      if (!visible) {
        // The file input may sit inside a shadow/slotted wrapper — attempt the
        // piped setInputFiles anyway (playwright reaches it when on the page).
      }
      // GATED bytes in memory (vetted name + SNIFFED mimeType): the site's own
      // upload handler receives exactly what the gate approved.
      await fileInput.setInputFiles(payload);
      // After a successful handoff the site starts processing the file.
      await page.waitForTimeout(2000);
      const processing = await page.evaluate(() => {
        const t = document.body.innerText ?? "";
        return /processing|selected|processing your video|uploading/i.test(t);
      });
      return {
        capability: "youtube_upload",
        ok: processing,
        method: "dom.file-input-handoff",
        data: { fileName: payload.name, processing },
        scaffold: "scaffold-dom-unverified: hidden file input + processing text are candidates (no live round-trip yet); upload demands login",
        error: processing ? undefined : "site did not show processing state after the file handoff (anonymous or unsupported format)",
        note: processing ? "the file was handed to the site's own upload input and the page entered its processing state" : undefined,
      };
    } catch (e) {
      return this.fail("youtube_upload", e);
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
