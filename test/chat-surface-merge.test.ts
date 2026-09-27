import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import { defaultChatProfiles, defaultChatSurface, chatSurfaceStatus, buildRegistryPackages, type ChatSurfaceEntry } from "../src/prompt/registry.js";
import {
  isChatShapedProfile,
  isDriveableChatProfile,
  isParseableSelector,
  listProfiles,
  resolvePackagedProfile,
  resolveProfile,
  type ChatSiteProfile,
} from "../src/profile/profile.js";
import { startPromptd } from "../src/prompt/http.js";
import { handleOpenAIRoutes } from "../src/prompt/openai.js";

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
const BUILTIN_PROFILES = listProfiles();
const BUILTIN_IDS = BUILTIN_PROFILES.map((p) => p.id);
const BUILTIN_BY_ID = new Map(BUILTIN_PROFILES.map((p) => [p.id, p]));

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

/** The GOAL 32 gate on disk (independent of registry.ts's merge): the chat
 *  shape AND every composer/answer entry a parseable CSS selector. */
function installedDriveables(): Array<{ id: string; profile: ChatSiteProfile }> {
  const out: Array<{ id: string; profile: ChatSiteProfile }> = [];
  if (!existsSync(CAPABILITIES_DIR)) return out;
  for (const name of readdirSync(CAPABILITIES_DIR, { withFileTypes: true })) {
    if (!name.isDirectory() || !existsSync(join(CAPABILITIES_DIR, name.name, "manifest.json"))) continue;
    const packed = resolvePackagedProfile(name.name);
    if (packed && isDriveableChatProfile(packed)) out.push({ id: name.name, profile: packed });
  }
  return out;
}

/** Metadata.machine status read straight off the package (mirrors
 *  packageStatusOf in registry.ts): "dormant"/"dead-end" = excluded from the
 *  chat surface until live-verified. */
function machineStatus(id: string): string | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(CAPABILITIES_DIR, id, "metadata.json"), "utf8")) as { status?: string };
    return typeof meta.status === "string" && meta.status ? meta.status : undefined;
  } catch {
    return undefined;
  }
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

  // GOAL 147: this loop used to run over the whole BUILTIN catalog, which
  // asserted "catalog membership == chat claim" — the exact bug that let
  // `google-ai-search` (composer-less, no `*_chat` capability, loginGated
  // runner) be stamped chat. The catalog is the set of profiles that EXIST;
  // the chat set is the subset that is DRIVEABLE. So the pin is restated over
  // the driveable builtins, which is the property actually worth keeping: a
  // driveable builtin can never be silently dropped from the chat surface.
  for (const builtin of BUILTIN_IDS.filter((id) => isDriveableChatProfile(BUILTIN_BY_ID.get(id)!))) {
    assert.ok(ids.includes(builtin), `driveable builtin "${builtin}" must stay in the default chat set`);
  }

  // …and the exclusion is a POSITIVE, pinned fact rather than an untested
  // accident: a builtin that is NOT driveable is in the catalog and NOT in the
  // chat set. If someone re-admits it, this fails loudly.
  for (const id of BUILTIN_IDS.filter((bid) => !isDriveableChatProfile(BUILTIN_BY_ID.get(bid)!))) {
    assert.ok(
      !ids.includes(id),
      `non-driveable builtin "${id}" must NOT be in the default chat set — it is in the catalog but not chat-shaped`,
    );
  }
  assert.ok(
    BUILTIN_IDS.includes("google-ai-search") && !ids.includes("google-ai-search"),
    "google-ai-search: present in the builtin catalog, absent from the chat surface (composer-less profile, no *_chat capability, loginGated runner — not a chat model)",
  );

  // Fixture-anchored: whatever chat-shaped package the in-repo capabilities/
  // dir ships today must be reachable through the default set (= the surface
  // /sites + /v1/models + POST /prompt now serve) — GOAL 32 qualified: only
  // DRIVEABLE packages (chat shape + parseable composer/answer selectors) that
  // are not status-excluded (dormant/dead-end metadata) merge; prose or
  // playwright-only selectors (t3chat's former rows) and parked/dead packages
  // (zenmux/xiaomimimo) never surface as chat models.
  const shapes = installedChatShapes();
  assert.ok(shapes.length >= 1, "expected at least one installed chat-shaped package fixture (duckduckgo)");
  const driveables = installedDriveables().filter((s) => machineStatus(s.id) !== "dormant" && machineStatus(s.id) !== "dead-end");
  assert.ok(driveables.length >= 1, "expected at least one driveable installed chat package fixture (duckduckgo)");
  for (const { id, profile } of driveables) {
    assert.ok(ids.includes(id), `installed driveable chat package "${id}" must be merged into the default chat set`);
    const merged = set.find((p) => p.id === id);
    assert.equal(merged?.url, profile.url, `${id}: merged profile must carry the packaged url`);
    assert.ok(isDriveableChatProfile(merged!), `${id}: every merged non-builtin must pass the GOAL 32 driveable gate`);
  }

  // The merged set is the SAME one the daemon default path builds (registry.ts
  // posts builtin-first, so every builtin id is untouched by the package pass).
  // Shapes that repeat a builtin id are already counted in BUILTIN_IDS.
  const nonBuiltinShapes = driveables.filter((s) => !BUILTIN_IDS.includes(s.id));
  // GOAL 147: the count is over the DRIVEABLE builtins, not the whole catalog.
  // The old arithmetic compared the chat set to `BUILTIN_IDS.length`, which only
  // balanced while catalog membership and chat membership were the same set —
  // the bug. Both sides are now the driveable count, so the identity is exact
  // and it fails if a driveable builtin is ever dropped.
  const driveableBuiltins = BUILTIN_IDS.filter((id) => isDriveableChatProfile(BUILTIN_BY_ID.get(id)!));
  assert.equal(
    set.length,
    driveableBuiltins.length + nonBuiltinShapes.length,
    "set = driveable builtins + driveable non-excluded non-builtin chat shapes, no more, no less",
  );
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

// ─── (a2) GOAL 32 TRUTH-GATE: STATUS + EXCLUSIONS ───────────────────────────

test("GOAL32(a): dormant/dead-end packages (zenmux, xiaomimimo) are excluded from the chat surface but stay on /registry with their honest status", () => {
  const surface = defaultChatSurface();
  const ids = surface.map((e) => e.id);

  // Fixture-anchored: these EXCLUDED ids must not surface as chat models, and
  // their metadata status must read honestly (the registry consumer's gate).
  for (const [id, expectedStatus] of [["zenmux", "dormant"], ["xiaomimimo", "dead-end"]] as Array<[string, string]>) {
    if (!installedAll().includes(id)) continue; // not installed on this checkout
    assert.ok(!ids.includes(id), `${id}: ${expectedStatus} package must NOT surface as a chat model`);
    assert.equal(chatSurfaceStatus(id), expectedStatus, `${id}: chatSurfaceStatus must report "${expectedStatus}"`);
    assert.equal(machineStatus(id), expectedStatus, `${id}: metadata.status must say "${expectedStatus}"`);
    // …but the package is still a real installed surface: /registry carries it
    // with that honest status (capability consumers gate on it themselves).
    const reg = buildRegistryPackages().find((p) => p.id === id);
    assert.ok(reg, `${id}: must stay on the registry`);
    assert.equal(reg.status, expectedStatus, `${id}: /registry status must be "${expectedStatus}"`);
  }

  // t3chat: former prose rows removed → driveable → surfaced, honestly marked
  // unverified-candidate (never claimed verified without a live round-trip).
  if (installedAll().includes("t3chat")) {
    assert.ok(ids.includes("t3chat"), "t3chat (prose removed) must surface through the GOAL 32 gate");
    assert.equal(surface.find((e) => e.id === "t3chat")?.status, "unverified-candidate");
  }

  // duckduckgo keeps its live-verified status; no surfaced id may claim a
  // dormant/dead-end status.
  assert.equal(surface.find((e) => e.id === "duckduckgo")?.status, "verified", "duckduckgo must remain verified (its recorded live round-trip)");
  for (const e of surface) {
    assert.ok(["verified", "unverified-candidate", "builtin"].includes(e.status), `${e.id}: surfaced status must be verified/unverified-candidate/builtin (got ${e.status})`);
  }

  // Capability-only surfaces never become chat models either.
  assert.ok(!ids.includes("youtube"), "youtube (capability-only) must never be a chat model");
});

test("GOAL32: isParseableSelector accepts runnable CSS and rejects prose, malformed CSS and playwright-only pseudo-classes", () => {
  // Runnable CSS the driver actually executes.
  assert.ok(isParseableSelector("textarea"));
  assert.ok(isParseableSelector('div[contenteditable="true"][role="textbox"]'));
  assert.ok(isParseableSelector(".markdown, [data-testid='answer']"));
  assert.ok(isParseableSelector("form textarea, form [contenteditable]"));
  assert.ok(isParseableSelector("a[href^='http'], [data-attrid='ai_web_answer'] a"));
  assert.ok(isParseableSelector("#prompt-textarea [contenteditable] > div"));
  // Prose / empty / non-string: refused — the exact former t3chat rows (GOAL 32
  // removal) are multi-clause prose with semicolons/parens and FAIL the parser;
  // a bare single-ident fragment may parse under the engine (em-dash is a valid
  // CSS ident char) — realistic prose does not, which is what the gate catches.
  assert.ok(!isParseableSelector("UNVERIFIED-SCAFFOLD — every selector below is a guess; confirm all on first live capture"));
  assert.ok(!isParseableSelector("UNVERIFIED-SCAFFOLD — no DOM class proven by bundles (none recovered); confirm on first live capture"));
  assert.ok(!isParseableSelector("The live site's actual composer element is unknown — a textarea or contenteditable is possible, but no evidence either way."));
  assert.ok(!isParseableSelector(""));
  assert.ok(!isParseableSelector("   "));
  assert.ok(!isParseableSelector(42));
  assert.ok(!isParseableSelector(null));
  assert.ok(!isParseableSelector(undefined));
  // Playwright-only pseudo-classes: parse in locator() but THROW in the DOM
  // querySelectorAll the answer-reader runs. Paren + bare forms both refused.
  assert.ok(!isParseableSelector(":has-text('New chat')"));
  assert.ok(!isParseableSelector("button:has-text(\"Continue\")"));
  assert.ok(!isParseableSelector("div:visible"));
  assert.ok(!isParseableSelector("div:not(.x):hidden"));
  assert.ok(!isParseableSelector(":text('Answer')"));
  // Legitimate CSS that merely CONTAINS similar substrings must NOT be refused.
  assert.ok(isParseableSelector("[data-textid='visible-answer'] .markdown"));
  assert.ok(isParseableSelector("textarea:focus, input:not(.hidden-submit)"));
  assert.ok(isParseableSelector("button.scroll-marker"));
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
    // GOAL 102: `spawn` has NO timeout option — a bounded KILL is the only way to
    // stop a hung child from dropping the whole file-level test.
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli.ts"), "prompt", "--sites"], { cwd: ROOT });
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
    killer.unref?.();
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.on("close", (code) => { clearTimeout(killer); return code === 0 ? resolve(stdout) : reject(new Error(`cli exited ${code}`))});
  });
  assert.match(out, /duckduckgo/, "CLI --sites must list the merged duckduckgo");
  assert.doesNotMatch(out, /^gmail\b/m, "CLI --sites must never list capability-only gmail");
});

// ─── (b) REAL DEFAULT DAEMON ROUTE TEST (no browser: attach port 1 refused) ─

test("GOAL30(b): a REAL default daemon serves duckduckgo on /sites + /v1/models and 404s unknown models", async (t) => {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1"; // boot-warm connect-refused fast; no browser is ever spawned
  // HERMETIC vault, NOT the repo's `data/`. `data/sessions/` is the operator's
  // real, gitignored captured vault: a test that reads it is exactly the class
  // that reddened CI for test/session-lock-honesty.test.ts (a captured session
  // that exists on the author's box and does not exist in a clean checkout).
  // An empty temp dir is also the honest default: with no stored session the
  // daemon must still serve the chat SURFACE (ids, statuses, models) — which is
  // what this test actually claims.
  const dataDir = mkdtempSync(join(tmpdir(), "u2a-chat-surface-"));
  try {
    // Deliberately NO profiles argument: the DEFAULT path must merge installed
    // chat-shaped packages by itself (the GOAL 30 change).
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      // GET /sites lists the merged chat-shaped package.
      const sitesRes = await fetch(`${base}/sites`);
      assert.equal(sitesRes.status, 200);
      const sites = (await sitesRes.json()) as { sites: Array<{ id: string; status?: string }> };
      const ids = sites.sites.map((s) => s.id);
      assert.ok(ids.includes("duckduckgo"), "GET /sites must include the merged duckduckgo chat package");
      for (const builtin of ["gemini", "copilot", "deepseek", "kimi"]) assert.ok(ids.includes(builtin), `GET /sites keeps builtin ${builtin}`);
      assert.ok(!ids.includes("gmail"), "GET /sites must not include capability-only gmail");

      // GOAL 32: every surfaced id carries its status; excluded packages are absent.
      for (const s of sites.sites) {
        assert.ok(s.status && ["verified", "unverified-candidate", "builtin"].includes(s.status!), `GET /sites ${s.id} must carry an honest status (got ${JSON.stringify(s.status)})`);
      }
      assert.equal(sites.sites.find((s) => s.id === "duckduckgo")?.status, "verified", "duckduckgo status on /sites must be verified");
      assert.ok(!ids.includes("zenmux") && !ids.includes("xiaomimimo"), "GET /sites must NOT include dormant/dead-end packages");

      // GOAL 32: the excluded packages keep their honest surface on /registry.
      const regRes = await fetch(`${base}/registry`);
      assert.equal(regRes.status, 200);
      const reg = (await regRes.json()) as { packages: Array<{ id: string; status: string }> };
      const zenmux = reg.packages.find((p: { id: string }) => p.id === "zenmux");
      assert.ok(zenmux, "zenmux must stay on /registry after exclusion");
      assert.equal(zenmux.status, "dormant");
      const xiaomi = reg.packages.find((p: { id: string }) => p.id === "xiaomimimo");
      assert.ok(xiaomi, "xiaomimimo must stay on /registry after exclusion");
      assert.equal(xiaomi.status, "dead-end");

      // GOAL 32 two-step: POST /prompt distinguishes installed-but-not-chat ids
      // (youtube → /capability pointer) from truly-unknown ids (plain unknown).
      const youtube = await fetch(`${base}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: "youtube", prompt: "hi" }),
      });
      assert.equal(youtube.status, 400, "youtube is not a chat model — must 400 (no browser launched)");
      // GOAL 143: this assertion read `error` as a STRING, which contradicted the
      // shipped contract — README.md states `POST /prompt` answers the SAME
      // `{"error": {"code", "message"}}` shape as /capability. The daemon now
      // honours that, so the test reads the documented shape. The guarantee it
      // exists to make is UNCHANGED and still asserted: the 400 must point the
      // caller at /capability/youtube, and it must now carry a stable code too.
      const youtubeBody = (await youtube.json()) as {
        error?: { code?: string; message?: string } | string;
      };
      const structured =
        typeof youtubeBody.error === "object" && youtubeBody.error !== null ? youtubeBody.error : null;
      const message = structured?.message ?? (typeof youtubeBody.error === "string" ? youtubeBody.error : "");
      assert.ok(
        /is installed and serves POST \/capability\/youtube/.test(message),
        `youtube 400 must point at /capability/youtube: ${message}`
      );
      assert.equal(structured?.code, "not_chat", "the not-a-chat refusal must carry its stable code");
      const nonsense = await fetch(`${base}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: "no-such-site-xyz", prompt: "hi" }),
      });
      assert.equal(nonsense.status, 400);
      // Same documented `{code, message}` shape as the youtube case above.
      const nonsenseBody = (await nonsense.json()) as {
        error?: { code?: string; message?: string } | string;
      };
      const nonsenseErr =
        typeof nonsenseBody.error === "object" && nonsenseBody.error !== null ? nonsenseBody.error : null;
      const nonsenseMsg =
        nonsenseErr?.message ?? (typeof nonsenseBody.error === "string" ? nonsenseBody.error : "");
      assert.ok(/unknown site "no-such-site-xyz"/.test(nonsenseMsg), `nonsense 400 must stay plain unknown-site: ${nonsenseBody.error}`);

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
      // …and against the HERMETIC vault it must be EMPTY: this is the pin that
      // would have caught the real-vault coupling, and it keeps the previous
      // line from being vacuous (an array literal asserts only the shape).
      assert.deepEqual(acc.accounts, [],
        "/accounts must read the FIXTURE vault only — a non-empty list here means the daemon was handed the real data/ sessions dir");

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
    rmSync(dataDir, { recursive: true, force: true });
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