// Capture a JS-function index from a real site by wrapping ONLY true network
// senders on the app's window root (gemini's default_BardChatUi, kimi RPC, ...)
// and recording correlated (callId -> network request) pairs.
//
// Methodology (fold #17, GOAL 1): wrapping ALL methods saturates the SPA's
// main thread (CDP never answers -> hang). This wraps only methods whose SOURCE
// literally contains fetch(/XHR/sendBeacon/batchexecute, plus the instrument
// seam keeps the correlation window open 250ms so a fetch fired a tick after
// its call still correlates.
//
// Usage: npx tsx scripts/capture-js-index.ts [site]   (site default "gemini")
// Env:  UI2API_ATTACH_PORT=9222 (append to be used), SNAP_PATH override,
//       WORK dir override (default /ott/ui2api-work)
// Output: $WORK/captures-<site>.json (raw) + capture-<site>-summary.json
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { INSTRUMENT_SRC } from "../src/analyzer/instrument.js";
import { launchBrowser } from "../src/runtime/browser.js";
import { injectSnapshot, loadSnapshot } from "../src/runtime/session-store.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

const site = process.argv[2] ?? "gemini";
const profile = BUILTIN_PROFILES[site as keyof typeof BUILTIN_PROFILES];
if (!profile) throw new Error(`no builtin profile for site ${site}`);

process.env.UI2API_ATTACH_PORT = process.env.UI2API_ATTACH_PORT || "9222";

const WORK = process.env.WORK || "/ott/ui2api-work";
const SNAP_PATH =
  process.env.SNAP_PATH ||
  `/home/me/Documents/projects/ui2api/data/sessions/${new URL(profile.url).host}/merezarezaei@gmail.com/state.json`;
const OUT_RAW = join(WORK, `captures-${site}.json`);
const OUT_SUM = join(WORK, `capture-${site}-summary.json`);
const OUT_LOG = join(WORK, `capture-${site}.log`);

function log(s: string): void {
  console.log(s);
  writeFileSync(OUT_LOG, s + "\n", { flag: "a" });
}

function discoverNetworkSenders(page: Page, rootName: string): void {
  void page.evaluate(
    (src) => {
      (window as unknown as Record<string, unknown>).__ui2api_net_senders =
        ([] as string[]);
      const w = window as unknown as Record<string, unknown>;
      const root = w[rootName];
      if (!root) return;
      for (const [name, fn] of Object.entries(root as Record<string, unknown>)) {
        try {
          const s = (fn as Function).toString();
          if (/fetch|XMLHttpRequest|sendBeacon|batchexecute/i.test(s)) {
            (w.__ui2api_net_senders as string[]).push(name);
          }
        } catch {
          /* not callable */
        }
      }
    },
    INSTRUMENT_SRC + `;__ui2api_net_senders = [];`
  );
  void page;
}

async function main(): Promise<void> {
  writeFileSync(OUT_LOG, `capture ${site} start ${new Date().toISOString()}\n`);
  const browser: Browser = await launchBrowser(3, {
    headless: false,
    attachPort: Number(process.env.UI2API_ATTACH_PORT) || undefined,
  });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const snap = loadSnapshot(SNAP_PATH);
  if (snap) await injectSnapshot(context, snap);
  const page = await context.newPage();
  await page.goto(profile.url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Let the SPA boot (roots exist only after boot).
  await page.waitForTimeout(9000);
  await page.evaluate(INSTRUMENT_SRC);
  console.log("instrument loaded, probing roots…");
  const roots = await page.evaluate(() =>
    Object.keys(window as unknown as Record<string, unknown>).filter(
      (k) =>
        (window as unknown as Record<string, unknown>)[k] &&
        typeof (window as unknown as Record<string, unknown>)[k] === "object"
    )
  );
  log(`roots: ${roots.join(", ")}`);
  const ROOT = profile.jsIndex?.root ?? "default_BardChatUi";
  await page.evaluate(
    (src) => {
      (window as unknown as Record<string, unknown>).__ui2api_evaluate = (name: string) => {
        const root = (window as unknown as Record<string, unknown>)[name];
        return typeof root === "object" ? root : null;
      };
    },
    INSTRUMENT_SRC + ";"
  );
  void discoverNetworkSenders(page, ROOT);
  const senders = await page.evaluate(() => (window as unknown as Record<string, unknown>).__ui2api_net_senders as string[]);
  log(`network senders on ${ROOT}: ${senders.join(", ")}`);

  // Wrap only the network senders (targets filter keeps the SPA alive).
  for (const s of senders) {
    await page.evaluate(
      (x) => {
        void x;
      },
      s
    );
  }
  const wrappedRoot = await page.evaluate(
    (rootName) => {
      const w = window as unknown as Record<string, unknown>;
      const root = w[rootName] as Record<string, unknown>;
      if (w.__ui2api_wrapRoot && root) {
        (w.__ui2api_wrapRoot as (o: unknown, n: string, t: string[]) => void)(root, rootName, (w.__ui2api_net_senders as string[]) || []);
      }
      return !!(w.__ui2api_captures && (w.__ui2api_captures as unknown[]).length);
    },
    ROOT
  );
  log(`wrapped root ${ROOT}: ${wrappedRoot ? "ok" : "NOT WRAPPED"}`);

  // Exercise the app so senders fire (a real user behavior = honest traffic).
  const composerSel = profile.composer[0];
  const composer = page.locator(composerSel).first();
  await composer.waitFor({ timeout: 20000 }).catch(() => {});
  try {
    await composer.click();
    await composer.fill("ping");
    await page.keyboard.press("Enter");
  } catch {
    log("composer interaction failed — relying on boot-time calls only");
  }
  await page.waitForTimeout(12000);
  const captures = await page.evaluate(
    () =>
      (window as unknown as Record<string, unknown>).__ui2api_captures as Array<{
        t: number;
        type: string;
        root?: string;
        method?: string;
        url?: string;
        callId?: string;
      }>
  );
  const summary = {
    site,
    at: new Date().toISOString(),
    captures: captures?.length ?? 0,
    jsFunction: captures?.filter((c) => c.type === "js-function").length ?? 0,
    network: captures?.filter((c) => c.type === "network").length ?? 0,
    correlated: captures?.filter((c) => c.callId && c.url).length ?? 0,
    senders,
  };
  writeFileSync(OUT_RAW, JSON.stringify(captures ?? [], null, 2));
  writeFileSync(OUT_SUM, JSON.stringify(summary, null, 2));
  log(`capture complete: ${JSON.stringify(summary)}`);
  await browser.close().catch(() => {});
}

main().catch((e) => {
  log("capture failed: " + (e instanceof Error ? e.stack ?? e.message : String(e)));
  process.exit(1);
});