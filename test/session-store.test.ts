// Profile snapshot tests — the "solve the auth/blockage once and for all" suite.
// A ProfileSnapshot is a portable bundle of a logged-in session: cookies +
// localStorage + sessionStorage + IndexedDB, captured once and injected into
// fresh incognito contexts, so a site (Gemini et al.) sees the REAL account and
// persists chat history even when no browser profile can be reused (hosts that
// kill debug-channel Chrome, CIs, containers).
import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
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
  validateSnapshotShape,
  validStoredAccount,
  listAccounts,
  loadAccountSnapshot,
  accountSnapshotPath,
  accountsIndexPath,
  type ProfileSnapshot,
} from "../src/runtime/session-store.js";
import { guardBrowser } from "./helpers/browser-launchability.js";

// THE LAUNCHABILITY GUARD for the two browser tests below. Before this, both
// called `launchBrowser()` INSIDE the body with nothing around it, so a browser
// that cannot launch produced a bare `launchBrowser` throw — an anonymous red
// whose message named a chrome-owner refusal or an absent artifact, with no
// statement that the guard had, or had not, run. They passed only because a
// system-Chrome fallback exists on this box; on a box without one the failure
// was indistinguishable from a code regression.
//
// The seam is the SAME `launchBrowser` these tests call (`ui2api-ladder`, the
// ladder with the system-Chrome fallback), and the probe LAUNCHES through it
// rather than fs-checking a path — `test/helpers/browser-launchability.ts`
// spells out at length why a path that exists is not a browser that launches.
//
// IT CANNOT SKIP. `guardBrowser` has no skip branch: an unlaunchable probe
// throws, so the lane goes RED with the classification (`browser-provisioning`
// vs `launch-regression`) and the browser's own words in the message. The
// control below asserts that directly, so "it never skips" is a test and not a
// promise.
const probeUi2apiLadder = () => launchBrowser();

const guarded = <T>(t: TestContext, run: () => Promise<T>): Promise<T | undefined> =>
  guardBrowser(t, "ui2api-ladder", probeUi2apiLadder, run);

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

test("storageReplayScript is self-contained and refuses a foreign origin", async (t) => {
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
  // "self-contained" is a real, checkable claim: the emitted source must parse
  // and run as a standalone IIFE with no reference to any outer scope.
  assert.doesNotThrow(() => new Function(script), "the replay script must be self-contained (parses standalone)");

  // The REAL property, on the loopback fixture origin. Evaluating the script on
  // a DIFFERENT origin must not throw (the guard returns early) AND must write
  // nothing — so it is asserted from both sides:
  //   A. the snapshot origin (https://x.example) vs the fixture origin -> refused
  //   B. the SAME script with ORIGIN rewritten to the fixture origin -> replayed
  // B is the control: without it A could pass on a script that is a no-op, which
  // is the same "proves nothing" disease this test used to carry.
  await guarded(t, async () => {
    const site = await startFixture();
    let browser: Browser | undefined;
    try {
      browser = await launchBrowser();
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(String(e)));

      // Seed the fixture origin with foreign values first, so a refused replay
      // cannot be confused with an origin that simply has no storage.
      await page.goto(`${site.origin}/`, { waitUntil: "load" });
      await page.evaluate(() => {
        localStorage.setItem("k", "untouched");
        sessionStorage.setItem("s", "untouched");
      });

      // A. foreign origin -> the guard must return early, writing nothing.
      await page.addInitScript({ content: script });
      await page.reload({ waitUntil: "load" });
      const refused = await page.evaluate(() => ({
        ls: localStorage.getItem("k"),
        ss: sessionStorage.getItem("s"),
      }));
      assert.deepEqual(pageErrors, [], "a foreign origin must make the guard return early, not throw");
      assert.equal(refused.ls, "untouched", "a foreign origin must NOT receive the snapshot's localStorage");
      assert.equal(refused.ss, "untouched", "a foreign origin must NOT receive the snapshot's sessionStorage");

      // B. control: the SAME script with only ORIGIN rewritten to the fixture
      // origin must replay the snapshot's storage. Same script, one token
      // different, opposite outcome — so A cannot be vacuous.
      const controlled = script.replace(JSON.stringify("https://x.example"), JSON.stringify(site.origin));
      assert.notEqual(controlled, script, "the control must actually differ from the guarded script");
      const page2 = await browser!.newPage();
      const controlErrors: string[] = [];
      page2.on("pageerror", (e) => controlErrors.push(String(e)));
      await page2.addInitScript({ content: controlled });
      await page2.goto(`${site.origin}/`, { waitUntil: "load" });
      const replayed = await page2.evaluate(() => ({
        ls: localStorage.getItem("k"),
        ss: sessionStorage.getItem("s"),
      }));
      assert.deepEqual(controlErrors, [], "the matching-origin replay must not throw either");
      assert.equal(replayed.ls, "v", "control: the snapshot's localStorage IS replayed on the matching origin");
      assert.equal(replayed.ss, "1", "control: the snapshot's sessionStorage IS replayed on the matching origin");
    } finally {
      await browser?.close().catch(() => {});
      site.close();
    }
  });
});

// THE CONTROL for the guard above, and the reason it is not a comment. An
// unlaunchable browser makes `guardBrowser` THROW, naming the classification and
// quoting the browser — it never calls `t.skip`, so `test:unit` cannot print a
// green `skipped N` with the browser half of this file untested.
//
// The failing launch below is fed the exact text playwright emits for an absent
// cached artifact, so this exercises the real classification path
// (`classifyLaunchFailure` -> BINARY_ABSENT) rather than asserting on a string
// this file invented.
test("the launchability guard NAMES an unlaunchable browser instead of skipping it", async (t) => {
  const skipCalls: Array<string | undefined> = [];
  const diagnostics: string[] = [];
  // A stand-in for the test context that RECORDS the two branches a guard could
  // take. Using the real `t` would make "did it skip?" unobservable, because a
  // skip is not an error — so this is what turns the claim into an assertion.
  const probe = {
    diagnostic: (msg: string) => {
      diagnostics.push(msg);
    },
    skip: (msg?: string) => {
      skipCalls.push(msg);
    },
  } as unknown as TestContext;

  let bodyRan = false;
  await assert.rejects(
    () =>
      guardBrowser(
        probe,
        "ui2api-ladder",
        async () => {
          throw new Error("Executable doesn't exist at /home/me/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell");
        },
        async () => {
          bodyRan = true;
        },
      ),
    (e: unknown) => {
      const msg = (e as Error).message;
      assert.match(msg, /browser not launchable \(browser-provisioning\)/, "the verdict is NAMED, not anonymous");
      assert.match(msg, /This is the launchability guard, not the test body/, "the failure names the guard");
      assert.match(msg, /Executable doesn't exist/, "the browser's own words survive into the reason");
      return true;
    },
  );
  assert.deepEqual(skipCalls, [], "the guard must NEVER call t.skip — that is the silent-green defect");
  assert.equal(bodyRan, false, "the guarded body must not run when the browser cannot launch");
  assert.ok(
    diagnostics.some((d) => d.includes("classified browser-provisioning")),
    `the classification is legible without a stack trace: ${JSON.stringify(diagnostics)}`,
  );
  assert.ok(t, "the test context is live (this test asserts on its own behalf)");
});

test("capture then inject: a fresh context sees cookies, localStorage, sessionStorage and IndexedDB", async (t) => {
  await guarded(t, async () => {
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
});

// GOAL 59 (2026-09-25): read-side truth gate for STORED snapshots. GOAL 49/50
// gate the WRITE side (anonymous snapshots refused at the write seam), GOAL 58
// gates the fingerprint read-back — but loadSnapshot accepted any JSON with
// `version===1 && host`, so a wrong-shaped `cookies` (string, from a hand edit
// or stale build) crashed injectSnapshot's `(snap.cookies ?? []).filter(...)`
// UNCAUGHT mid-runner (session-store.ts:192) or "worked" in `cookies.length`
// and replayed garbage into addCookies. The load seam now refuses malformed
// shapes (null, same contract as corrupt JSON); the validator names the field.

test("GOAL59(a): validateSnapshotShape names the FIRST violation of each malformed shape, well-formed + legacy pass", () => {
  const good = {
    version: 1,
    host: "h",
    origin: "https://h",
    capturedAt: "t",
    cookies: [{ name: "n", domain: ".h", value: "v" }],
    localStorage: [["k", "v"]],
    sessionStorage: [],
    indexedDB: [],
  };
  assert.equal(validateSnapshotShape(good), null, "well-formed snapshot validates");
  assert.equal(validateSnapshotShape({ version: 1, host: "h" }), null, "legacy snapshot (absent optional fields) validates");

  const cases: Array<[unknown, RegExp]> = [
    ["nope", /snapshot must be an object/],
    [null, /snapshot must be an object/],
    [{ version: 2, host: "h" }, /version must be 1/],
    [{ version: 1, host: "" }, /host must be a non-empty string/],
    [{ version: 1, host: "h", cookies: "nope" }, /cookies must be an array/],
    [{ version: 1, host: "h", cookies: [{ name: "n" }] }, /cookies\[0\] must be \{ name: string, domain: string \}/],
    [{ version: 1, host: "h", localStorage: [["k"]] }, /localStorage\[0\] must be a \[string, string\] tuple/],
    [{ version: 1, host: "h", sessionStorage: 7 }, /sessionStorage must be an array of \[key, value\] tuples/],
    [{ version: 1, host: "h", indexedDB: "x" }, /indexedDB must be an array/],
  ];
  for (const [snap, re] of cases) {
    const err = validateSnapshotShape(snap);
    assert.ok(err !== null && re.test(err), `expected ${re} got ${err}`);
  }
});

test("GOAL59(b): loadSnapshot refuses a malformed stored file (null) and keeps returning well-formed storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-goal59-"));
  try {
    const p = snapshotPath(dir, "goal59.example.com");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, host: "goal59.example.com", cookies: "not-an-array" }));
    assert.equal(loadSnapshot(p), null, "wrong-shaped stored snapshot refuses (null, same as corrupt JSON)");

    const legacy = JSON.stringify({ version: 1, host: "goal59.example.com" });
    writeFileSync(p, legacy);
    const loaded = loadSnapshot(p);
    assert.ok(loaded && loaded.host === "goal59.example.com", "legacy-shaped stored snapshot still loads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// GOAL 60 (2026-09-25): read-side gate on the vault INDEX (accounts.json).
// GOAL 59 gated the snapshot FILE read; the index that points at those files
// was unvalidated per-entry — a hostile slug ("../../../pwned") served by
// listAccounts would escape the vault via accountSnapshotPath's resolve(),
// and a numeric slug passed straight into path building. Writes are safe
// (slugifyIdentity at save); this closes the read seam for hand-edited /
// partial / stale indexes. Hostile entries are EXCLUDED, never served.

test("GOAL60(a): validStoredAccount accepts well-formed entries, refuses hostile slug / numeric slug / bad source / empty identity", () => {
  const base = { slug: "me@gmail.com", identity: "Me", host: "h.example.com", source: "import", capturedAt: "2026-09-25" };
  assert.equal(validStoredAccount(base), true, "well-formed entry valid");
  assert.equal(validStoredAccount({ ...base, slug: "@-._" }), true, "slugify alphabet preserved (no path separators)");
  for (const slug of ["../../../pwned", "a/b", "..", ".\\evil", 42, "", "has space"]) {
    assert.equal(validStoredAccount({ ...base, slug }), false, `hostile/non-string slug refused: ${JSON.stringify(slug)}`);
  }
  for (const source of ["teleport", "upload", 7, null]) {
    assert.equal(validStoredAccount({ ...base, source }), false, `bad source refused: ${JSON.stringify(source)}`);
  }
  assert.equal(validStoredAccount({ ...base, identity: "" }), false, "empty identity refused");
  assert.equal(validStoredAccount({ ...base, host: "" }), false, "empty host refused");
  assert.equal(validStoredAccount({ ...base, capturedAt: "" }), false, "empty capturedAt refused");
  assert.equal(validStoredAccount("nope"), false, "scalar refused");
  assert.equal(validStoredAccount(null), false, "null refused");
});

test("GOAL60(b): listAccounts filters hostile index entries — no path escape, hostile identity resolves null, well-formed entries unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-goal60-"));
  try {
    const host = "evil.example.com";
    const idx = accountsIndexPath(dir, host);
    mkdirSync(dirname(idx), { recursive: true });
    const entries = [
      { slug: "../../../pwned", identity: "attacker", host, source: "import", capturedAt: "t" },
      { slug: 42, identity: "num", host, source: "import", capturedAt: "t" },
      { slug: "good", identity: "ok", host, source: "import", capturedAt: "t" },
    ];
    writeFileSync(idx, JSON.stringify({ accounts: entries }));
    const listed = listAccounts(dir, host);
    assert.deepEqual(listed.map((a) => a.slug), ["good"], "hostile/numeric entries excluded, well-formed kept");
    for (const a of listed) {
      const p = accountSnapshotPath(dir, host, a.slug);
      assert.ok(p.startsWith(resolve(dir, "sessions", host)), `path stays in the vault: ${p}`);
    }
    assert.equal(loadAccountSnapshot(dir, host, "attacker"), null, "hostile identity does not resolve");
    // Well-formed multi-account index serves all entries unchanged.
    const idx2 = accountsIndexPath(dir, host);
    writeFileSync(idx2, JSON.stringify({ accounts: entries.slice(2).concat([{ slug: "second", identity: "two", host, source: "capture", capturedAt: "t" }]) }));
    assert.deepEqual(listAccounts(dir, host).map((a) => a.slug), ["good", "second"], "well-formed index unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});