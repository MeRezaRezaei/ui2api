import { strict as assert } from "node:assert";
import { describe, it, afterEach } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_PROFILES, PROFILE_IDS, defaultSiteId, resolveProfile, listProfiles } from "../src/profile/profile.js";

function clearEnv() {
  delete process.env.UI2API_AI_SITE;
  const orig = { UI2API_CHROME: process.env.UI2API_CHROME, UI2API_USER_DATA_DIR: process.env.UI2API_USER_DATA_DIR };
  delete process.env.UI2API_CHROME;
  delete process.env.UI2API_USER_DATA_DIR;
  return orig;
}
function restoreEnv(orig: Record<string, string | undefined>) {
  const { UI2API_CHROME, UI2API_USER_DATA_DIR } = orig;
  if (UI2API_CHROME) process.env.UI2API_CHROME = UI2API_CHROME;
  else delete process.env.UI2API_CHROME;
  if (UI2API_USER_DATA_DIR) process.env.UI2API_USER_DATA_DIR = UI2API_USER_DATA_DIR;
  else delete process.env.UI2API_USER_DATA_DIR;
}

describe("chat-site profiles (MVP: use AI sites for doing prompts)", () => {
  afterEach(() => {
    delete process.env.UI2API_AI_SITE;
    clearEnv();
  });

  it("ships profiles for the major AI chat sites, gemini included", () => {
    for (const id of ["gemini", "chatgpt", "claude", "copilot", "perplexity", "huggingchat"]) {
      assert.ok(PROFILE_IDS.includes(id), `missing profile ${id}`);
    }
    for (const p of listProfiles()) {
      assert.ok(/^https:\/\//.test(p.url), `${p.id}.url must be https`);
      assert.ok(Array.isArray(p.composer) && p.composer.length > 0, `${p.id}.composer`);
      assert.ok(Array.isArray(p.answer) && p.answer.length > 0, `${p.id}.answer`);
      assert.ok(p.id && p.name, `${p.id} must have id+name`);
    }
  });

  it("gemini requires login; copilot is the anonymous default", () => {
    assert.equal(BUILTIN_PROFILES.gemini.loginRequired, true);
    assert.equal(BUILTIN_PROFILES.copilot.loginRequired, false);
  });

  it("defaults to copilot (anonymous) on a fresh host, gemini when reusing a real Chrome profile", () => {
    restoreEnv(clearEnv());
    assert.equal(defaultSiteId(), "copilot");
    assert.equal(resolveProfile().id, "copilot");

    process.env.UI2API_CHROME = "1";
    process.env.UI2API_USER_DATA_DIR = "/home/me/real-profile";
    assert.equal(defaultSiteId(), "gemini");
    assert.equal(resolveProfile().id, "gemini");
  });

  it("resolves built-in ids and honors UI2API_AI_SITE", () => {
    assert.equal(resolveProfile("chatgpt").id, "chatgpt");
    process.env.UI2API_AI_SITE = "claude";
    assert.equal(resolveProfile().id, "claude");
  });

  it("loads a JSON profile override file, inheriting the named built-in", () => {
    const dir = mkdtempSync(join(tmpdir(), "u2a-profile-"));
    try {
      const file = join(dir, "gemini-override.json");
      writeFileSync(file, JSON.stringify({ id: "gemini", composer: ["#custom-composer"] }));
      const p = resolveProfile(file);
      assert.equal(p.id, "gemini");
      assert.deepEqual(p.composer, ["#custom-composer"]);
      // Unspecified fields fall back to the gemini built-in.
      assert.ok(Array.isArray(p.answer) && p.answer.length > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown ids with a helpful message", () => {
    assert.throws(() => resolveProfile("nope"), /unknown AI site/);
  });
});