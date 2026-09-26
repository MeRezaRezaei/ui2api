import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CAPABILITY_DISPATCH } from "../src/prompt/capability-dispatch.js";
import { buildRegistryPackages, bareCapabilityId } from "../src/prompt/registry.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

// ────────────────────────────────────────────────────────────────────────────
// GOAL 7 — function → api → ui closure for every capability package
//
// Every capability declared in every `capabilities/<site>/manifest.json` must
// be reachable end-to-end across all three layers, or the package HONESTLY
// short-circuits it as login-gated (ok:false loginGated:true, no browser):
//
//   (1) FUNCTION layer — src/capabilities/<site>.ts dispatches the capability
//       (a `case "<id>":` label) so it can NEVER fall into the runner's
//       "unknown <site> capability" dead branch. Sites listed in
//       LOGIN_GATED_BY_DESIGN dispatch every capability through an honest
//       loginGated branch — same mechanism as the araprat posting caps.
//   (2) API layer — src/prompt/http.ts exposes a `/capability/<site>`
//       dispatcher that forwards the capability name to that runner.
//   (3) UI/registry layer — GET /registry (buildRegistryPackages) emits a tool
//       named `<site>_<capability>` with an inputSchema from the manifest.
//
// All three checks are mechanical (read the source / manifests, call the
// hermetic registry builder). Anything that drifts fails loudly.
// ────────────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPABILITIES_DIR = join(ROOT, "capabilities");
const RUNNERS_DIR = join(ROOT, "src", "capabilities");
const HTTP_SOURCE = readFileSync(join(ROOT, "src", "prompt", "http.ts"), "utf8");

/**
 * Sites explicitly listed as login-gated-BY-DESIGN: no captured session exists
 * for them anywhere on this box, so every declared capability is honestly
 * dispatched to an ok:false loginGated:true short-circuit (never a fabricated
 * success, never a dead unknown branch). These runners exist so /capability/<site>
 * and GET /registry serve the package's real declared surface. A site leaves
 * this list the moment a live-verified runner implementation lands.
 */
const LOGIN_GATED_BY_DESIGN = new Set([
  "adapta",
  "blackbox",
  "chatglm",
  "codex",
  "conol",
  "copilot-m365",
  "doubao",
  "google-ai-search",
  "grok",
  "inner-ai",
  "manus",
  "notion",
  "perplexity",
  "poe",
  "t3chat",
  "tinycms",
  "v0",
  "xiaomimimo",
  "zenmux",
]);

// ─── Discovery: every directory under capabilities/ carrying a manifest ────
const pkgNames = readdirSync(CAPABILITIES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(CAPABILITIES_DIR, e.name, "manifest.json")))
  .map((e) => e.name)
  .sort();

interface ManifestCapability {
  id?: string;
  name?: string;
  description?: string;
}

function readManifest(site: string): { capabilities: ManifestCapability[] } {
  return JSON.parse(readFileSync(join(CAPABILITIES_DIR, site, "manifest.json"), "utf8"));
}

/** Capability ids declared by a package manifest (`id`, with `name` fallback). */
function manifestCapabilityIds(site: string): string[] {
  const m = readManifest(site);
  assert.ok(Array.isArray(m.capabilities) && m.capabilities.length > 0, `${site}/manifest.json has no capabilities[]`);
  return m.capabilities.map((c) => {
    const id = c.id ?? c.name;
    assert.ok(typeof id === "string" && id.length > 0, `${site}/manifest.json capability entry has no id: ${JSON.stringify(c)}`);
    return id as string;
  });
}

/** `case "<id>":` labels in a runner's dispatch switch (same extraction as capability-dispatch.test.ts). */
function dispatchLabels(site: string): string[] {
  const src = readFileSync(join(RUNNERS_DIR, `${site}.ts`), "utf8");
  return [...src.matchAll(/case\s+"([^"]+)":/g)].map((m) => m[1]);
}

function runnerSource(site: string): string {
  return readFileSync(join(RUNNERS_DIR, `${site}.ts`), "utf8");
}

/** Class name each runner exports, derived from the package id (XxxYyyCapabilities). */
function runnerClassName(site: string): string {
  const pascal = site.replace(/-/g, "_").split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `${pascal}Capabilities`;
}

// ─── Registry layer: build ONCE (hermetic file read, no network/browser) ────
const registryPackages = buildRegistryPackages();
const registryById = new Map(registryPackages.map((p) => [p.id, p]));

// ─── Per-package 3-layer closure ────────────────────────────────────────────
for (const site of pkgNames) {
  const capIds = manifestCapabilityIds(site);
  const gated = LOGIN_GATED_BY_DESIGN.has(site);

  test(`GOAL7 closure: function→api→ui for capabilities/${site}`, async (t) => {
    const labels = dispatchLabels(site);
    assert.ok(labels.length > 0, `no case labels parsed from src/capabilities/${site}.ts`);

    await t.test("A. FUNCTION layer — every manifest capability is dispatched in the runner", () => {
      const missing = capIds.filter((id) => !labels.includes(id));
      assert.deepEqual(
        missing,
        [],
        `manifest capabilities with NO runner dispatch branch: ${missing.join(", ")} — a manifest capability falling into the "unknown ${site} capability" default is a closure violation`
      );
      const extra = labels.filter((l) => !capIds.includes(l));
      if (extra.length > 0) {
        t.diagnostic(`runner dispatches capabilities NOT in manifest: ${extra.join(", ")}`);
      }
      if (gated) {
        assert.ok(
          runnerSource(site).includes("loginGated"),
          `login-gated-by-design site ${site} must dispatch through an honest loginGated branch (ok:false loginGated:true, no browser)`
        );
      }
    });

    // GOAL 140: the per-site literal `req.url === "/capability/<site>"` is GONE.
    // One table-driven handler replaced 33 of them. The INTENT is unchanged — the
    // site must have a live API route — but the evidence is now the dispatch
    // table plus the presence of the single prefix-matching handler, which is a
    // stronger statement (a site is routable because it is DATA, not because
    // someone pasted an `if` into a 1,700-line file).
    await t.test("B. API layer — the site is routable through the dispatch table", () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CAPABILITY_DISPATCH, site),
        `capabilities/${site} has capabilities and a runner, but NO row in capability-dispatch.ts — `
          + `the API surface cannot route it (the runner exists but the API surface is missing)`
      );
      // The one handler all sites share must actually be wired in.
      assert.ok(
        HTTP_SOURCE.includes('req.url?.startsWith("/capability/")'),
        "the table-driven /capability handler is missing from http.ts"
      );
    });

    await t.test("C. UI/registry layer — GET /registry emits <site>_<capability> tools from the manifest", () => {
      const pkg = registryById.get(site);
      assert.ok(pkg, `buildRegistryPackages() returns no package for ${site} — registry layer missing for a packaged site`);
      assert.ok(Array.isArray(pkg!.tools), `${site}: registry package has no tools[]`);
      const toolNames = new Set(pkg!.tools.map((tool) => tool.name));
      assert.equal(
        new Set(toolNames).size,
        pkg!.tools.length,
        `${site}: registry tools[] contains duplicate names — a capability maps to two tools`
      );
      for (const id of capIds) {
        const tool = pkg!.tools.find((x) => x.id === id);
        assert.ok(tool, `${site}: manifest capability "${id}" has NO registry tool — missing <site>_<capability> tool entry`);
        const expectedName = `${site}_${bareCapabilityId(site, id)}`;
        assert.equal(tool!.name, expectedName, `${site}: tool for "${id}" must be named ${expectedName} (found ${tool!.name})`);
        assert.equal(tool!.inputSchema.type, "object", `${site}: tool "${tool!.name}" has a non-object inputSchema`);
        assert.ok(Array.isArray(tool!.inputSchema.required), `${site}: tool "${tool!.name}" inputSchema has no required[]`);
      }
    });
  });
}

// ─── Live behavior guard: login-gated runners settle honestly, no browser ──
test("GOAL7 guard: login-gated runners return ok:false loginGated:true for manifest caps (no browser)", async () => {
  for (const site of LOGIN_GATED_BY_DESIGN) {
    const mod = await import(`../src/capabilities/${site}.js`);
    const Ctor = mod[runnerClassName(site)] as new (profile: ChatSiteProfile) => {
      run(capability: string, args?: Record<string, unknown>): Promise<unknown>;
      close(): Promise<void>;
    };
    assert.ok(Ctor, `no exported ${runnerClassName(site)} in src/capabilities/${site}.ts`);
    const runner = new Ctor({ id: site } as ChatSiteProfile);

    for (const id of manifestCapabilityIds(site)) {
      const r = (await runner.run(id)) as { ok: boolean; capability: string; error?: string; loginGated?: boolean };
      assert.equal(r.capability, id, `${site}: capability echoes back`);
      assert.equal(r.ok, false, `${site}: ${id} must be ok:false (honest, not fabricated)`);
      assert.equal(r.loginGated, true, `${site}: ${id} must carry loginGated:true`);
      assert.ok(String(r.error ?? "").includes("login"), `${site}: ${id} error explains login requirement`);
      assert.ok(String(r.error ?? "").includes(site), `${site}: ${id} error names the site`);
    }

    // Unknown capability still lands in the dead-branch default — never a browser.
    const u = (await runner.run("definitely-not-a-capability")) as { ok: boolean; error?: string };
    assert.equal(u.ok, false, `${site}: unknown capability must be rejected`);
    assert.ok(String(u.error ?? "").includes("unknown"), `${site}: unknown capability error names the dead branch`);
    assert.ok(String(u.error ?? "").includes(site), `${site}: unknown capability error names the site`);
    await runner.close();
  }
});

// ─── No dead "unknown <site> capability" branches reachable for manifest caps ──
test("GOAL7 guard: no manifest capability can reach an unknown/ default branch in any runner", () => {
  const deadBranchSites: string[] = [];
  for (const site of pkgNames) {
    const labels = dispatchLabels(site);
    const missing = manifestCapabilityIds(site).filter((id) => !labels.includes(id));
    if (missing.length > 0) deadBranchSites.push(`${site} (${missing.join(", ")})`);
  }
  assert.deepEqual(
    deadBranchSites,
    [],
    "manifest capabilities without a dispatch branch — these WOULD fall into the runner's unknown default: " + deadBranchSites.join("; ")
  );
  // The fall-through strings exist as a safety net on every runner…
  for (const site of pkgNames) {
    const src = runnerSource(site);
    if (!src.includes(`unknown ${site} capability`)) {
      assert.ok(grepDeepBranch(src, site), `runner src/capabilities/${site}.ts must carry a default error naming the site`);
    }
  }
});

/** Loose matcher: any "unknown <site-id> capability" style fall-through string (site id may hyphens). */
function grepDeepBranch(src: string, site: string): boolean {
  const quoted = site.replace(/[-_.]/g, "[-_.]");
  return new RegExp(`unknown\\s+${quoted}\\s+capability`).test(src);
}

test("GOAL7 discovery: the closure walk covered every packaged site with a manifest", () => {
  const withRunner = pkgNames.filter((s) => existsSync(join(RUNNERS_DIR, `${s}.ts`)));
  assert.ok(pkgNames.length >= 12, `expected at least the 12 long-running routed sites, found ${pkgNames.length}`);
  assert.deepEqual(
    withRunner,
    pkgNames,
    `every packaged site needs a runner under src/capabilities/ (missing: ${pkgNames.filter((s) => !withRunner.includes(s)).join(", ")})`
  );
  for (const site of pkgNames) {
    assert.ok(registryById.has(site), `${site}: packaged site missing from the registry builder output`);
  }
});