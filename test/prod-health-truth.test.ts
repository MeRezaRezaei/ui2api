// prod-health-truth — the gate for the PROD 2026-09-27 incident.
//
// `GET /health` answered `ok: true` as a LITERAL. With the vault owned by the
// wrong user, four `POST /prompt {"site":"kimi"}` calls failed over 23 minutes
// while /health said ok:true throughout. This gate makes that shape
// impossible to reintroduce silently:
//
//   - `ok` is DERIVED (healthOk) and false when the vault is unreadable, when
//     every account is unusable, or when zero accounts exist while the surface
//     still advertises chat models;
//   - the payload carries a `vault` block with REAL counts and the NAMED reason
//     per unusable row, read from the SAME seam /accounts uses (listAccounts →
//     verifyStoredAccount), never re-implemented;
//   - ANTI-VACUITY: a payload with no `vault` block at all is a FAILURE. A gate
//     that finds nothing because the thing it checks was deleted must not
//     report success.
//
// No live daemon, no real vault, no /opt: every case builds a temp vault root
// and hands it to the exported pure helpers, so this runs on CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  healthVaultBlock,
  healthOk,
  healthVerdict,
  HEALTH_VAULT_MAX_HOSTS,
  type HealthVaultBlock,
} from "../src/prompt/http.js";
import { listAccounts, resolveStoredAccount } from "../src/runtime/session-store.js";

type AccountSeed = {
  host: string;
  slug: string;
  identity?: string;
  /** Raw state.json text. Omit => no snapshot file at all. */
  state?: string;
  /** Omit the accounts.json index row entirely. */
  noIndexRow?: boolean;
};

const authedState = (host: string): string =>
  JSON.stringify({
    version: 1,
    host,
    origin: `https://${host}/`,
    capturedAt: new Date().toISOString(),
    cookies: [{ name: "auth_token", value: "x", domain: `.${host}` }],
    localStorage: [["user", "me"]],
    sessionStorage: [],
    indexedDB: [],
  });

/** A temp sites-dir whose `sessions/` vault holds exactly the seeded accounts. */
function makeVault(seeds: AccountSeed[]): string {
  const root = mkdtempSync(join(tmpdir(), "ui2api-health-"));
  const byHost = new Map<string, unknown[]>();
  for (const s of seeds) {
    const hostDir = join(root, "sessions", s.host);
    mkdirSync(hostDir, { recursive: true });
    let rows = byHost.get(s.host);
    if (!rows) {
      rows = [];
      byHost.set(s.host, rows);
    }
    if (!s.noIndexRow) {
      rows.push({
        slug: s.slug,
        identity: s.identity ?? `${s.slug}@example.com`,
        host: s.host,
        source: "import",
        capturedAt: new Date().toISOString(),
      });
    }
    if (s.state !== undefined) {
      const accDir = join(hostDir, s.slug);
      mkdirSync(accDir, { recursive: true });
      writeFileSync(join(accDir, "state.json"), s.state);
    }
  }
  for (const [host, rows] of byHost) {
    writeFileSync(join(root, "sessions", host, "accounts.json"), JSON.stringify({ accounts: rows }));
  }
  return root;
}

const CHAT_MODELS = 22; // what /v1/models advertises on the prod box

function assertHealthyShape(v: HealthVaultBlock): void {
  // The vault block must be PRESENT and carry real fields — an absent or
  // empty-shaped block is a silent deletion and must fail here.
  assert.equal(typeof v, "object", "vault block missing from the health payload");
  assert.notEqual(v, null, "vault block missing from the health payload");
  for (const k of ["root", "present", "hosts", "accounts", "usable", "unusable", "unusableReasons"] as const) {
    assert.ok(k in v, `vault block is missing "${k}" — the honest counts were deleted`);
  }
  assert.equal(typeof v.accounts, "number");
  assert.equal(typeof v.usable, "number");
  assert.equal(typeof v.unusable, "number");
  assert.equal(v.unusable, v.accounts - v.usable, "unusable must be accounts - usable");
  assert.ok(Array.isArray(v.unusableReasons));
}

test("MUTATION 1 (red against the old literal): ok is COMPUTED, not a literal true", () => {
  // A vault whose every account is anonymous is exactly the prod incident.
  const dir = makeVault([{ host: "kimi.ai", slug: "me", state: authedState("kimi.ai") }]);
  try {
    // Overwrite the snapshot with an ANONYMOUS one (zero cookies AND zero
    // localStorage — the class the GOAL 49 write gate refuses to create).
    writeFileSync(join(dir, "sessions", "kimi.ai", "me", "state.json"), JSON.stringify({
      version: 1,
      host: "kimi.ai",
      origin: "https://kimi.ai/",
      capturedAt: new Date().toISOString(),
      cookies: [],
      localStorage: [],
      sessionStorage: [],
      indexedDB: [],
    }));
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    assert.equal(v.accounts, 1, "the anonymous row must still be COUNTED (blind-empty is forbidden)");
    assert.equal(v.usable, 0);
    assert.equal(v.unusable, 1);
    assert.match(v.unusableReasons[0].reason, /anonymous/, "the NAMED reason must be surfaced");
    // THE GATE: with chat models advertised, zero usable accounts is ok:false.
    // A literal `ok: true` cannot express this, which is the whole defect — so
    // the assertion is made against the REAL payload builder, not a local
    // recomputation, or the mutation would survive unnoticed.
    assert.equal(healthOk(v, CHAT_MODELS), false, "health reported ok:true while every account was unusable");
    const payload = healthVerdict(v, CHAT_MODELS, 33);
    assert.equal(payload.ok, false, "the /health payload said ok:true with every account unusable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MUTATION 2 (red when the vault block is deleted): the payload must carry a vault block", () => {
  // Anti-vacuity, bound to the REAL builder the /health handler spreads into
  // its payload. If someone drops `vault` (or `counts`) from `healthVerdict`,
  // this fails — it cannot pass on absent evidence the way a hand-written
  // reconstruction would.
  const dir = makeVault([{ host: "kimi.ai", slug: "me", state: authedState("kimi.ai") }]);
  try {
    const payload = healthVerdict(healthVaultBlock(dir), CHAT_MODELS, 33);
    assert.ok("vault" in payload, "health payload has no `vault` block — the honest counts were deleted");
    assert.ok("counts" in payload, "health payload has no `counts` block — the advertised counts were deleted");
    assertHealthyShape(payload.vault as unknown as HealthVaultBlock);
    const counts = payload.counts as Record<string, number>;
    assert.equal(counts.chatModels, CHAT_MODELS);
    assert.equal(counts.registryPackages, 33);
    assert.equal(counts.vaultAccounts, 1, "counts must carry the REAL vault numbers, not zeros");
    assert.equal(counts.vaultUsable, 1);
    assert.equal(payload.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ok is false when the vault is UNREACHABLE while chat models are advertised", () => {
  const dir = makeVault([]);
  try {
    // Make the vault root unreadable the way the prod box was: the root exists
    // but this process cannot list it.
    const vaultDir = join(dir, "sessions");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "accounts.json"), "{}");
    chmodSync(vaultDir, 0o000);
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    // Root-user boxes ignore 0o000, so the honest outcome is "we could not
    // enumerate" either way: an error, or absent rows. Both must be ok:false
    // while the surface advertises chat models.
    const unreachable = v.error !== null || v.accounts === 0;
    assert.ok(unreachable, "expected an unreadable/empty vault under chmod 000");
    assert.equal(healthOk(v, CHAT_MODELS), false, "an unreadable vault must not report ok:true");
  } finally {
    try {
      chmodSync(join(dir, "sessions"), 0o755);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ok is false when the vault root is MISSING entirely while chat models are advertised", () => {
  const dir = makeVault([]);
  try {
    rmSync(join(dir, "sessions"), { recursive: true, force: true });
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    assert.equal(v.present, false);
    assert.equal(v.accounts, 0);
    // The prod shape: 33 packages / 22 models advertised, zero accounts, and
    // four failed prompts. That must be ok:false, not ok:true.
    assert.equal(healthOk(v, CHAT_MODELS), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ok is true when accounts exist and are USABLE, with real non-zero counts", () => {
  const dir = makeVault([
    { host: "kimi.ai", slug: "me", state: authedState("kimi.ai") },
    { host: "chat.deepseek.com", slug: "me", state: authedState("chat.deepseek.com") },
  ]);
  try {
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    assert.equal(v.error, null, `unexpected vault error: ${v.error}`);
    assert.equal(v.present, true);
    assert.equal(v.hosts, 2, "both host dirs must be enumerated");
    assert.equal(v.accounts, 2, "REAL counts, not zeros");
    assert.equal(v.usable, 2);
    assert.equal(v.unusable, 0);
    assert.deepEqual(v.unusableReasons, []);
    assert.equal(healthOk(v, CHAT_MODELS), true, "two usable accounts must be ok:true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mix of usable and unusable accounts is ok:true but NAMES every unusable row", () => {
  const dir = makeVault([
    { host: "kimi.ai", slug: "good", state: authedState("kimi.ai") },
    { host: "kimi.ai", slug: "unreadable", state: "{ this is not json" },
    { host: "gemini.google.com", slug: "missing" }, // index row, no snapshot
  ]);
  try {
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    assert.equal(v.accounts, 3);
    assert.equal(v.usable, 1);
    assert.equal(v.unusable, 2);
    const byslug = Object.fromEntries(v.unusableReasons.map((r) => [r.slug, r.reason]));
    assert.match(byslug.unreadable ?? "", /snapshot-unreadable/, "corrupt JSON must be NAMED unreadable");
    assert.match(byslug.missing ?? "", /snapshot-missing/, "a row with no snapshot must be NAMED missing");
    // One usable account keeps the daemon drivable, so this is NOT a fault —
    // but the unusable rows are still visible with their named reasons.
    assert.equal(healthOk(v, CHAT_MODELS), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NO FALSE ALARM: a fresh install with no accounts and no chat models is healthy", () => {
  const dir = makeVault([]);
  try {
    rmSync(join(dir, "sessions"), { recursive: true, force: true });
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    // Nothing is advertised and nothing is stored: there is nothing broken, so
    // a red /health here is the classic crying-wolf failure this rule avoids.
    assert.equal(healthOk(v, 0), true, "a bare daemon with no accounts and no models must NOT cry wolf");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the vault scan is bounded and never throws on a hostile vault root", () => {
  const dir = makeVault([{ host: "kimi.ai", slug: "me", state: authedState("kimi.ai") }]);
  try {
    // A plain FILE where a host dir is expected must be counted, not crash.
    writeFileSync(join(dir, "sessions", "not-a-dir"), "x");
    const v = healthVaultBlock(dir);
    assertHealthyShape(v);
    assert.equal(v.hosts, 1);
    assert.equal(v.skipped, 1, "the non-directory must be skipped and counted");
    assert.equal(healthOk(v, CHAT_MODELS), true);

    // A vault root that is a FILE, not a directory: ENOTDIR, a named error.
    const fileRoot = mkdtempSync(join(tmpdir(), "ui2api-health-file-"));
    writeFileSync(join(fileRoot, "sessions"), "not a dir");
    const bad = healthVaultBlock(fileRoot);
    assertHealthyShape(bad);
    assert.equal(bad.present, false);
    assert.match(bad.error ?? "", /vault-unreadable/, "ENOTDIR must be a named vault error");
    assert.equal(healthOk(bad, CHAT_MODELS), false);
    rmSync(fileRoot, { recursive: true, force: true });

    // A `listAccounts` that throws (e.g. a mid-scan EIO) must degrade to a
    // named error, never propagate out of /health.
    const hostile = healthVaultBlock(dir, {
      listAccounts: () => {
        throw new Error("EIO: simulated");
      },
    });
    assertHealthyShape(hostile);
    assert.match(hostile.error ?? "", /host-unreadable/);
    assert.equal(healthOk(hostile, CHAT_MODELS), false);

    assert.ok(HEALTH_VAULT_MAX_HOSTS > 0, "the host cap must be a real bound");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the honest seam is the one /accounts uses — the same rows and reasons", () => {
  const dir = makeVault([{ host: "kimi.ai", slug: "me", state: authedState("kimi.ai") }]);
  try {
    const v = healthVaultBlock(dir);
    const listed = listAccounts(dir, "kimi.ai");
    assert.equal(v.accounts, listed.length, "health must count exactly what /accounts lists");
    assert.equal(v.usable, listed.filter((a) => a.usable === true).length);
    // And the row the health block reports must be resolvable by the exact
    // /accounts reader — no second, divergent notion of "usable".
    const resolved = resolveStoredAccount(dir, "kimi.ai", listed[0].slug);
    assert.ok(resolved, "the row counted by health must resolve through the canonical reader");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("this gate is a REAL test file on disk (anti-vacuity, self-check)", () => {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  assert.match(src, /test\(/, "this file must assert inside real top-level test() calls");
  assert.ok(!/describe\([^)]*\)\s*\{\s*assert/.test(src), "assertions must not live in a bare describe body");
});
