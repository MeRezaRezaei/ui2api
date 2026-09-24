import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildRegistryPackages,
  capabilityInputSchema,
  bareCapabilityId,
  defaultChatSurface,
  listInstalledPackageIds,
  resolveDataDir,
} from "../src/prompt/registry.js";
import { listAccounts } from "../src/runtime/session-store.js";
import { resolvePackagedProfile } from "../src/profile/profile.js";

/** True when the real on-box vault file exists for the host (data/sessions/ is gitignored). */
function vaultPresent(host: string): boolean {
  return existsSync(join(resolveDataDir(), "sessions", host, "accounts.json"));
}

describe("prompt registry", () => {
  it("derives a chat tool schema with prompt required and site toggles", () => {
    const s = capabilityInputSchema(
      "deepseek",
      "deepseek_chat",
      "ui-path",
      "composer + thinking toggle + search toggle on the wire"
    );
    assert.equal(s.type, "object");
    assert.deepEqual(s.required, ["prompt"]);
    assert.ok(s.properties.prompt);
    assert.ok(s.properties.thinking, "thinking toggle surfaced from manifest description");
    assert.ok(s.properties.search, "search toggle surfaced from manifest description");
  });

  it("derives toggle and read schemas for non-chat capabilities", () => {
    const toggle = capabilityInputSchema("deepseek", "deepseek_web_search", "ui-path", "flip Search");
    assert.equal(toggle.required.length, 0);
    assert.ok(toggle.properties.state);
    const read = capabilityInputSchema("deepseek", "deepseek_list_conversations", "ui-path", "sidebar");
    assert.ok(read.properties.limit, "read capabilities expose a limit hint");
  });

  it("strips the site prefix from capability ids for tool names", () => {
    assert.equal(bareCapabilityId("deepseek", "deepseek_chat"), "chat");
    assert.equal(bareCapabilityId("deepseek", "deepseek_list_conversations"), "list_conversations");
    assert.equal(bareCapabilityId("kimi", "model_list"), "model_list");
    // Hyphenated site, underscore-prefixed capability ids (tencent-aistudio).
    assert.equal(bareCapabilityId("tencent-aistudio", "tencent_aistudio_chat"), "chat");
  });

  it("builds registry packages from installed capability packages (served sites only)", () => {
    const packages = buildRegistryPackages();
    const surfaceIds = new Set(defaultChatSurface().map((e) => e.id));
    assert.ok(Array.isArray(packages));
    // ALL-33 regression: every installed package with a packaged profile is
    // listed — /registry IS the package registry; hiding packages is not the
    // fix, the chat field's truth is (GOAL 34).
    assert.equal(
      packages.length,
      listInstalledPackageIds().length,
      "registry must list every installed package (all-33 stays listed)"
    );
    for (const pkg of packages) {
      // (a) chat-surface ids keep the chat claim (chat.model === id);
      // (b) everything else carries NO chat claim at all — status/tools/
      //     accounts are kept, chat is not advertised for /v1-unservable ids.
      if (surfaceIds.has(pkg.id)) {
        assert.equal(pkg.chat?.model, pkg.id, `${pkg.id}: servable chat surface id must carry chat.model === id`);
      } else {
        assert.equal(pkg.chat, undefined, `${pkg.id}: non-servable package must NOT claim chat (GOAL 34)`);
        // The WIRE shape is what consumers read: the emitted JSON has no chat
        // key at all — consumers key on pkg.chat?.model and must treat absence
        // as "no chat" (never materialize a chat provider for it).
        const wire = JSON.parse(JSON.stringify(pkg)) as { chat?: unknown };
        assert.ok(!("chat" in wire), `${pkg.id}: emitted registry package must not carry a chat key`);
      }
      assert.equal(typeof pkg.name, "string");
      assert.ok(Array.isArray(pkg.tools));
      assert.equal(typeof pkg.status, "string");
      for (const tool of pkg.tools) {
        assert.ok(tool.name.startsWith(`${pkg.id}_`), `tool ${tool.name} namespaced by site`);
        assert.equal(typeof tool.id, "string", `tool ${tool.name} carries raw daemon capability id`);
        assert.equal(tool.inputSchema.type, "object");
        // The map contract distinguishes the two work types — driving the site's
        // own real UI (ui-path) versus calling the site's own JS function
        // (js-function) — and carries the reload policy so every language map
        // reflects "after each successful action the only thing we need to do
        // is to refresh the page".
        assert.ok(tool.workType === "ui-path" || tool.workType === "js-function");
        assert.equal(tool.reloadAfterSuccess, true);
      }
    }
  });

  it("registry chat.model set == /v1 servable surface (same gate, no hardcoded id list)", () => {
    const packages = buildRegistryPackages();
    // The gate the daemon actually serves from: the default promptd path builds
    // its /v1 profilesById allow-list from defaultChatProfiles() ==
    // defaultChatSurface() (http.ts), and openai.ts profileById() refuses
    // anything outside it with 404 unknown_model. No hardcoded 23/10 here —
    // the parity is derived from the same gate both sides use.
    const surfaceIds = new Set(defaultChatSurface().map((e) => e.id));
    const installed = new Set(listInstalledPackageIds());
    const byId = new Map(packages.map((p) => [p.id, p]));
    // direction 1: every registry chat claim is /v1-servable.
    for (const pkg of packages) {
      if (pkg.chat) {
        assert.ok(surfaceIds.has(pkg.id), `${pkg.id}: registry chat claim must be on the /v1 servable surface`);
        assert.equal(pkg.chat.model, pkg.id, `${pkg.id}: chat.model must be the site id /v1 accepts`);
      }
    }
    // direction 2: every servable id that is an installed package carries the
    // registry chat claim — a servable package is never left chat-less.
    for (const id of surfaceIds) {
      if (installed.has(id)) {
        const pkg = byId.get(id);
        assert.ok(pkg, `${id}: servable surfaced id must be listed on /registry`);
        assert.ok(pkg.chat && pkg.chat.model === id, `${id}: every servable installed id must carry chat.model on /registry`);
      }
    }
  });

  it("refuses chat claims for exactly the /v1-unservable packages (GOAL 34 named 10)", () => {
    const packages = buildRegistryPackages();
    const surfaceIds = new Set(defaultChatSurface().map((e) => e.id));
    const refused = listInstalledPackageIds().filter((id) => !surfaceIds.has(id)).sort();
    // The 10 ids GOAL 34 names (derived above from the gate for the general
    // rule; this literal pin forces a conscious test+docs update the day any
    // of them becomes driveable via url/selectors + a live round-trip).
    assert.deepEqual(refused, [
      "adapta",
      "araprat",
      "chatglm",
      "conol",
      "doubao",
      "gmail",
      "tinycms",
      "xiaomimimo",
      "youtube",
      "zenmux",
    ]);
    for (const id of refused) {
      const pkg = packages.find((p) => p.id === id);
      assert.ok(pkg, `${id}: refused id must still be LISTED on /registry (hiding is not the fix)`);
      assert.equal(pkg.chat, undefined, `${id}: refused id carries no chat claim`);
      assert.ok(Array.isArray(pkg.tools), `${id}: refused id keeps its tools`);
    }
  });

  it("exposes a machine-checkable verified record (false or full {since,evidence,via})", () => {
    const packages = buildRegistryPackages();
    // Every package carries the field; a truthy value is always a full record.
    for (const pkg of packages) {
      assert.ok("verified" in pkg, `${pkg.id}: registry package must carry a verified field`);
      if (pkg.verified !== false) {
        assert.equal(typeof pkg.verified.since, "string");
        assert.equal(typeof pkg.verified.evidence, "string");
        assert.equal(typeof pkg.verified.via, "string");
        assert.ok(pkg.verified.since.length > 0 && pkg.verified.evidence.length > 0 && pkg.verified.via.length > 0, `${pkg.id}: verified record must be non-empty`);
      }
    }
    // The live-verified packages from folds #5/#6 (and earlier) must be marked.
    const byId = new Map(packages.map((p) => [p.id, p]));
    for (const id of ["deepseek", "kimi", "gemini"]) {
      const p = byId.get(id);
      assert.ok(p, `expected package ${id} in registry`);
      assert.notEqual(p!.verified, false, `${id} should carry a verified record (live round-trip recorded)`);
    }
    // A scaffold-only package with no metadata stays unverified.
    const unver = packages.filter((p) => p.verified === false);
    assert.ok(unver.length > 0, "some packages are honestly NOT verified");
  });

  it("exposes per-package stored accounts consistent with GET /accounts (vault on disk)", (t) => {
    const packages = buildRegistryPackages();
    const dataDir = resolveDataDir();
    const byId = new Map(packages.map((p) => [p.id, p]));
    for (const pkg of packages) {
      const profile = resolvePackagedProfile(pkg.id);
      if (profile?.url) {
        // url-ful package -> accounts is a REAL array (possibly []), exactly
        // what the vault returns for the SAME host GET /accounts?site= serves
        // (http.ts derives it as new URL(profile.url).host — not manifest url).
        const host = new URL(profile.url).host;
        assert.ok(Array.isArray(pkg.accounts), `${pkg.id}: url-ful package must carry an accounts array`);
        assert.deepEqual(
          pkg.accounts,
          listAccounts(dataDir, host),
          `${pkg.id}: accounts must match the on-disk vault for ${host}`
        );
      } else {
        // url-less package -> field ABSENT (undefined), never an empty array.
        assert.equal(pkg.accounts, undefined, `${pkg.id}: url-less package must omit accounts`);
      }
    }
    // On-box vault today: deepseek + gemini each hold a stored identity; the
    // registry surfaces it. Empty-vault honesty ([]) is exercised by the loop
    // for url-ful hosts with no accounts.json on this box (e.g. kimi's profile
    // host www.kimi.com has none — even though manifest says www.kimi.ai).
    const deepseek = byId.get("deepseek");
    if (!vaultPresent("chat.deepseek.com")) {
      t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none) — skipping deepseek vault assert");
    } else {
      assert.ok(deepseek && Array.isArray(deepseek.accounts) && deepseek.accounts.length > 0, "deepseek: stored vault account listed in registry");
    }
    const gemini = byId.get("gemini");
    if (!vaultPresent("gemini.google.com")) {
      t.skip("no vault for gemini.google.com (data/ is gitignored — clean checkout has none) — skipping gemini vault assert");
    } else {
      assert.ok(gemini && Array.isArray(gemini.accounts) && gemini.accounts.length > 0, "gemini: stored vault account listed in registry");
    }
    // url-less fixtures keep the field STRICTLY absent.
    assert.equal(byId.get("chatglm")?.accounts, undefined, "chatglm: no url => no accounts field");
    assert.equal(byId.get("tinycms")?.accounts, undefined, "tinycms: no url => no accounts field");
  });
});