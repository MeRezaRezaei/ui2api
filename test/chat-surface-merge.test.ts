import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import { defaultChatProfiles } from "../src/prompt/registry.js";
import { isChatShapedProfile, listProfiles, resolvePackagedProfile, resolveProfile } from "../src/profile/profile.js";
import { startPromptd } from "../src/prompt/http.js";
import { handleOpenAIRoutes } from "../src/prompt/openai.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

// ────────────────────────────────────────────────────────────────────────────
// GOAL 30 — installed chat-shaped packages reach the chat surface
//
// Before GOAL 30 the daemon's default profile set was BUILTIN_PROFILES only:
// installed chat-shaped packages (duckduckgo, poe, grok, …) 404'd on
// /sites, /v1/models, /accounts and POST /prompt. Now `defaultChatProfiles()`
// (registry.ts) = builtin catalog + every installed chat-shaped package, gated
// by the composer/answer/url discriminator so capability-only packages
// (gmail/youtube/araprat/chatglm/tinycms) NEVER become chat models.
//
//   (a) merge regression — defaultChatProfiles() draws in exactly the
//       chat-shaped installed packages (fixture-anchored on the in-repo
//       capabilities/ dir) and rejects every non-chat package;
//   (b) route test — a REAL default daemon (no --site, no profiles) serves
//       duckduckgo on GET /sites and /v1/models, /accounts?site=duckduckgo
//       resolves, and an unknown model still 404s;
//   (c) discriminator on /v1 — model=duckduckgo resolves into an actual chat
//       call (stub pool); model=gmail / model=nonsense 404 as unknown_model;
//   (d) consent-wall mechanism — the packaged duckduckgo profile carries the
//       declaration the shared ChatDriver acts on for the first-send wall.
//
// Vault-guard: NOTHING here launches a browser. The (b) daemon is started with
// UI2API_ATTACH_PORT=1 (nothing listens) so boot-warm fails fast and the
// read-only chat surfaces are exercised over a plain HTTP server.
// ────────────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPABILITIES_DIR = join(ROOT, "capabilities");
const BUILTIN_IDS = listProfiles().map((p) => p.id);

/** Independently enumerate the installed chat-shaped packages straight off disk
 *  (the fixture): every capabilities/<id>/profile.json that passes the GOAL 30
 *  discriminator via a raw JSON parse — no merge code involved. */
function installedChatShapes(): Array<{ id: string; profile: ChatSiteProfile }> {
  const out: Array<{ id: string; profile: ChatSiteProfile }> = [];
  if (!existsSync(CAPABILITIES_DIR)) return out;
  for (const name of readdirSync(CAPABILITIES_DIR, { withFileTypes: true })) {
    if (!name.isDirectory() || !existsSync(join(CAPABILITIES_DIR, name.name, "manifest.json"))) continue;
    const packed = resolvePackagedProfile(name.name);
    if (packed && isChatShapedProfile(packed)) out.push({ id: name.name, profile: packed });
  }
  return out;
}

function installedAll(): string[] {
  if (!existsSync(CAPABILITIES_DIR)) return [];
  return readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(CAPABILITIES_DIR, d.name, "manifest.json")))
    .map((d) => d.name);
}

interface StubOpenAiHarness {
  server: Server;
  port: number;
  acquires: () => number;
}

function startMergedOpenAiHarness(profilesById: Record<string, ChatSiteProfile>): Promise<StubOpenAiHarness> {
  let acquires = 0;
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        await handleOpenAIRoutes(req, res, {
          pool: {
            acquire: async () => {
              acquires++;
              return { driver: { ask: async () => ({ answer: "2 + 2 = 4", chunkCount: 1, doneReason: "stop", url: "https://duck.ai/chat", title: "duck" }) } };
            },
            release: async () => undefined,
          } as never,
          profilesById,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(/unknown site |no stored account /.test(msg) ? 400 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0, acquires: () => acquires });
    });
  });
}

// ─── (a) MERGE REGRESSION ───────────────────────────────────────────────────

test("GOAL30(a): defaultChatProfiles() = builtin catalog + every installed chat-shaped package, no duplicates", () => {
  const set = defaultChatProfiles();
  const ids = set.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "default chat set must not contain duplicate ids");

  for (const builtin of BUILTIN_IDS) {
    assert.ok(ids.includes(builtin), `builtin "${builtin}" must stay in the default chat set`);
  }

  // Fixture-anchored: whatever chat-shaped package the in-repo capabilities/
  // dir ships today must be reachable through the default set (= the surface
  // /sites + /v1/models + POST /prompt now serve).
  const shapes = installedChatShapes();
  assert.ok(shapes.length >= 1, "expected at least one installed chat-shaped package fixture (duckduckgo)");
  for (const { id, profile } of shapes) {
    assert.ok(ids.includes(id), `installed chat-shaped package "${id}" must be merged into the default chat set`);
    const merged = set.find((p) => p.id === id);
    assert.equal(merged?.url, profile.url, `${id}: merged profile must carry the packaged url`);
    assert.ok(isChatShapedProfile(merged!), `${id}: every merged non-builtin must pass the chat shape`);
  }

  // The merged set is the SAME one the daemon default path builds (registry.ts
  // posts builtin-first, so every builtin id is untouched by the package pass).
  // Shapes that repeat a builtin id are already counted in BUILTIN_IDS.
  const nonBuiltinShapes = shapes.filter((s) => !BUILTIN_IDS.includes(s.id));
  assert.equal(set.length, BUILTIN_IDS.length + nonBuiltinShapes.length, "set = builtins + non-builtin chat shapes, no more, no less");
});

test("GOAL30(a): capability-only packages (gmail/youtube/araprat/chatglm/tinycms) are NOT chat shapes and never merge", () => {
  const set = defaultChatProfiles();
  const ids = set.map((p) => p.id);
  const capabilityOnly = ["gmail", "youtube", "araprat", "chatglm", "tinycms", "doubao", "adapta", "conol"];
  // Fixture guard: the packages must exist, they just must not be chat shapes.
  const installed = installedAll();
  for (const id of capabilityOnly) {
    if (!installed.includes(id)) continue; // not installed on this checkout
    const packed = resolvePackagedProfile(id);
    assert.ok(packed, `${id}: installed package must resolve a packaged profile`);
    assert.ok(!isChatShapedProfile(packed!), `${id}: capability-only package must NOT pass the chat-shape discriminator`);
    assert.ok(!ids.includes(id), `${id}: must never become a default chat model`);
  }
  assert.ok(ids.includes("duckduckgo"), "control: duckduckgo IS in the set");
});

test("GOAL30(a): resolveProfile resolves packaged chat sites by id and still throws for capability-only ids", () => {
  const d = resolveProfile("duckduckgo");
  assert.equal(d.id, "duckduckgo");
  assert.equal(d.url, "https://duck.ai/chat");
  assert.throws(() => resolveProfile("gmail"), /unknown AI site "gmail"/);
  assert.throws(() => resolveProfile("no-such-site-xyz"), /unknown AI site/);
});

test("GOAL30(a): `ui2api prompt --sites` lists duckduckgo and omits capability-only gmail", async () => {
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), "prompt", "--sites"], { cwd: ROOT });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`cli exited ${code}`))));
  });
  assert.match(out, /duckduckgo/, "CLI --sites must list the merged duckduckgo");
  assert.doesNotMatch(out, /^gmail\b/m, "CLI --sites must never list capability-only gmail");
});

// ─── (b) REAL DEFAULT DAEMON ROUTE TEST (no browser: attach port 1 refused) ─

test("GOAL30(b): a REAL default daemon serves duckduckgo on /sites + /v1/models and 404s unknown models", async (t) => {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1"; // boot-warm connect-refused fast; no browser is ever spawned
  try {
    // Deliberately NO profiles argument: the DEFAULT path must merge installed
    // chat-shaped packages by itself (the GOAL 30 change).
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: "data" });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      // GET /sites lists the merged chat-shaped package.
      const sitesRes = await fetch(`${base}/sites`);
      assert.equal(sitesRes.status, 200);
      const sites = (await sitesRes.json()) as { sites: Array<{ id: string }> };
      const ids = sites.sites.map((s) => s.id);
      assert.ok(ids.includes("duckduckgo"), "GET /sites must include the merged duckduckgo chat package");
      for (const builtin of ["gemini", "copilot", "deepseek", "kimi"]) assert.ok(ids.includes(builtin), `GET /sites keeps builtin ${builtin}`);
      assert.ok(!ids.includes("gmail"), "GET /sites must not include capability-only gmail");

      // GET /v1/models includes duckduckgo as a model.
      const modelsRes = await fetch(`${base}/v1/models`);
      assert.equal(modelsRes.status, 200);
      const models = (await modelsRes.json()) as { object: string; data: Array<{ id: string }> };
      assert.equal(models.object, "list");
      assert.ok(models.data.some((m) => m.id === "duckduckgo"), "/v1/models must include merged duckduckgo");
      assert.ok(!models.data.some((m) => m.id === "gmail"), "/v1/models must not include gmail");

      // GET /accounts?site=duckduckgo resolves (idFrom sees the merged id).
      const accRes = await fetch(`${base}/accounts?site=duckduckgo`);
      assert.equal(accRes.status, 200, "/accounts?site=duckduckgo must resolve (no unknown-site 400)");
      const acc = (await accRes.json()) as { site: string; accounts: unknown[] };
      assert.equal(acc.site, "duckduckgo");
      assert.ok(Array.isArray(acc.accounts));

      // Unknown model still 404s on the real daemon.
      const unknown = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "no-such-model", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(unknown.status, 404, "unknown model must be a 404 unknown_model");
      const unknownBody = (await unknown.json()) as { error?: { code?: string } };
      assert.equal(unknownBody.error?.code, "unknown_model");

      // model=duckduckgo RESOLVES (not a 404): the pool attempt fails only
      // because the attach-mode browser is refused — never an unknown model.
      const duck = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "duckduckgo", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.notEqual(duck.status, 404, "model=duckduckgo must resolve past the model gate (404 would mean not merged)");
      const duckBody = (await duck.json()) as { error?: string };
      assert.ok(!String(duckBody.error ?? "").includes("unknown"), `duckduckgo failure must be a driver error, not an unknown-site one: ${duckBody.error}`);
    } finally {
      await svc.close();
    }
  } finally {
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
  }
  t.diagnostic("real daemon exercised read-only chat surfaces (no browser launched)");
});

// ─── (c) /v1 DISCRIMINATOR VIA THE PRODUCTION HANDLER (stub pool) ──────────

test("GOAL30(c): /v1/chat/completions model=duckduckgo resolves; model=gmail and nonsense 404; /v1/models excludes non-chat", async () => {
  const profilesById: Record<string, ChatSiteProfile> = {};
  for (const p of defaultChatProfiles()) profilesById[p.id] = p;
  const { server, port, acquires } = await startMergedOpenAiHarness(profilesById);
  try {
    // Merged chat-shaped package -> a real chat call through the production handler.
    const duck = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "duckduckgo", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(duck.status, 200, "model=duckduckgo must complete via the merged profilesById");
    const duckBody = (await duck.json()) as { model: string; choices: Array<{ message: { content: string } }> };
    assert.equal(duckBody.model, "duckduckgo");
    assert.equal(duckBody.choices[0].message.content, "2 + 2 = 4");
    assert.ok(acquires() >= 1, "model=duckduckgo must flow to pool.acquire");

    // Capability-only package -> 404 unknown_model (discriminator on /v1).
    const gmail = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gmail", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(gmail.status, 404, "model=gmail is not a chat model — must 404");
    assert.equal(((await gmail.json()) as { error: { code: string } }).error.code, "unknown_model");

    const nonsense = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ui2api/nonsense", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(nonsense.status, 404, "unknown model must 404");

    const models = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string }> };
    assert.ok(models.data.some((m) => m.id === "duckduckgo"));
    assert.ok(!models.data.some((m) => m.id === "gmail" || m.id === "youtube"));
    assert.equal(acquires(), 1, "the 404s must never reach the pool");
  } finally {
    server.close();
  }
});

// ─── (d) CONSENT-WALL MECHANISM ─────────────────────────────────────────────

test("GOAL30(d): the packaged duckduckgo profile declares the consent wall the shared ChatDriver acts on", () => {
  const packed = resolvePackagedProfile("duckduckgo");
  assert.ok(packed?.consentWall, "packaged duckduckgo profile must carry consentWall");
  const wall = packed!.consentWall!;
  assert.ok(wall.accept && wall.accept.length > 0, "consentWall.accept must be a non-empty selector");
  assert.match(wall.accept, /Continue/i, "the wall button is duck.ai's Continue button");
  // The driver implements the dance (task-safe source pin: the block waits,
  // clicks accept, settles, then re-presses send on the same composer).
  const driverSource = readFileSync(join(ROOT, "src", "prompt", "driver.ts"), "utf8");
  const wallIdx = driverSource.indexOf("this.profile.consentWall");
  assert.ok(wallIdx >= 0, "ChatDriver must branch on profile.consentWall");
  assert.ok(driverSource.indexOf("accept.click", wallIdx) > wallIdx, "driver must click the wall's accept button");
  assert.ok(driverSource.indexOf('wall.accept', wallIdx) > wallIdx, "driver must read the accept selector from the profile");
});