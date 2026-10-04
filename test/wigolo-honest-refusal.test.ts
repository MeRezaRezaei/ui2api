// A wigolo answer that reports a FAILURE must never read as a successful blank
// page. The main wigolo DOM path (`domFetch`) used to return `markdown` — "" when
// the answer was a challenge shell — without reading any of the declared failure
// fields, so a challenged/blocked page passed for a successful read. That breaks
// the project's own rule (AGENTS.md, "WHEN A SITE CHALLENGES YOU — reach for
// WIGOLO"): a blocked page stays a refusal with the NAMED reason.
//
// Hermetic: a stub wigolo daemon on loopback answers /health + /v1/fetch, so no
// real daemon, browser or site is involved. `WIGOLO_DAEMON_URL` points the
// runtime at it and autostart is disabled, so a failure here can never be a
// missing daemon.

import { createServer, type Server } from "node:http";
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { createWigoloContext } from "../src/plugin/wigolo-context.js";
import type { WigoloFetchOutput } from "../src/runtime/wigolo.js";

// The payload the stub daemon answers the next /v1/fetch with.
let nextPayload: Record<string, unknown> = {};
const requested: { tokenHeader?: string } = {};

function startStubDaemon(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "healthy" }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/fetch") {
        requested.tokenHeader = req.headers.authorization;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(nextPayload));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found", error_reason: "no stub route" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

const BASE_URL = "https://example.test/chat";

function makeContext(): ReturnType<typeof createWigoloContext> {
  return createWigoloContext({ dataDir: "/tmp/ui2api-wigolo-honest-refusal" }, { baseUrl: BASE_URL });
}

async function refusal(p: Promise<unknown>): Promise<Error> {
  try {
    const value = await p;
    assert.fail(`expected a refusal, got a resolved value: ${JSON.stringify(value)}`);
  } catch (e) {
    // assert.fail throws too — a resolved "" must not pass as a refusal.
    if ((e as Error).message.startsWith("expected a refusal")) throw e;
    return e as Error;
  }
}

describe("wigolo honest refusal (domFetch failure signals)", () => {
  let server: Server;

  before(async () => {
    const started = await startStubDaemon();
    server = started.server;
    process.env.WIGOLO_DAEMON_URL = started.url;
    process.env.UI2API_WIGOLO_AUTOSTART = "0";
    // A credential the message must never echo.
    process.env.WIGOLO_API_TOKEN = "sekrit-token-value";
  });

  after(() => {
    server.close();
    delete process.env.WIGOLO_DAEMON_URL;
    delete process.env.UI2API_WIGOLO_AUTOSTART;
    delete process.env.WIGOLO_API_TOKEN;
  });

  it("refuses a blocked challenge answer instead of returning a blank page", async () => {
    nextPayload = {
      url: BASE_URL,
      title: "Just a moment",
      markdown: "",
      metadata: {},
      links: [],
      images: [],
      cached: false,
      error: "blocked_by_challenge",
      error_reason: "anti-bot challenge did not clear within completion window",
      challenge_class: "managed",
      solve_method: null,
      http_status: 403,
    } satisfies WigoloFetchOutput;
    const ctx = makeContext();
    const err = await refusal(ctx.dom.click("#composer"));
    assert.match(err.message, /wigolo refused fetch answer/);
    // The reason is NAMED, from the upstream field — not a generic blank.
    assert.match(err.message, /blocked_by_challenge/);
    assert.match(err.message, /anti-bot challenge did not clear/);
    assert.match(err.message, /challenge_class=managed/);
    assert.match(err.message, /http 403/);
    // No credential in the message, even though the daemon got the bearer.
    assert.ok(requested.tokenHeader, "the stub daemon should have received the bearer token");
    assert.ok(!err.message.includes("sekrit-token-value"), `message leaked the token: ${err.message}`);
  });

  it("refuses an error_reason-only failure and names it", async () => {
    nextPayload = { url: BASE_URL, title: "", markdown: "", links: [], images: [], cached: false, error_reason: "playwright_fetch_failed" };
    const err = await refusal(makeContext().dom.type("#composer", "hi"));
    assert.match(err.message, /wigolo refused fetch answer/);
    assert.match(err.message, /playwright_fetch_failed/);
  });

  it("refuses a challenge_class with no clearing solve_method", async () => {
    nextPayload = { url: BASE_URL, title: "", markdown: "", links: [], images: [], cached: false, challenge_class: "datadome", solve_method: null };
    const err = await refusal(makeContext().dom.waitFor(".answer", 1000));
    assert.match(err.message, /challenge_class=datadome/);
    assert.match(err.message, /no rung cleared it/);
  });

  it("refuses on every markdown caller: waitFor and extract-full too", async () => {
    nextPayload = { url: BASE_URL, title: "", markdown: "", links: [], images: [], cached: false, error: "fetch_failed" };
    const ctx = makeContext();
    assert.match((await refusal(ctx.dom.waitFor(".answer", 1000))).message, /fetch_failed/);
    // Unsupported extract syntax falls through to the full-page read.
    assert.match((await refusal(ctx.dom.extract("nonsense .x"))).message, /fetch_failed/);
  });

  it("is NOT degraded into a native-browser blank when the reason looks like a browser outage", async () => {
    // A browser-down phrase used to route this into withBrowserFallback's native
    // fallback, which answers "" — the exact silent blank this guard exists for.
    nextPayload = {
      url: BASE_URL,
      title: "",
      markdown: "",
      links: [],
      images: [],
      cached: false,
      error: "playwright_fetch_failed",
      error_reason: "Target page, context or browser has been closed",
    };
    const err = await refusal(makeContext().dom.click("#composer"));
    assert.match(err.message, /wigolo refused fetch answer/);
  });

  it("still returns the markdown of a clean answer (no over-blocking)", async () => {
    nextPayload = { url: BASE_URL, title: "Chat", markdown: "# real answer", links: [], images: [], cached: false };
    const ctx = makeContext();
    assert.equal(await ctx.dom.click("#composer"), "# real answer");
    assert.equal(await ctx.dom.type("#composer", "hi"), "# real answer");
    assert.equal(await ctx.dom.extract("nonsense .x"), "# real answer");
  });

  it("still serves a cleared challenge (challenge_class + solve_method) and an HTML 404 landing page", async () => {
    // The daemon's success path pairs a detected challenge with the rung that
    // CLEARED it, and it deliberately serves HTML 4xx landing pages — neither is
    // a failure, so refusing them would be over-blocking.
    nextPayload = { url: BASE_URL, title: "", markdown: "cleared content", links: [], images: [], cached: false, challenge_class: "managed", solve_method: "auto-pass" };
    assert.equal(await makeContext().dom.click("#composer"), "cleared content");
    nextPayload = { url: BASE_URL, title: "Not found", markdown: "404 docs page", links: [], images: [], cached: false, http_status: 404 };
    assert.equal(await makeContext().dom.click("#composer"), "404 docs page");
  });

  it("a genuinely empty successful page still returns \"\" (not a throw)", async () => {
    nextPayload = { url: BASE_URL, title: "", markdown: "", links: [], images: [], cached: false };
    assert.equal(await makeContext().dom.extract("nonsense .x"), "");
  });
});
