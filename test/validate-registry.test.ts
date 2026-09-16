import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePackage, validateManifest } from "../scripts/validate-registry.mjs";

// v2 package writer: metadata.json + manifest.json (+ optional recipes/)
function writePkg(dir: string, meta: any, manifest: any, recipes: Record<string, unknown> = {}) {
  mkdirSync(join(dir, "recipes"), { recursive: true });
  writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(recipes)) {
    writeFileSync(join(dir, "recipes", name), JSON.stringify(body));
  }
}

const siteId = (dir: string) => dir.split("/").pop()!;

function okMeta(id: string, extra: Record<string, unknown> = {}) {
  return {
    siteId: id, site: "a.test", name: "A Test", url: "https://a.test/", version: "1.0.0",
    status: "active", author: "test", authorizedUse: "automate my own a.test account",
    license: "MIT", ui2api: "0.1.0", trust: "unreviewed", publishedAt: "2026-01-01",
    ...extra,
  };
}
function okManifest(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: "A Test", site: "a.test", url: "https://a.test/", version: "1.0.0",
    capabilities: [{ id: "chat", name: "Chat", description: "send a prompt", recipe: "recipes/chat.json" }],
    ...extra,
  };
}

describe("validatePackage (v2)", () => {
  it("passes a clean authorized package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "a.test");
      writePkg(dir, okMeta("a.test"), okManifest("a.test"), { "chat.json": { steps: [] } });
      const r = validatePackage(dir);
      assert.equal(r.ok, true, r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("rejects an evasion package", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "a.test");
      writePkg(dir, okMeta("a.test", { authorizedUse: "bypass cloudflare to scrape" }), okManifest("a.test"), { "chat.json": {} });
      const r = validatePackage(dir);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e: string) => e.includes("forbidden term")), r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("does not flag an honest captcha-gating disclosure", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "a.test");
      const m = okManifest("a.test");
      m.capabilities[0].description = "the site is Cloudflare/hCaptcha gated; a headed live capture is required";
      writePkg(dir, okMeta("a.test"), m, { "chat.json": {} });
      const r = validatePackage(dir);
      assert.equal(r.ok, true, r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("rejects a siteId that does not match the folder", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "a.test");
      writePkg(dir, okMeta("wrong.test"), okManifest("a.test"), { "chat.json": {} });
      const r = validatePackage(dir);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e: string) => e.includes("must match folder")), r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("rejects a capability whose recipe file is missing", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "a.test");
      writePkg(dir, okMeta("a.test"), okManifest("a.test"), {});
      const r = validatePackage(dir);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e: string) => e.includes("recipe file missing")), r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("rejects an orphan recipe not referenced by any capability", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "a.test");
      writePkg(dir, okMeta("a.test"), okManifest("a.test"), { "chat.json": {}, "orphan.json": {} });
      const r = validatePackage(dir);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e: string) => e.includes("orphan recipe")), r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  it("allows a dead-end package with no url", () => {
    const tmp = mkdtempSync(join(tmpdir(), "u2a-val-"));
    try {
      const dir = join(tmp, "dead");
      const m = okManifest("dead", { site: null, url: null, status: "dead-end" });
      writePkg(dir, okMeta("dead", { site: null, url: null, status: "dead-end" }), m, { "chat.json": {} });
      const r = validatePackage(dir);
      assert.equal(r.ok, true, r.errors.join("; "));
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe("validateManifest (hub publish path)", () => {
  it("returns null for a clean manifest", () => {
    assert.equal(validateManifest({ authorizedUse: "my own account", name: "x" }, "export default {}"), null);
  });
  it("returns an error string for evasion", () => {
    const e = validateManifest({ authorizedUse: "bypass cloudflare" }, "");
    assert.ok(typeof e === "string" && e.includes("forbidden term"));
  });
});
