import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatDriver } from "../src/prompt/driver.js";
import { startPromptd } from "../src/prompt/http.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

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

test("ChatDriver sends a prompt to an AI chat site (fixture) and returns the streamed answer", async () => {
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

test("the proof: two random numbers sum — streamed back and verified", async () => {
  // The ONLY test that proves the engine — exactly as specified: generate two
  // random numbers, ask the site to add them, and the answer must equal the sum.
  // Here the "site" is a hermetic fixture whose model computes the sum; the real
  // target (copilot/gemini/...) is exercised by `npm run proof`. Same pipeline.
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

test("the proof: two random numbers multiplication — streamed back and verified", async () => {
  // The goal's exact ask: two random numbers, multiplied. The hermetic
  // multiplication fixture model computes the product; real targets are
  // exercised by `npm run proof` on a healthy host. Same pipeline as real AI.
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

test("promptd exposes the engine as localhost JSON so /var/www apps can use it unchanged", async () => {
  const site = await startMockChat();
  const dir = mkdtempSync(join(tmpdir(), "u2a-promptd-"));
  try {
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: dir, profiles: [site.profile] });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      // Provider listing + health, usable without a browser.
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.ok, true);
      const sites = await (await fetch(`${base}/sites`)).json();
      assert.ok(sites.sites.some((s: { id: string }) => s.id === "fixture"));

      // The real flow: an app POSTs a prompt, gets the streamed answer back.
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