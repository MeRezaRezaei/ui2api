import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";

import { buildRegistryPackages, resolveDataDir } from "../src/prompt/registry.js";
import { resolvePackagedProfile, resolveProfile } from "../src/profile/profile.js";
import { listAccounts, loadAccountSnapshot, slugifyIdentity } from "../src/runtime/session-store.js";
import { startPromptd, resolveCapabilityAccount } from "../src/prompt/http.js";
import { handleOpenAIRoutes } from "../src/prompt/openai.js";
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

/** True when the real on-box vault file exists for the host (data/sessions/ is gitignored). */
function vaultPresent(host: string): boolean {
  return existsSync(join(resolveDataDir(), "sessions", host, "accounts.json"));
}

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
  // Scoped to the /capabilities/<site> handler block: the /accounts?site=
  // installed-package fallback (GOAL 31) uses the same expression earlier in
  // the file, so both searches must anchor inside the path-form branch to keep
  // pinning THAT response object's shape.
  const pathForm = HTTP_SOURCE.indexOf("const pathCap = ");
  assert.ok(pathForm >= 0, "path-form branch must exist in http.ts");
  const sourceIdx = HTTP_SOURCE.indexOf('source: "manifest",', pathForm);
  const accountsIdx = HTTP_SOURCE.indexOf(accountsLine, pathForm);
  assert.ok(sourceIdx >= 0, "path-form branch still carries source:\"manifest\"");
  assert.ok(
    accountsIdx > sourceIdx,
    "accounts must live in the same /capabilities/<site> response object as source:\"manifest\""
  );
});

test("GOAL8(a): registry accounts field equals the vault for hosts with real on-box vaults", (t) => {
  // Real, on-box, live vault state (data/sessions/<host>/accounts.json exists).
  const realVaultHosts = [
    { site: "deepseek", host: "chat.deepseek.com", slug: "merezarezaei@gmail.com", identity: "merezarezaei@gmail.com" },
    { site: "gemini", host: "gemini.google.com", slug: "merezarezaei@gmail.com", identity: "merezarezaei@gmail.com" },
    { site: "tencent-aistudio", host: "aistudio.tencent.ai", slug: "merezarezaei@gmail.com", identity: "merezarezaei@gmail.com" },
  ] as const;
  const missingHosts = realVaultHosts.filter(({ host }) => !vaultPresent(host)).map(({ host }) => host);
  if (missingHosts.length > 0) {
    t.skip(`no real on-box vaults for: ${missingHosts.join(", ")} (data/ is gitignored — clean checkout has none)`);
    return;
  }
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

test("GOAL8(a): kimi keys the vault by www.kimi.ai (corrected profile) — accounts surfaces the real vault", (t) => {
  if (!vaultPresent("www.kimi.ai")) {
    t.skip("no vault for www.kimi.ai (data/ is gitignored — clean checkout has none)");
    return;
  }
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

test("GOAL8(c): the real vault account loads a snapshot with its host — the boundary dogfood", (t) => {
  if (!vaultPresent("chat.deepseek.com")) {
    t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none)");
    return;
  }
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
    HTTP_SOURCE.includes("send(res, e instanceof Error && /unknown site |no stored account |is installed and serves POST \\/capability\\//.test(e.message) ? 400 : 500"),
    "http.ts catch must map the resolveCapabilityAccount throw to a 400 (never a 500 for a bad account) — including the GOAL 32 installed-but-not-chat two-step error"
  );
});

// ────────────────────────────────────────────────────────────────────────────
// GOAL 29 — close the account-validation ASYMMETRY on the chat/consumer
// surfaces. POST /prompt, POST /v1/chat/completions, and the CLI
// `prompt --account` used to hand body.account straight to pool.acquire /
// ChatDriver without resolveCapabilityAccount, so an unknown account silently
// fell back to the legacy default session (answers ok:true, wrong session
// attribution) — while /capability/<site> rejects it with a 400 BEFORE any
// browser work. This section pins the SAME vault-validated 400 on both daemon
// surfaces + the CLI:
//
//   (a) GUARD PREDICATE over the REAL on-box vault: an unknown account throws
//       the exact 400-shaped message ('no stored account "<acct>" for "<host>";
//       available: [<slugs>]'); every stored slug passes; absent / "default"
//       leave the legacy default path untouched (no-op).
//   (b) WIRE, REAL DAEMON (real dataDir): unknown account on POST /prompt AND
//       POST /v1/chat/completions → 400 from the production server catch with
//       the throw's message + the real available slug list — before the pool
//       is ever asked for a worker.
//   (c) /v1 stub-pool harness with the injected validator: unknown account →
//       400 and pool.acquire NEVER called (validation-before-browser); a
//       stored slug → 200 passthrough; no account → the default path keeps
//       working (acquire called).
//   (d) CLI `ui2api prompt --site deepseek --account <unknown>` → non-zero
//       exit, stderr carries the same 'no stored account' + available list.
//
// Vault-backed cases skip when data/sessions/<host>/accounts.json is absent
// (clean checkout / CI): nothing fabricated, GOAL-20 skip-when-absent guard.
// ────────────────────────────────────────────────────────────────────────────

/** Builtin deepseek ChatSiteProfile (its url hosts the on-box vault). */
function deepseekProfile(): ChatSiteProfile {
  const p = resolveProfile("deepseek");
  assert.ok(p, "GOAL29: builtin deepseek profile must resolve");
  return p!;
}

test("GOAL29(a): resolveCapabilityAccount over the real vault — unknown throws the exact 400 message, stored slugs pass, absent/default no-op", (t) => {
  if (!vaultPresent("chat.deepseek.com")) {
    t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none)");
    return;
  }
  const host = registryVaultHost("deepseek");
  const dataDir = resolveDataDir();
  const profile = deepseekProfile();
  assert.equal(new URL(profile.url).host, host, "deepseek profile must key the vault host the registry uses");
  const stored = listAccounts(dataDir, host);
  assert.ok(stored.length >= 1, `expected a real on-box vault at ${host}`);
  const bogus = "no-such-account@example.com";
  const expected = `no stored account "${bogus}" for "${host}"; available: [${stored.map((a) => a.slug).join(", ")}]`;

  // Unknown account -> the exact 400-shaped throw (the /capability contract).
  let threw = "";
  try {
    resolveCapabilityAccount(bogus, profile, dataDir);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert.equal(threw, expected, "unknown account must throw the exact 400-shaped message");

  // Every stored slug passes (known accounts are never wrongly rejected).
  for (const a of stored) {
    assert.doesNotThrow(() => resolveCapabilityAccount(a.slug, profile, dataDir), `stored slug ${a.slug} must pass`);
    assert.doesNotThrow(() => resolveCapabilityAccount(a.identity, profile, dataDir), `stored identity ${a.identity} must pass`);
  }
  // Absent / "default" = the legacy default path, unchanged.
  assert.doesNotThrow(() => resolveCapabilityAccount(undefined, profile, dataDir));
  assert.doesNotThrow(() => resolveCapabilityAccount("default", profile, dataDir));
});

test("GOAL29(b): a real daemon rejects an unknown account with 400 on BOTH /prompt and /v1/chat/completions (before any pool work)", async (t) => {
  if (!vaultPresent("chat.deepseek.com")) {
    t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none)");
    return;
  }
  const host = registryVaultHost("deepseek");
  const dataDir = resolveDataDir();
  const stored = listAccounts(dataDir, host);
  const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir, profiles: [deepseekProfile()] });
  const base = `http://127.0.0.1:${svc.port}`;
  const bogus = "no-such-account@example.com";
  try {
    // POST /prompt — the guarded branch now throws before pool.acquire.
    const p = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ site: "deepseek", prompt: "hi", account: bogus }),
    });
    assert.equal(p.status, 400, "POST /prompt with an unknown account must be a 400, never a silent default fallback");
    const pbody = (await p.json()) as { error: string };
    assert.ok(pbody.error.includes("no stored account"), pbody.error);
    assert.ok(pbody.error.includes(`for "${host}"`), pbody.error);
    assert.match(pbody.error, /available: \[/);
    for (const a of stored) assert.ok(pbody.error.includes(a.slug), `400 must list the real stored slug ${a.slug}: ${pbody.error}`);

    // POST /v1/chat/completions — same guard through the injected validator.
    const v = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "ui2api/deepseek", messages: [{ role: "user", content: "hi" }], account: bogus }),
    });
    assert.equal(v.status, 400, "POST /v1/chat/completions with an unknown account must be a 400 via the daemon catch");
    const vbody = (await v.json()) as { error: string };
    assert.ok(vbody.error.includes("no stored account"), vbody.error);
    assert.ok(vbody.error.includes(`for "${host}"`), vbody.error);
    for (const a of stored) assert.ok(vbody.error.includes(a.slug), `v1 400 must list the real stored slug ${a.slug}: ${vbody.error}`);
  } finally {
    await svc.close();
  }
});

// A stub-pool OpenAI harness wired with the REAL injected validator (the same
// closure http.ts hands handleOpenAIRoutes) so the /v1 surface is exercised
// braintlessly and fast — the validator reads the real vault, the pool is a
// counting stub proving validation runs BEFORE any acquire.
interface StubOpenAiHarness {
  server: Server;
  port: number;
  acquires: () => number;
}

function startStubOpenAiHarness(): Promise<StubOpenAiHarness> {
  let acquires = 0;
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        await handleOpenAIRoutes(req, res, {
          pool: {
            acquire: async () => {
              acquires++;
              return { driver: { ask: async () => ({ answer: "2 + 2 = 4", chunkCount: 1, doneReason: "stop", url: "https://chat.deepseek.com/chat/1", title: "t" }) } };
            },
            release: async () => undefined,
          } as never,
          profilesById: { deepseek: deepseekProfile() } as Record<string, ChatSiteProfile>,
          validateAccount: (account, profile) => resolveCapabilityAccount(account, profile, resolveDataDir()),
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

test("GOAL29(c): /v1/chat/completions with an unknown account -> 400 BEFORE pool.acquire is ever called", async (t) => {
  if (!vaultPresent("chat.deepseek.com")) {
    t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none)");
    return;
  }
  const host = registryVaultHost("deepseek");
  const { server, port, acquires } = await startStubOpenAiHarness();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek",
        messages: [{ role: "user", content: "hi" }],
        account: "no-such-account@example.com",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes("no stored account"), body.error);
    assert.ok(body.error.includes(`for "${host}"`), body.error);
    assert.match(body.error, /available: \[/);
    assert.equal(acquires(), 0, "unknown account must be rejected BEFORE pool.acquire (never a browser)");
  } finally {
    server.close();
  }
});

test("GOAL29(c): /v1/chat/completions with a STORED account passes validation and flows to the pool (200, no 400)", async (t) => {
  if (!vaultPresent("chat.deepseek.com")) {
    t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none)");
    return;
  }
  const stored = listAccounts(resolveDataDir(), registryVaultHost("deepseek"));
  assert.ok(stored.length >= 1);
  const { server, port, acquires } = await startStubOpenAiHarness();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }], account: stored[0].slug }),
    });
    assert.equal(res.status, 200, "a stored account must pass validation (never a 400)");
    assert.ok(acquires() >= 1, "a stored account flows through to pool.acquire unchanged");
  } finally {
    server.close();
  }
});

test("GOAL29(c): /v1/chat/completions with NO account keeps the legacy default path (200, pool acquire)", async () => {
  const { server, port, acquires } = await startStubOpenAiHarness();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200, "no account must keep the old default behavior (200 pool path)");
    assert.ok(acquires() >= 1, "no account -> pool.acquire as before (default session)");
  } finally {
    server.close();
  }
});

test("GOAL29(d): CLI prompt --account with an unknown account exits non-zero with the 400-shaped error", async (t) => {
  if (!vaultPresent("chat.deepseek.com")) {
    t.skip("no vault for chat.deepseek.com (data/ is gitignored — clean checkout has none)");
    return;
  }
  const stored = listAccounts(resolveDataDir(), registryVaultHost("deepseek"));
  const out = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src", "cli.ts"), "prompt", "hi", "--site", "deepseek", "--account", "no-such-account@example.com"],
      { cwd: ROOT }
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stderr }));
  });
  assert.notEqual(out.code, 0, "unknown account on CLI prompt must exit non-zero (never silently fall back)");
  assert.ok(out.stderr.includes("no stored account"), out.stderr);
  assert.match(out.stderr, /available: \[/);
  for (const a of stored) assert.ok(out.stderr.includes(a.slug), `CLI error must list the real stored slug ${a.slug}: ${out.stderr}`);
});

// ────────────────────────────────────────────────────────────────────────────
// GOAL 31 — GET /accounts?site= serves the identity-keyed vault for installed
// capability-only packages (the SAME vault /registry + /capabilities/<site>
// serve) + the youtube packaged-url host drift (www.youtube.com in the package
// vs the real vault host youtube.com at data/sessions/youtube.com/).
//
// Before GOAL 31 /accounts resolved ONLY via the chat-profile set (idFrom →
// profilesById), so capability-only installed packages (youtube/gmail/adapta/
// araprat/chatglm/conol/doubao/tinycms) 400'd "unknown site" even when a real
// vault existed — while /registry + /capabilities/<site> already listed those
// accounts (a direct contradiction of the documented three-surface contract).
// Now: profile-first (byte-identical legacy contract), then the installed
// package via registryPackageFor (http.ts) — the exact gate the peer surfaces
// use. youtube additionally drifted: packaged profile/manifest url pinned
// https://www.youtube.com while the vault lives at youtube.com (GOAL-8 kimi
// class, precedent 207e134), so the stored account merezarezaei@gmail.com was
// invisible AND unvalidatable everywhere. Tests below run on a REAL default
// daemon with UI2API_ATTACH_PORT=1 (boot-warm connect-refused → NO browser is
// ever spawned), the GOAL 30 pattern.
// ────────────────────────────────────────────────────────────────────────────

const GOAL31_CAPABILITY_ONLY = ["youtube", "gmail", "adapta", "araprat", "chatglm", "conol", "doubao", "tinycms"];

/** Start a real default daemon (no --site allow-list) with the attach-refused warm. */
async function startGoal31Daemon() {
  const prevAttach = process.env.UI2API_ATTACH_PORT;
  process.env.UI2API_ATTACH_PORT = "1"; // nothing listens: boot-warm fails fast, no browser spawned
  try {
    const svc = await startPromptd({ port: 0, host: "127.0.0.1", dataDir: "data" });
    return {
      base: `http://127.0.0.1:${svc.port}`,
      close: () => svc.close(),
    };
  } finally {
    if (prevAttach === undefined) delete process.env.UI2API_ATTACH_PORT;
    else process.env.UI2API_ATTACH_PORT = prevAttach;
  }
}

test("GOAL31(a): /accounts?site=youtube serves the installed-package vault — youtube.com host + stored account (vault-gated)", async (t) => {
  const { base, close } = await startGoal31Daemon();
  try {
    const res = await fetch(`${base}/accounts?site=youtube`);
    const body = (await res.json()) as { site?: string; host?: string | null; accounts?: unknown[] };
    assert.equal(res.status, 200, "/accounts?site=youtube must be 200 (package fallback, never the old unknown-site 400)");
    assert.equal(body.site, "youtube");
    assert.equal(body.host, "youtube.com", "host must derive from the flipped packaged url — the vault-canonical youtube.com, not www.youtube.com");
    if (!vaultPresent("youtube.com")) {
      t.skip("no vault for youtube.com (data/ is gitignored — clean checkout has none)");
      return;
    }
    assert.ok(Array.isArray(body.accounts), "accounts must be an array");
    assert.ok(
      (body.accounts as Array<{ slug: string; identity: string }>).some(
        (a) => a.slug === "merezarezaei@gmail.com" && a.identity === "merezarezaei@gmail.com"
      ),
      "the real stored youtube account merezarezaei@gmail.com must surface (identity-keyed vault at youtube.com)"
    );
  } finally {
    await close();
  }
  t.diagnostic("real daemon exercised read-only /accounts surface (no browser launched)");
});

test("GOAL31(a): /accounts?site=nonsense keeps the 400 (neither a profile nor an installed package)", async () => {
  const { base, close } = await startGoal31Daemon();
  try {
    const res = await fetch(`${base}/accounts?site=no-such-site-xyz`);
    assert.equal(res.status, 400, "unknown site must stay a 400 (byte-identical legacy contract)");
    const body = (await res.json()) as { error?: string };
    assert.ok((body.error ?? "").includes("unknown site"), body.error);
  } finally {
    await close();
  }
});

test("GOAL31(b): three-way parity — /accounts?site=youtube == /capabilities/youtube == /registry youtube.accounts (vault-gated)", async (t) => {
  if (!vaultPresent("youtube.com")) {
    t.skip("no vault for youtube.com (data/ is gitignored — clean checkout has none)");
    return;
  }
  const { base, close } = await startGoal31Daemon();
  try {
    const acc = (await (await fetch(`${base}/accounts?site=youtube`)).json()) as { accounts: unknown[]; host: string | null };
    const cap = (await (await fetch(`${base}/capabilities/youtube`)).json()) as { accounts: unknown[]; url: string };
    const reg = (await (await fetch(`${base}/registry`)).json()) as {
      packages: Array<{ id: string; url: string; accounts?: unknown[] }>;
    };
    const regPkg = reg.packages.find((p) => p.id === "youtube");
    assert.ok(regPkg, "/registry must carry the youtube package");
    assert.equal(regPkg.url, "https://youtube.com", "/registry youtube url must show the flipped vault-canonical url");
    assert.equal(cap.url, "https://youtube.com", "/capabilities/youtube url must show the flipped url");
    assert.deepEqual(acc.accounts, cap.accounts, "/accounts and /capabilities/youtube must list the SAME accounts");
    assert.deepEqual(acc.accounts, regPkg.accounts ?? [], "/accounts and /registry youtube.accounts must list the SAME accounts");
    assert.ok((acc.accounts as unknown[]).length >= 1, "the on-box youtube vault must surface its stored account");
    assert.equal(acc.host, "youtube.com", "/accounts host stays the vault-canonical youtube.com");
    for (const a of acc.accounts as Array<{ host: string }>) {
      assert.equal(a.host, "youtube.com", "each stored account's host field must be youtube.com");
    }
  } finally {
    await close();
  }
});

test("GOAL31(c): all 8 capability-only ids resolve 200 on /accounts; chat-shaped ids keep the byte-identical profile path", async () => {
  const pkgs = buildRegistryPackages();
  const byId = new Map(pkgs.map((p) => [p.id, p]));
  const { base, close } = await startGoal31Daemon();
  try {
    // Capability-only installed packages — the GOAL 31 fallback branch.
    for (const id of GOAL31_CAPABILITY_ONLY) {
      const pkg = byId.get(id);
      assert.ok(pkg, `${id}: installed package must be present in buildRegistryPackages()`);
      const res = await fetch(`${base}/accounts?site=${id}`);
      assert.equal(res.status, 200, `/accounts?site=${id} must resolve via the installed-package fallback`);
      const body = (await res.json()) as { site: string; host: string | null; accounts: unknown[] };
      assert.equal(body.site, id);
      const expectedHost = pkg.url ? new URL(pkg.url).host : null;
      assert.equal(body.host, expectedHost, `${id}: host must derive from the packaged url (null when url-less)`);
      assert.ok(Array.isArray(body.accounts), `${id}: accounts must be an array`);
      assert.deepEqual(body.accounts, pkg.accounts ?? [], `${id}: /accounts must list the SAME accounts as the registry field`);
    }
    // url-less chatglm/tinycms pin: no url -> no host to key the vault by -> null + [].
    const gl = (await (await fetch(`${base}/accounts?site=chatglm`)).json()) as { host: string | null; accounts: unknown[] };
    assert.equal(gl.host, null, "url-less chatglm must surface host null");
    assert.deepEqual(gl.accounts, [], "url-less chatglm must surface accounts [] (never fabricated)");

    // Chat-shaped ids (builtin + packaged) keep the profile path, byte-identical.
    for (const id of ["duckduckgo", "gemini", "deepseek", "kimi"]) {
      const res = await fetch(`${base}/accounts?site=${id}`);
      assert.equal(res.status, 200, `chat-shaped ${id} must still resolve (profile path)`);
      const body = (await res.json()) as { site: string; host: string; accounts: unknown[] };
      assert.equal(body.site, id);
      assert.equal(body.host, new URL(resolveProfile(id).url).host, `${id}: host must come from the chat profile`);
      assert.ok(Array.isArray(body.accounts), `${id}: accounts must be an array`);
    }
  } finally {
    await close();
  }
});