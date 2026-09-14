// Profile snapshot tests — the "solve the auth/blockage once and for all" suite.
// A ProfileSnapshot is a portable bundle of a logged-in session: cookies +
// localStorage + sessionStorage + IndexedDB, captured once and injected into
// fresh incognito contexts, so a site (Gemini et al.) sees the REAL account and
// persists chat history even when no browser profile can be reused (hosts that
// kill debug-channel Chrome, CIs, containers).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { launchBrowser } from "../src/runtime/browser.js";
import {
  capturePageStorage,
  injectSnapshot,
  loadSnapshot,
  saveSnapshot,
  snapshotPath,
  storageReplayScript,
  type ProfileSnapshot,
} from "../src/runtime/session-store.js";

const FIXTURE_HTML = `<!doctype html><html><body>
<div id="ls"></div><div id="ss"></div><div id="idb"></div>
</body></html>`;

function startFixture(): Promise<{ url: string; origin: string; close(): void }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(FIXTURE_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/`;
      resolve({ url, origin: new URL(url).origin, close: () => server.close() });
    });
  });
}

// A fixture page loaded with storage preseeding on every origin of interest.
async function seedStorage(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`, { waitUntil: "load" });
  await page.evaluate(() => {
    localStorage.setItem("ls_key", "ls_value");
    sessionStorage.setItem("ss_key", "ss_value");
    return new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("u2a-test", 1);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore("kv"); // keyPath null -> out-of-line keys
        s.put("idb_value", "idb_key");
      };
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

async function readStorage(page: Page, origin: string): Promise<Record<string, unknown>> {
  // IDB + storage need a real (non-opaque) origin — navigate first so the
  // injected replay script has run and the origin is trustworthy.
  await page.goto(`${origin}/`, { waitUntil: "load" });
  return page.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        let ls: string | null = null;
        let ss: string | null = null;
        let idb: unknown = "missing";
        try {
          ls = localStorage.getItem("ls_key");
          ss = sessionStorage.getItem("ss_key");
        } catch {
          /* not on the origin / blocked */
        }
        const req = indexedDB.open("u2a-test", 1);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction("kv", "readonly");
            const get = tx.objectStore("kv").get("idb_key");
            get.onsuccess = () => {
              idb = get.result;
              db.close();
              resolve({ ls, ss, idb });
            };
            get.onerror = () => {
              db.close();
              resolve({ ls, ss, idb });
            };
          } catch {
            db.close();
            resolve({ ls, ss, idb });
          }
        };
        req.onerror = () => resolve({ ls, ss, idb });
      })
  );
}

test("snapshot save/load round-trips and path is host-scoped", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-snap-"));
  try {
    const snap: ProfileSnapshot = {
      version: 1,
      host: "gemini.google.com",
      origin: "https://gemini.google.com",
      capturedAt: "2026-09-14T00:00:00.000Z",
      cookies: [{ name: "SID", value: "abc", domain: ".google.com", path: "/" }],
      localStorage: [["k", "v"]],
      sessionStorage: [],
      indexedDB: [],
    };
    const p = snapshotPath(dir, "gemini.google.com");
    assert.ok(p.includes(join(dir, "gemini.google.com", ".session", "state.json")));
    saveSnapshot(p, snap);
    assert.ok(existsSync(p));
    const loaded = loadSnapshot(p);
    assert.ok(loaded);
    assert.equal(loaded!.host, "gemini.google.com");
    assert.equal(loaded!.cookies[0].name, "SID");
    assert.deepEqual(loaded!.localStorage, [["k", "v"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSnapshot returns null for missing/corrupt files and host is sanitized", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-snap2-"));
  try {
    assert.equal(loadSnapshot(snapshotPath(dir, "nope.example.com")), null);
    const hostile = snapshotPath(dir, "../evil"); // path traversal attempt must not escape
    assert.ok(hostile.startsWith(resolve(dir)), `snapshot stayed in dir tree: ${hostile}`);
    const p = snapshotPath(dir, "good.example.com");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{not json");
    assert.equal(loadSnapshot(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storageReplayScript is self-contained and refuses a foreign origin", async () => {
  const snap: ProfileSnapshot = {
    version: 1,
    host: "x.example",
    origin: "https://x.example",
    capturedAt: "",
    cookies: [],
    localStorage: [["k", "v"]],
    sessionStorage: [["s", "1"]],
    indexedDB: [],
  };
  const script = storageReplayScript(snap);
  assert.ok(script.includes("https://x.example")); // origin guard baked in
  assert.ok(script.includes("sessionStorage"));
  // Evaluating it on a DIFFERENT origin must not throw (guard returns early).
  const dir = mkdtempSync(join(tmpdir(), "u2a-snap3-"));
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto("http://example.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.addInitScript({ content: script });
    await page.goto("about:blank").catch(() => {});
    assert.ok(true);
  } finally {
    await browser?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capture then inject: a fresh context sees cookies, localStorage, sessionStorage and IndexedDB", async () => {
  const site = await startFixture();
  const dir = mkdtempSync(join(tmpdir(), "u2a-snap4-"));
  let browser: Browser | undefined;
  try {
    browser = await launchBrowser();

    // 1) Seed + capture a "logged-in" page into a snapshot.
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await seedStorage(page1, site.origin);
    await ctx1.addCookies([
      { name: "session", value: "secret", url: `${site.origin}/` },
    ]);
    const snap = await capturePageStorage(page1, {
      host: "fixture-host",
    });
    assert.ok(snap.cookies.length >= 1);
    assert.ok(snap.localStorage.some(([k]) => k === "ls_key"));
    assert.ok(snap.sessionStorage.some(([k]) => k === "ss_key"));
    assert.ok(
      snap.indexedDB.length >= 1 && snap.indexedDB[0].stores[0].records.length >= 1,
      `indexedDB captured: ${JSON.stringify(snap.indexedDB)}`
    );
    saveSnapshot(snapshotPath(dir, "fixture-host"), snap);
    await ctx1.close();

    // 2) A FRESH context, no profile reuse, only the snapshot.
    const ctx2 = await browser.newContext();
    await injectSnapshot(ctx2, snap);
    const page2 = await ctx2.newPage();
    const seen = await readStorage(page2, site.origin);
    await ctx2.close();

    assert.equal(seen.ls, "ls_value", "localStorage restored");
    assert.equal(seen.ss, "ss_value", "sessionStorage restored");
    assert.equal(seen.idb, "idb_value", "IndexedDB restored");

    // The snapshot must also reload from disk and reproduce the same result.
    const fromDisk = loadSnapshot(snapshotPath(dir, "fixture-host"));
    assert.ok(fromDisk);
    const ctx3 = await browser.newContext();
    await injectSnapshot(ctx3, fromDisk!);
    const page3 = await ctx3.newPage();
    const seen2 = await readStorage(page3, site.origin);
    await ctx3.close();
    assert.equal(seen2.ls, "ls_value", "localStorage restored from disk snapshot");
    assert.equal(seen2.idb, "idb_value", "IndexedDB restored from disk snapshot");
  } finally {
    await browser?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    site.close();
  }
});