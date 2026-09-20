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
// HONESTY STATUS (2026-09-20): SCAFFOLD — NO live round-trip. No bundle
// analysis, no wire capture, no browser run. Every selector mentioned in
// capabilities/araprat/ (a[href*='/v/'], og: meta tags) is an UNVERIFIED
// candidate guess. Until a live capture verifies them, every capability
// returns ok:false "scaffold-dom-unverified" with the mechanism documented —
// never a fabricated success.
//
// Wire facts: none captured. Aparat serves internal JSON APIs under
// /api/fa/v1/... (a probe of /api/fa/v1/video/video/search/q/<q> returned
// HTTP 400 — wrong params/headers, honestly left unmapped). Run
// `npx tsx src/cli.ts analyse https://www.aparat.com` to map the real
// search/feed/video endpoints before attempting any read.
import { launchBrowser, usingUserChrome } from "../runtime/browser.js";
import { injectSnapshot, loadSnapshot, snapshotPath } from "../runtime/session-store.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import type { Browser, Page } from "playwright";

export interface ArapratCapabilityOptions {
  browser?: Browser;
  dataDir?: string;
  headless?: boolean;
  /** External browser pool handle — reserved for daemon integration. */
  pool?: Browser;
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
  /** Anti-bot posture note — unknown for this site until first live capture. */
  antiBot?: string;
  /** Human note about the verified mechanism / posture. */
  note?: string;
}

const ANTI_BOT_NOTE =
  "UNKNOWN — no live capture performed yet. Aparat serves a JS-required SPA shell; whether headless " +
  "Chromium receives real rendered content or is blocked/degraded must be recorded on the first live " +
  "capture (treat anti-bot as potentially present).";

const SCAFFOLD_NOTE =
  "scaffold-dom-unverified — 'araprat' resolved to Aparat (video platform, not a chat site) via web " +
  "search; no live browser round-trip yet. Candidate selectors live in capabilities/araprat/recipes/; " +
  "verify them on a live capture before trusting any result.";

function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

function headlessDefault(): boolean {
  return process.env.UI2API_HEADED !== "1";
}

export class ArapratCapabilities {
  private browser?: Browser;
  private ownsBrowser: boolean;
  private readonly dataDir: string;
  private readonly headless: boolean;

  constructor(private readonly profile: ChatSiteProfile, opts: ArapratCapabilityOptions = {}) {
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

  // Open a fresh context with any captured session injected (anonymous
  // browsing is expected to work for search/watch — auth.required is false —
  // but that expectation is itself unverified until first capture).
  private async openPage(): Promise<Page> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: usingUserChrome() || !this.headless ? null : { width: 1280, height: 900 },
    });
    const host = new URL(this.profile.url).host;
    if (!usingUserChrome()) {
      const snap = loadSnapshot(snapshotPath(this.dataDir, host));
      if (snap) {
        await injectSnapshot(context, snap);
      }
    }
    const page = await context.newPage();
    await page.goto(this.profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    return page;
  }

  async run(capability: string, _args: Record<string, unknown> = {}): Promise<ArapratCapabilityResult> {
    const base = { antiBot: ANTI_BOT_NOTE };
    switch (capability) {
      case "araprat_search":
      case "araprat_trending":
      case "araprat_video_detail":
        // All three capabilities share the same honesty gate: their recipes
        // document candidate DOM reads (a[href*='/v/'] grids, og: meta) but
        // NONE is live-verified. Returning ok:false without attempting keeps
        // the scaffold honest — flip each case to a real openPage() read once
        // its selectors survive a live capture.
        return {
          ...base,
          capability,
          ok: false,
          data: undefined,
          method: "dom.read (candidate, unimplemented)",
          error: `scaffold-dom-unverified: ${capability} has no live-verified selector yet — ` +
            `candidate flow documented in capabilities/araprat/recipes/${capability}.json. ` +
            `Verify against a real browser capture, then implement the read here.`,
          wireNote:
            "wire RPC unmapped — Aparat's internal /api/fa/v1/... JSON APIs exist (a naive probe " +
            "returned 400) but were not captured. Run: npx tsx src/cli.ts analyse https://www.aparat.com",
          note: SCAFFOLD_NOTE,
        };
      default:
        return { capability, ok: false, data: undefined, error: `unknown araprat capability: ${capability}` };
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
