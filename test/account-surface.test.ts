import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistryPackages, resolveDataDir } from "../src/prompt/registry.js";
import { resolvePackagedProfile } from "../src/profile/profile.js";
import { listAccounts, loadAccountSnapshot, slugifyIdentity } from "../src/runtime/session-store.js";
import type { ChatSiteProfile } from "../src/profile/profile.js";

// ────────────────────────────────────────────────────────────────────────────
// GOAL 8 / Wave 8.2-B — identity-keyed account selection on the capability
// surface: PATH-FORM PARITY + MECHANICAL VERIFICATION
//
// Wave 8.1 landed `account` routing on /capability/<site> (validated against
// the vault via resolveCapabilityAccount BEFORE any browser work). This suite
// pins the NEW path-form surface (`GET /capabilities/<site>` now carries the
// stored accounts, consistent with the peer's registry field `pkg.accounts`
// and with `GET /accounts?site=`) and proves the account contract stays honest:
//
//   (a) PATH-FORM PARITY — the /capabilities/<site> payload contract derives
//       accounts from the registry field it must NOT re-derive (`pkg.accounts
//       ?? []`), and that field equals listAccounts(resolveDataDir(),
//       <registry-derived-host>) for hosts with a real on-box vault
//       (deepseek/gemini/tencent-aistudio; see data/sessions/). An empty /
//       mismatched vault surfaces as [] — never fabricated.
//   (b) GATED SURFACE STILL HONEST WITH ACCOUNT — login-gated runners accept
//       `{ account }` and still settle ok:false loginGated:true naming their
//       site; NO browser is ever opened.
//   (c) VALIDATION BOUNDARY — an unknown account is rejected before any
//       browser work: resolveCapabilityAccount's predicate (the exact find())
//       misses, loadAccountSnapshot(s) for it is null, and http.ts orders the
//       validation call ahead of pool.sharedBrowser() with the throw mapped
//       to a 400 in the server catch.
//
// Nothing here launches a browser: every check is a vault/file/source read or
// a login-gated runner short-circuit.
// ────────────────────────────────────────────────────────────────────────────

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAPABILITIES_DIR = join(ROOT, "capabilities");
const HTTP_SOURCE = readFileSync(join(ROOT, "src", "prompt", "http.ts"), "utf8");

/** Host the registry keys the vault by — the SAME derivation buildRegistryPackages uses. */
function registryVaultHost(siteId: string): string {
  const profile = resolvePackagedProfile(siteId);
  assert.ok(profile, `${siteId}: no packaged ChatSiteProfile — buildRegistryPackages would skip it`);
  return new URL(profile!.url).host;
}

/** A package's path-form accounts field, exactly as the /capabilities/<site> handler computes it. */
function pathFormAccounts(pkg: NonNullable<ReturnType<typeof buildRegistryPackages>[number]>): unknown[] {
  return pkg.accounts ?? [];
}

// ─── (a) PATH-FORM PARITY ───────────────────────────────────────────────────

test("GOAL8(a): /capabilities/<site> exposes accounts via the registry field, not a host re-derivation", () => {
  const accountsLine = "accounts: pkg.accounts ?? [],";
  assert.ok(
    HTTP_SOURCE.includes(accountsLine),
    "http.ts path-form branch must expose `accounts: pkg.accounts ?? []` (parity with the registry field; undefined -> [])"
  );
  const sourceIdx = HTTP_SOURCE.indexOf('source: "manifest",');
  const accountsIdx = HTTP_SOURCE.indexOf(accountsLine);
  assert.ok(sourceIdx >= 0, "path-form branch still carries source:\"manifest\"");
  assert.ok(
    accountsIdx > sourceIdx,
    "accounts must live in the same /capabilities/<site> response object as source:\"manifest\""
  );
});

test("GOAL8(a): registry accounts field equals the vault for hosts with real on-box vaults", () => {
  // Real, on-box, live vault state (data/sessions/<host>/accounts.json exists).
  const realVaultHosts = [
    { site: "deepseek", host: "chat.deepseek.com", slug: "merezarezaei@gmail.com", identity: "merezarezaei@gmail.com" },
    { site: "gemini", host: "gemini.google.com", slug: "merezarezaei@gmail.com", identity: "merezarezaei@gmail.com" },
    { site: "tencent-aistudio", host: "aistudio.tencent.ai", slug: "merezarezaei@gmail.com", identity: "merezarezaei@gmail.com" },
  ] as const;
  const pkgs = buildRegistryPackages();
  const byId = new Map(pkgs.map((p) => [p.id, p]));

  for (const { site, host, slug, identity } of realVaultHosts) {
    const pkg = byId.get(site);
    assert.ok(pkg, `${site}: packaged site missing from buildRegistryPackages()`);

    // The field's host key is the packaged profile's (manifest url can differ),
    // so verify against THAT host — no drift between registry and route.
    const keyedHost = registryVaultHost(site);
    assert.equal(keyedHost, host, `${site}: packaged profile must key the vault by ${host} (staging assumption)`);
    const stored = listAccounts(resolveDataDir(), keyedHost);
    assert.ok(Array.isArray(pkg.accounts), `${site}: accounts field must be defined (url resolvable) — got ${pkg.accounts}`);
    assert.deepEqual(
      pathFormAccounts(pkg),
      stored,
      `${site}: path-form accounts must equal listAccounts(resolveDataDir(), "${keyedHost}") — host-derivation drift`
    );
    assert.ok(stored.length >= 1, `${site}: expected a real on-box vault at ${keyedHost}`);
    assert.ok(
      stored.some((a) => a.slug === slug && a.identity === identity),
      `${site}: vault at ${keyedHost} should hold the real identity ${identity}`
    );
    // Each stored account is consumer-shaped (the /accounts contract):
    for (const a of stored) {
      assert.equal(typeof a.slug, "string");
      assert.equal(typeof a.identity, "string");
      assert.equal(typeof a.host, "string");
      assert.equal(typeof a.capturedAt, "string");
      assert.ok(["capture", "ingest", "import", "legacy"].includes(a.source));
    }
  }
});

test("GOAL8(a): kimi keys the vault by www.kimi.ai (corrected profile) — accounts surfaces the real vault", () => {
  // kimi was a host-drift case: its packaged profile url was https://www.kimi.com
  // while manifest, builtin profile, and the captured vault all use
  // https://www.kimi.ai — so registry + path-form keyed the wrong host and
  // surfaced [] honestly-but-wrongly. Fixed: packaged profile.url now matches
  // www.kimi.ai (canonical; manifest + builtin + live sessions agree), so the
  // field must surface the REAL on-box vault, not [].
  const pkgs = buildRegistryPackages();
  const kimi = pkgs.find((p) => p.id === "kimi");
  assert.ok(kimi, "kimi: packaged site missing from buildRegistryPackages()");
  const host = registryVaultHost("kimi");
  assert.equal(host, "www.kimi.ai", "kimi packaged profile must key the vault by www.kimi.ai (canonical)");
  const stored = listAccounts(resolveDataDir(), host);
  assert.ok(stored.length >= 1, `kimi: expected a real on-box vault at ${host}`);
  assert.deepEqual(
    pathFormAccounts(kimi),
    stored,
    "kimi path-form accounts must equal listAccounts(resolveDataDir(), \"www.kimi.ai\")"
  );
});

// ─── (b) GATED SURFACE STILL HONEST WITH ACCOUNT ────────────────────────────

function readManifestCapabilityIds(site: string): string[] {
  const m = JSON.parse(readFileSync(join(CAPABILITIES_DIR, site, "manifest.json"), "utf8")) as {
    capabilities?: Array<{ id?: string; name?: string }>;
  };
  const ids = (m.capabilities ?? []).map((c) => c.id ?? c.name);
  assert.ok(ids.length > 0, `${site}/manifest.json has no capabilities[]`);
  return ids.map((id) => id as string);
}

function runnerClassName(site: string): string {
  const pascal = site.replace(/-/g, "_").split("_").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `${pascal}Capabilities`;
}

for (const site of ["poe", "perplexity"]) {
  test(`GOAL8(b): login-gated ${site} stays honest when an account is supplied (no browser)`, async () => {
    const mod = await import(`../src/capabilities/${site}.js`);
    const Ctor = mod[runnerClassName(site)] as new (
      profile: ChatSiteProfile,
      opts?: { account?: string; browser?: unknown; dataDir?: string }
    ) => { run(capability: string, args?: Record<string, unknown>): Promise<unknown>; close(): Promise<void> };
    assert.ok(Ctor, `no exported ${runnerClassName(site)}`);
    const runner = new Ctor({ id: site } as ChatSiteProfile, { account: "someone@example.com" });

    for (const id of readManifestCapabilityIds(site)) {
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
    assert.ok(String(u.error ?? "").includes(site), `${site}: unknown capability error names the site`);
    await runner.close();
  });
}

// ─── (c) VALIDATION BOUNDARY ────────────────────────────────────────────────

test("GOAL8(c): an unknown account misses resolveCapabilityAccount's predicate and loads no snapshot", () => {
  const host = registryVaultHost("deepseek"); // the registry's keyed host (chat.deepseek.com)
  const dataDir = resolveDataDir();
  const bogus = "no-such-account@example.com";

  // Exact predicate resolveCapabilityAccount runs BEFORE any browser work:
  const stored = listAccounts(dataDir, host);
  const match = stored.find((a) => a.slug === slugifyIdentity(bogus) || a.identity === bogus);
  assert.equal(match, undefined, `bogus identity must not match any stored account at ${host}`);

  // The throw message shape is pinned in http.ts (must not drift):
  const template =
    'no stored account "${account}" for "${host}"; available: [${stored.map((a) => a.slug).join(", ")}]';
  assert.ok(HTTP_SOURCE.includes(template), "resolveCapabilityAccount throw message shape must stay pinned");

  // Honest negative through the snapshot seam the runner would use:
  assert.equal(
    loadAccountSnapshot(dataDir, host, bogus),
    null,
    "bogus identity -> no snapshot (a real runner could never fabricate an account session)"
  );
});

test("GOAL8(c): the real vault account loads a snapshot with its host — the boundary dogfood", () => {
  const host = registryVaultHost("deepseek");
  const snap = loadAccountSnapshot(resolveDataDir(), host, "merezarezaei@gmail.com");
  assert.ok(snap, `real vault identity must load a snapshot at ${host}`);
  assert.equal(snap!.host, host);
});

test("GOAL8(c): every real /capability/<site> runner validates the account BEFORE any browser opens", () => {
  // The 12 browser-touching routed runners (wave 8.1 wiring). For each, the
  // resolveCapabilityAccount guard must appear BEFORE the pool browser is
  // reached within its route block — so a bogus account throws before Chrome,
  // and the catch maps that throw to a 400.
  const realSites = [
    "gemini", "kimi", "hunyuan", "venice", "deepseek", "tencent-aistudio",
    "claude", "chatgpt", "copilot", "huggingchat", "youtube", "araprat",
  ];
  for (const site of realSites) {
    const start = HTTP_SOURCE.indexOf(`req.url === "/capability/${site}"`);
    assert.ok(start >= 0, `${site}: no /capability/${site} dispatcher in http.ts`);
    const next = HTTP_SOURCE.indexOf(`req.url === "/capability/`, start + 1);
    const block = HTTP_SOURCE.slice(start, next >= 0 ? next : HTTP_SOURCE.length);
    const guardIdx = block.indexOf("resolveCapabilityAccount(account, profile, dataDir);");
    const browserIdx = block.indexOf("await pool.sharedBrowser();");
    assert.ok(guardIdx >= 0, `${site}: route must call resolveCapabilityAccount before browser work`);
    assert.ok(browserIdx >= 0, `${site}: route must reach pool.sharedBrowser()`);
    assert.ok(
      guardIdx < browserIdx,
      `${site}: resolveCapabilityAccount must run BEFORE pool.sharedBrowser() — an unknown account throws before any browser opens`
    );
    assert.ok(
      block.includes("{ browser: shared, dataDir, account }"),
      `${site}: runner ctor must forward the account alongside browser+dataDir`
    );
  }
  // The server catch maps the guard's throw (and unknown-site) to 400:
  assert.ok(
    HTTP_SOURCE.includes("send(res, e instanceof Error && /unknown site |no stored account /.test(e.message) ? 400 : 500"),
    "http.ts catch must map the resolveCapabilityAccount throw to a 400 (never a 500 for a bad account)"
  );
});