// Live harness: proves the JS-function-indexed execution seam THROUGH the seam.
//
// Drives a real site through execJsFunction(page -> live page) — the page's own
// JS, its own session — and prints ok/error/networkHits honestly. Never a mock:
// the browser launch goes through launchBrowser() (the single seam), the session
// is a captured vault snapshot injected before navigation, and the window
// roots+methods are discovered in-page exactly like analyzer/explore.ts.
//
// Env:
//   UI2API_VERIFY_SITE   site id (default "gemini") — profiled + vault snapshot
//   UI2API_CHROME=1      use real Chrome (passed through launchBrowser)
//   UI2API_CHROME_PATH   explicit chrome path (passed through launchBrowser)
//   UI2API_ATTACH_PORT   attach to a running Chrome (never closed when set)
//   UI2API_HEADED=1      headed window (passed through launchBrowser)
//   UI2API_USER_DATA_DIR reuse a real profile (passed through launchBrowser)
//
// Exit 0 only when a read-only window.<root>.<method> call returns
// ok:true AND produced >=1 real network hit. Otherwise exit 1 with a summary
// listing every attempt. Mutating methods are never selected.

import type { Browser, Page } from "playwright";
import {
  launchBrowser,
  userChromeProfile,
} from "../src/runtime/browser.js";
import {
  injectSnapshot,
  listAccounts,
  loadAccountSnapshot,
  vaultRoot,
} from "../src/runtime/session-store.js";
import {
  execJsFunction,
  type JsFunctionIndex,
  type JsCallResult,
} from "../src/runtime/js-exec.js";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

interface Candidate extends JsFunctionIndex {
  source: string;
}

const MAX_CANDIDATES = 10;

// Same param parsing as analyzer/explore.ts.
function parseParams(src: string): string[] {
  const m = src.match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1]
    .split(",")
    .map((s) => s.trim().split(/[=:/]/)[0].trim())
    .filter(Boolean);
}

// Same sample shaping as analyzer/explore.ts.
function sampleFor(name: string): unknown {
  if (/prompt|message|text|query|input|content/i.test(name)) return "test prompt";
  if (/model/i.test(name)) return "default";
  if (/count|limit|max|page|offset|index|id/i.test(name)) return 1;
  if (/enabled|active|flag|debug|verbose/i.test(name)) return true;
  return "test";
}

// The SAME root discovery explore.ts uses (discoverRoots is not exported, so the
// evaluate is replicated). Fully self-contained — no function-valued const
// bindings (esbuild __name helpers must never leak into the page).
function discoverRootsImplicit(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const black = new Set([
      "window", "self", "globalThis", "top", "parent", "frames",
      "localStorage", "sessionStorage", "document", "history", "location",
      "navigator", "screen", "console", "Math", "Date", "JSON", "Object",
      "Array", "Promise", "fetch", "__ui2api",
    ]);
    const found: string[] = [];
    for (const k of Object.getOwnPropertyNames(window as any)) {
      if (black.has(k)) continue;
      try {
        const v = (window as any)[k];
        if (v && typeof v === "object") {
          const props = Object.getOwnPropertyNames(v);
          const fns = props.filter((p) => typeof v[p] === "function");
          if (fns.length >= 1 && fns.length >= props.length * 0.5)
            found.push(k);
        }
      } catch (e) {}
    }
    found.sort(function (a, b) {
      var pa = a === "UI2API" ? 0 : a === "App" ? 1 : 2;
      var pb = b === "UI2API" ? 0 : b === "App" ? 1 : 2;
      return pa - pb;
    });
    return found;
  });
}

// Method-name / body signals. The mutator list is the hard red line — NEVER
// post/submit/delete/send/etc. Without a capture index we only ever pick
// methods whose name and source strongly suggest a read.
const MUTATOR_NAME = /(post|submit|delete|remove|send|write|update|rename|create|destroy|clear|reset|logout|login|sign|save|upload|close|block|report|cancel|toggle)/i;
const READ_BODY = /(return\b|fetch\s*\(|\.json\s*\(|querySelector|querySelectorAll|getElementById|\.get\s*\(|Response|Promise|match\s*\()/;
// Ambient/structural window keys that are never the site's own app surface —
// discoverRoots' own heuristic can pick them up (numeric frame keys, ES
// builtins), and executing window["0"].fetch proves nothing.
const JUNK_ROOT = /^[0-9]+$/;
const BUILTIN_ROOTS = new Set([
  "Intl", "Atomics", "Reflect", "CSS", "Temporal", "WebAssembly", "chrome",
]);

function buildCandidates(
  roots: string[],
  sourcesByRoot: Record<string, Record<string, string>>
): Candidate[] {
  const out: Candidate[] = [];
  const push = (rootName: string, method: string, src: string) => {
    if (out.length >= MAX_CANDIDATES) return;
    const params = parseParams(src);
    out.push({
      root: rootName,
      method,
      params,
      sampleArgs: params.map(sampleFor),
      source: src.slice(0, 140),
    });
  };
  outer: for (const rootName of roots) {
    if (JUNK_ROOT.test(rootName) || BUILTIN_ROOTS.has(rootName)) continue;
    const sources = sourcesByRoot[rootName] ?? {};
    for (const method of Object.keys(sources)) {
      const src = sources[method];
      if (typeof src !== "string" || src.length < 5) continue;
      if (method.startsWith("_")) continue;
      if (MUTATOR_NAME.test(method)) continue;
      if (READ_BODY.test(src)) push(rootName, method, src);
      if (out.length >= MAX_CANDIDATES) break outer;
    }
  }
  // Relax: if scoring rejected everything, still take non-mutating, non-no-op
  // methods so the harness honestly exercises whatever read-ish surface exists.
  if (out.length === 0) {
    outer: for (const rootName of roots) {
      const sources = sourcesByRoot[rootName] ?? {};
      for (const method of Object.keys(sources)) {
        const src = sources[method];
        if (typeof src !== "string" || src.length < 5) continue;
        if (method.startsWith("_")) continue;
        if (MUTATOR_NAME.test(method)) continue;
        if (!/\(\s*\)\s*\{?\s*\}/.test(src)) push(rootName, method, src);
        if (out.length >= MAX_CANDIDATES) break outer;
      }
    }
  }
  return out;
}

function preview(value: unknown): string {
  if (value === undefined) return "undefined";
  const s = JSON.stringify(value);
  if (s === undefined) return String(value);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

async function main(): Promise<void> {
  const site = process.env.UI2API_VERIFY_SITE || "gemini";
  const profile = BUILTIN_PROFILES[site];
  if (!profile) {
    console.log(`no builtin profile for ${site}`);
    process.exitCode = 1;
    return;
  }
  const url = profile.url;
  const host = new URL(url).host;

  // Session: prefer the identity vault, fall back to the legacy flat snapshot.
  const vault = vaultRoot("data");
  let snap = null;
  let usedAccount = "(none)";
  const accounts = listAccounts("data", host);
  if (accounts.length > 0) {
    const first = accounts[0];
    usedAccount = first.identity;
    snap = loadAccountSnapshot("data", host, first.slug);
  }
  if (!snap) snap = loadAccountSnapshot("data", host);
  if (!snap) {
    console.log(`no vault session for ${site} (looked under ${vault}/${host}/ and legacy .session)`);
    console.log("capture one first: ui2api profile capture <url> --login");
    process.exitCode = 1;
    return;
  }

  const attached = Boolean(process.env.UI2API_ATTACH_PORT);
  const usingChrome =
    (process.env.UI2API_CHROME && process.env.UI2API_CHROME !== "0") ||
    Boolean(process.env.UI2API_CHROME_PATH) ||
    userChromeProfile();

  console.log(`verify site=${site} host=${host} account=${usedAccount} attached=${attached} chrome=${usingChrome}`);
  console.log(`vault snapshot: ${vault}/${host}/ <capturedAt=${snap.capturedAt}>`);

  // THE seam: launchBrowser() is the only browser-launch entry — it resolves
  // UI2API_CHROME/_PATH/ATTACH_PORT/USER_DATA_DIR/HEADED from the env itself.
  let browser: Browser;
  try {
    browser = await launchBrowser();
  } catch (e) {
    console.log(`launch failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  const page = await browser.newPage();
  await injectSnapshot(page.context(), snap);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  // Give the app's own JS time to bootstrap its window roots (discovery needs
  // the site's real objects, exactly like analyse).
  await page.waitForTimeout(2500);

  // Read-only discovery of real window roots, same shape as discoverRoots.
  const roots = await discoverRootsImplicit(page);
  console.log(`roots discovered (${roots.length}): ${roots.slice(0, 10).join(", ")}${roots.length > 10 ? ", …" : ""}`);

  const sourcesByRoot: Record<string, Record<string, string>> = {};
  for (const rootName of roots.slice(0, 10)) {
    sourcesByRoot[rootName] = await page.evaluate((rn: string) => {
      const obj = (window as any)[rn];
      const out: Record<string, string> = {};
      if (obj && typeof obj === "object") {
        for (const k of Object.getOwnPropertyNames(obj))
          if (typeof obj[k] === "function") out[k] = obj[k].toString();
      }
      return out;
    }, rootName);
  }

  const candidates = buildCandidates(roots, sourcesByRoot);
  if (candidates.length === 0) {
    console.log("no read-suggesting window methods found on this page");
    await finish(browser, attached);
    process.exitCode = 1;
    return;
  }

  const attempts: Array<{ target: string; ok: boolean; error?: string; hits: number }> = [];
  let verified: Candidate | null = null;

  for (const cand of candidates) {
    console.log(`attempt ${cand.root}.${cand.method} params=${JSON.stringify(cand.params)}`);
    let res: JsCallResult;
    try {
      // THROUGH the seam: getPage DI exactly like the ChatDriver / hub use.
      res = await execJsFunction(() => Promise.resolve(page), cand, {
        reloadAfterSuccess: false,
      });
    } catch (e) {
      res = {
        ok: false,
        root: cand.root,
        method: cand.method,
        value: undefined,
        error: e instanceof Error ? e.message : String(e),
        networkHits: [],
      };
    }
    console.log(
      `  result ${JSON.stringify({
        ok: res.ok,
        root: res.root,
        method: res.method,
        value: preview(res.value),
        error: res.error ?? null,
        networkHits: res.networkHits,
      })}`
    );
    attempts.push({ target: `${cand.root}.${cand.method}`, ok: res.ok, error: res.error, hits: res.networkHits.length });
    if (res.ok && res.networkHits.length > 0) {
      verified = cand;
      break;
    }
  }

  if (verified) {
    const res = attempts[attempts.length - 1];
    console.log(`VERIFIED-INDEXED-CALL ${verified.root}.${verified.method} ok networkHits=${res?.hits ?? 0}`);
    await finish(browser, attached);
    process.exitCode = 0;
    return;
  }

  console.log("all candidates failed:");
  for (const a of attempts) {
    console.log(`  ${a.target}: ok=${a.ok} hits=${a.hits}${a.error ? ` error=${a.error}` : ""}`);
  }
  await finish(browser, attached);
  process.exitCode = 1;
}

// Never close an attached browser — the operator's Chrome stays up.
async function finish(browser: Browser, attached: boolean): Promise<void> {
  if (attached) return;
  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});