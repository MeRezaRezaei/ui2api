import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatDriver } from "../src/prompt/driver.js";
import { startPromptd } from "../src/prompt/http.js";
import { launchBrowser } from "../src/runtime/browser.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";
import { guardBrowser } from "./helpers/browser-launchability.js";

// THE LAUNCHABILITY GUARD for the four tests below that drive a real browser.
// Unguarded, a browser that cannot launch surfaced as whatever `ChatDriver`/
// `startPromptd` happened to throw — an anonymous red naming a chrome-owner
// refusal or an absent artifact, with nothing saying a guard had (or had not)
// run. These pass today only because the ladder finds a system Chrome; on a box
// without one the failure was indistinguishable from a code regression.
//
// Same seam as the code under test: `ChatDriver` launches through
// `launchBrowser()` (`src/prompt/driver.ts:294`), and the daemon's prompt path
// reaches the same seam, so the probe asks that ladder — by LAUNCHING, not by
// fs-checking a path (`test/helpers/browser-launchability.ts` says why a path
// that exists is not a browser that launches).
//
// IT CANNOT SKIP. `guardBrowser` has no skip branch: an unlaunchable probe
// throws, so the lane goes RED with the classification (`browser-provisioning`
// vs `launch-regression`) plus the browser's own words. The four tests that
// need no browser (the two bearer/posture gates, and the /health + /sites half
// of the daemon test) are deliberately NOT guarded — the guard would be
// asserting something untrue about work that never launches anything.
const probeUi2apiLadder = () => launchBrowser();

const guarded = <T>(t: TestContext, run: () => Promise<T>): Promise<T | undefined> =>
  guardBrowser(t, "ui2api-ladder", probeUi2apiLadder, run);

// The MVP's end-to-end proof, fully hermetic (no internet): a local page that
// behaves like an AI chat site (composer + streamed answer event bus), driven by
// the exact same ChatDriver + primitives used against real AI sites. If this
// passes with no network and no API keys, the "use AI sites for doing prompts"
// engine works on its own.
const MOCK_CHAT_HTML = `<!doctype html><html><body>
<textarea id="in" placeholder="Ask anything"></textarea><div id="out"></div>
<script>
const input=document.getElementById("in"), out=document.getElementById("out");
function stream(p){
  // the "model": given "add A B ..." it answers ONLY the sum of A and B.
  const m = p.match(/add\\s+(\\d+)\\s+(\\d+)/i);
  const words = (m ? [String(Number(m[1]) + Number(m[2]))] : [...p.split(" ")]).concat(["done"]);
  let i=0; const t=setInterval(()=>{
    if(i<words.length){out.textContent+=(out.textContent?" ":"")+words[i];i++;}
    else clearInterval(t);
  },50);
}
input.addEventListener("keydown",(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();stream(input.value);}});
</script></body></html>`;

// Multiplication variant of the fixture, fully isolated from the add/echo mock
// (and free of backslash escapes so template-literal smuggling can't corrupt it):
// a page that looks like an AI chat site but whose "model" answers ONLY the
// product of the two numbers in a too-long-for-10k "mul A B ..." request.
const MOCK_MUL_HTML = `<!doctype html><html><body>
<textarea id="in" placeholder="Ask anything"></textarea><div id="out"></div>
<script>
const input=document.getElementById("in"), out=document.getElementById("out");
function stream(p){
  const nums = p.split(/[^0-9]+/).filter(function (n) { return n !== ""; });
  const up = p.toUpperCase().split(" ");
  const isMul = up.indexOf("MUL") >= 0 || up.indexOf("TIMES") >= 0;
  const words = (isMul && nums.length >= 2
    ? [String(Number(nums[0]) * Number(nums[1]))]
    : p.split(" ")).concat(["done"]);
  let i=0; const t=setInterval(function(){
    if(i<words.length){out.textContent+=(out.textContent?" ":"")+words[i];i++;}
    else clearInterval(t);
  },50);
}
input.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();stream(input.value);}});
</script></body></html>`;

function startMockMulChat(): Promise<{ url: string; close(): void; profile: ChatSiteProfile }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(MOCK_MUL_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/`;
      resolve({
        url,
        close: () => server.close(),
        profile: {
          id: "fixture-mul",
          name: "Mock AI chat (multiply)",
          url,
          loginRequired: false,
          composer: ["textarea#in"],
          answer: ["#out"],
          send: { kind: "keyEnter" },
          captureMs: 10000,
          stableMs: 600,
        },
      });
    });
  });
}

function startMockChat(): Promise<{ url: string; close(): void; profile: ChatSiteProfile }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(MOCK_CHAT_HTML);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      const url = `http://127.0.0.1:${port}/`;
      resolve({
        url,
        close: () => server.close(),
        profile: {
          id: "fixture",
          name: "Mock AI chat",
          url,
          loginRequired: false,
          composer: ["textarea#in"],
          answer: ["#out"],
          send: { kind: "keyEnter" },
          captureMs: 10000,
          stableMs: 600,
        },
      });
    });
  });
}

/* `GET /health`'s `ok` is COMPUTED (`healthOk`, src/prompt/http.ts), not a
 * literal: a daemon that advertises chat models over a vault with ZERO usable
 * accounts is exactly the prod 2026-09-27 incident (23 minutes of failing
 * prompts while /health said ok:true), so it answers `ok:false` — correctly.
 *
 * These daemon tests run against a FRESH temp dataDir, i.e. an empty vault,
 * while advertising one profile. That combination is honestly `ok:false`, so
 * the `ok === true` assertions below could not pass against correct code.
 *
 * The fix is to make the fixture honest rather than to relax the assertion:
 * seed ONE usable account into the temp vault, exactly through the on-disk
 * layout `healthVaultBlock` -> `listAccounts` -> `verifyStoredAccount` read
 * (index row + a well-shaped AUTHED snapshot). `ok:true` then has to be EARNED
 * through the real verdict path. A dummy profile was not an option: with
 * chatModels === 0 and no accounts the rule would pass vacuously.
 */
function seedUsableVault(dataDir: string, host = "fixture.test"): void {
  const accDir = join(dataDir, "sessions", host, "tester");
  mkdirSync(accDir, { recursive: true });
  writeFileSync(
    join(accDir, "state.json"),
    JSON.stringify({
      version: 1,
      host,
      origin: `https://${host}/`,
      capturedAt: new Date().toISOString(),
      cookies: [{ name: "auth_token", value: "x", domain: `.${host}` }],
      localStorage: [["user", "me"]],
      sessionStorage: [],
      indexedDB: [],
    }),
  );
  writeFileSync(
    join(dataDir, "sessions", host, "accounts.json"),
    JSON.stringify({
      accounts: [
        {
          slug: "tester",
          identity: "tester@example.com",
          host,
          source: "import",
          capturedAt: new Date().toISOString(),
        },
      ],
    }),
  );
}

test("ChatDriver sends a prompt to an AI chat site (fixture) and returns the streamed answer", async (t) => {
  await guarded(t, async () => {
    const site = await startMockChat();
    const dir = mkdtempSync(join(tmpdir(), "u2a-prompt-"));
    try {
      const driver = new ChatDriver(site.profile, { dataDir: dir });
      try {
        const r = await driver.ask("hello world");
        assert.ok(r.answer.includes("hello world"), `answer echoes the prompt: ${r.answer}`);
        assert.ok(r.answer.trim().endsWith("done"), `answer streamed to completion: ${r.answer}`);
        assert.equal(r.doneReason, "stable");
        assert.ok(r.chunkCount >= 2, `answer observed in chunks, got ${r.chunkCount}`);
        assert.match(r.url, /127\.0\.0\.1/);
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      site.close();
    }
  });
});

test("the proof: two random numbers sum — streamed back and verified", async (t) => {
  // The ONLY test that proves the engine — exactly as specified: generate two
  // random numbers, ask the site to add them, and the answer must equal the sum.
  // Here the "site" is a hermetic fixture whose model computes the sum; the real
  // target (copilot/gemini/...) is exercised by `npm run proof`. Same pipeline.
  await guarded(t, async () => {
    const site = await startMockChat();
    const dir = mkdtempSync(join(tmpdir(), "u2a-proof-"));
    try {
      const driver = new ChatDriver(site.profile, { dataDir: dir });
      const a = Math.floor(Math.random() * 10000) + 2;
      const b = Math.floor(Math.random() * 10000) + 2;
      const expected = a + b;
      try {
        const r = await driver.ask(`add ${a} ${b} — reply with only the number`);
        const match = String(r.answer).match(/\d+/g);
        const got = match && match.length ? Number(match[match.length - 1]) : NaN;
        assert.equal(got, expected, `answer "${r.answer}" must equal ${a}+${b}=${expected}`);
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      site.close();
    }
  });
});

test("the proof: two random numbers multiplication — streamed back and verified", async (t) => {
  // The goal's exact ask: two random numbers, multiplied. The hermetic
  // multiplication fixture model computes the product; real targets are
  // exercised by `npm run proof` on a healthy host. Same pipeline as real AI.
  await guarded(t, async () => {
    const site = await startMockMulChat();
    const dir = mkdtempSync(join(tmpdir(), "u2a-mul-"));
    try {
      const driver = new ChatDriver(site.profile, { dataDir: dir });
      const a = Math.floor(Math.random() * 10000) + 2;
      const b = Math.floor(Math.random() * 10000) + 2;
      const expected = a * b;
      try {
        const r = await driver.ask(`mul ${a} ${b} — reply with only the number`);
        const match = String(r.answer).match(/\d+/g);
        const got = match && match.length ? Number(match[match.length - 1]) : NaN;
        assert.equal(got, expected, `answer "${r.answer}" must equal ${a}×${b}=${expected}`);
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      site.close();
    }
  });
});

test("promptd exposes the engine as localhost JSON so /var/www apps can use it unchanged", async (t) => {
  await guarded(t, async () => {
    const site = await startMockChat();
    const dir = mkdtempSync(join(tmpdir(), "u2a-promptd-"));
    try {
      seedUsableVault(dir);
      const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [site.profile] });
      const base = `http://127.0.0.1:${svc.port}`;
      try {
        // Provider listing + health, usable without a browser.
        const health = await (await fetch(`${base}/health`)).json();
        assert.equal(health.ok, true);
        const sites = await (await fetch(`${base}/sites`)).json();
        assert.ok(sites.sites.some((s: { id: string }) => s.id === "fixture"));

        // The real flow: an app POSTs a prompt, gets the streamed answer back.
        // This POST is what makes the test browser-bound, which is why it is
        // inside the guard even though /health and /sites alone would not need one.
        const r = await fetch(`${base}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ site: "fixture", prompt: "hello from an app" }),
        });
        const out = (await r.json()) as { ok: boolean; answer: string; doneReason: string };
        assert.equal(r.status, 200);
        assert.equal(out.ok, true);
        assert.ok(out.answer.includes("hello from an app"), out.answer);
        assert.ok(out.answer.trim().endsWith("done"), out.answer);
        assert.equal(out.doneReason, "stable");

        // The service refuses to drive origins that were not configured.
        const bad = await fetch(`${base}/prompt`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ site: "gemini", prompt: "hi" }),
        });
        assert.equal(bad.status, 400);
      } finally {
        await svc.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      site.close();
    }
  });
});

// NOT guarded, deliberately: these two exercise the daemon's AUTH posture over
// plain fetch. Neither ever reaches a browser, so guarding them would assert
// something untrue about the code under test and go red on a
// browser-hostile-but-healthy box for no reason. The same reasoning is recorded
// in `test/wigolo-engine.test.ts` for its unguarded `replay` case, and it is the
// distinction that matters: this guard excuses an ABSENT SUBJECT, never a
// FAILING one.

test("promptd bearer gate: token set => 401 without/with wrong token, 200 with it", async () => {
  const site = await startMockChat();
  const dir = mkdtempSync(join(tmpdir(), "u2a-token-"));
  try {
    seedUsableVault(dir);
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [site.profile], token: "op-secret" });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      const noAuth = await fetch(`${base}/health`);
      assert.equal(noAuth.status, 401);

      const wrongAuth = await fetch(`${base}/health`, { headers: { authorization: "Bearer nope" } });
      assert.equal(wrongAuth.status, 401);

      const okAuth = await fetch(`${base}/health`, { headers: { authorization: "Bearer op-secret" } });
      assert.equal(okAuth.status, 200);
      assert.equal((await okAuth.json()).ok, true);
    } finally {
      await svc.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    site.close();
  }
});

test("promptd without a token answers localhost requests unauthed (localhost-only posture)", async () => {
  const site = await startMockChat();
  const dir = mkdtempSync(join(tmpdir(), "u2a-notoken-"));
  try {
    seedUsableVault(dir);
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [site.profile] });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
    } finally {
      await svc.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    site.close();
  }
});