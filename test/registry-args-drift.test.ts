/**
 * GOAL 139 — THE DRIFT GATE.
 *
 * A declared arg contract is only better than a guess if it cannot ROT. Once
 * the packages declare their real args (derived from the runner that reads
 * them), the failure mode inverts: someone edits a runner to take a new arg, or
 * renames one, and the manifest would quietly become a lie — the exact disease
 * this work set out to kill, just relocated.
 *
 * So this test re-derives every contract from the runners and compares. It is
 * the same derivation `scripts/derive-capability-args.ts` writes, which is the
 * point: the writer and the checker cannot disagree, and `--write` is a
 * deliberate, reviewable act rather than a manual edit across 33 packages.
 *
 * A failure here means: re-run `node --import tsx scripts/derive-capability-args.ts --write`
 * and commit the result. Never hand-edit a manifest schema to make this pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CAP = resolve(ROOT, "capabilities");
const RUNNERS = resolve(ROOT, "src", "capabilities");

function derive(): { site: string; cap: string; schema: unknown; why: string }[] {
  // The script prints its report; but re-implementing the derivation here would
  // let the two drift, which is the very thing under test. So we RUN it.
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx", resolve(ROOT, "scripts", "derive-capability-args.ts"), "--json"],
    { cwd: ROOT, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }
  );
  return JSON.parse(out) as { site: string; cap: string; schema: unknown; why: string }[];
}

test("GOAL 139: every declared capability's arg contract is DERIVABLE from its runner", () => {
  const report = derive();
  assert.ok(report.length > 100, `expected the whole capability surface, got ${report.length}`);
  const underived = report.filter((r) => r.schema === null);
  assert.deepEqual(
    underived.map((u) => `${u.site}/${u.cap}: ${u.why}`),
    [],
    "every declared capability must be readable from its runner — an underived one is a guess"
  );
});

type Row = { site: string; cap: string; schema: unknown; why: string };

/**
 * The comparison the gate performs, as a PURE function over
 * (derived row, manifest-side entry or null). Splitting it out is what makes the
 * anti-vacuity half PROVABLE: the "row matches no manifest capability" case is
 * unreachable by mutating the repo (the derivation iterates the manifests, so
 * every row has a matching entry), which means an in-file self-test on a
 * synthetic row is the only honest way to prove that case fails LOUD rather
 * than being skipped. See the self-test below, which does exactly that.
 */
function compare(
  rows: Row[],
  lookup: (r: Row) => { id?: string; inputSchema?: unknown } | null
): { drifted: string[]; unresolved: string[]; compared: number } {
  const drifted: string[] = [];
  const unresolved: string[] = [];
  let compared = 0;
  for (const r of rows) {
    const entry = lookup(r);
    if (!entry) {
      // The original loop `continue`d here — a `-1` lookup silently DROPPING the
      // row, which is exactly how a drift gate goes vacuous: shrink the report
      // (or lose a package) and the gate compares less, then passes.
      unresolved.push(
        `${r.site}/${r.cap}: the derivation reported this row but no manifest capability declares that id`
      );
      continue;
    }
    compared++;
    if (entry.inputSchema === undefined) {
      drifted.push(`${r.site}/${r.cap}: manifest declares NO arg contract`);
      continue;
    }
    if (JSON.stringify(entry.inputSchema) !== JSON.stringify(r.schema)) {
      drifted.push(
        `${r.site}/${r.cap}: manifest says ${JSON.stringify(entry.inputSchema)} but the runner reads ${JSON.stringify(r.schema)}`
      );
    }
  }
  return { drifted, unresolved, compared };
}

/** The assertions the gate makes, factored so the self-test exercises the SAME ones. */
function assertNoDrift(rows: Row[], lookup: (r: Row) => { id?: string; inputSchema?: unknown } | null): void {
  const { drifted, unresolved, compared } = compare(rows, lookup);
  assert.deepEqual(
    drifted,
    [],
    `arg contracts drifted from the runners.\nRun: node --import tsx scripts/derive-capability-args.ts --write\n${drifted
      .slice(0, 12)
      .map((d) => `  - ${d}`)
      .join("\n")}`
  );
  // After the drift check, so a real drift still reads as a drift.
  assert.deepEqual(
    unresolved,
    [],
    `derivation rows that no manifest entry could be compared against — the gate would have skipped them silently.\n${unresolved
      .slice(0, 12)
      .map((d) => `  - ${d}`)
      .join("\n")}`
  );
  assert.equal(
    compared,
    rows.length,
    `only ${compared} of ${rows.length} derived rows were compared — a missing target narrowed the gate`
  );
}

test("GOAL 139: NO manifest schema has drifted from its runner", () => {
  const report = derive();
  assertNoDrift(report, (r) => {
    const mf = resolve(CAP, r.site, "manifest.json");
    if (!existsSync(mf)) return null;
    const manifest = JSON.parse(readFileSync(mf, "utf8"));
    return (
      (manifest.capabilities ?? []).find((c: { id?: string }) => c?.id === r.cap) ?? null
    );
  });
});

test("GOAL 139: the drift gate is PROVEN to FAIL on a row it cannot resolve (anti-vacuity self-test)", () => {
  const schema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
  const row: Row = { site: "kimi", cap: "kimi_web_search", schema, why: "synthetic" };

  // 1) In agreement — the gate must PASS.
  assertNoDrift([row], () => ({ id: "kimi_web_search", inputSchema: schema }));

  // 2) A real schema difference — must FAIL LOUDLY, naming both sides.
  assert.throws(
    () => assertNoDrift([row], () => ({ id: "kimi_web_search", inputSchema: { type: "object", properties: {} } })),
    /kimi\/kimi_web_search: manifest says .*but the runner reads/,
    "a schema difference must fail loudly, not pass"
  );

  // 3) THE VACUITY CASE. A `-1` lookup: the row resolves to no manifest entry.
  // Under the original `if (!entry) continue;` this compared NOTHING and passed.
  assert.throws(
    () => assertNoDrift([row], () => null),
    /no manifest capability declares that id/,
    "a row that matches no manifest entry must be a LOUD failure, never a silent skip"
  );

  // 4) The same, with a second resolvable row alongside it: the unresolvable one
  // must still be caught even though half the report resolves cleanly. The
  // `unresolved` assertion fires first (it is the one that names the row), and
  // the `compared === rows.length` assertion is the backstop that fires if the
  // unresolved list is ever bypassed — proven separately in (5).
  assert.throws(
    () =>
      assertNoDrift(
        [row, { site: "kimi", cap: "kimi_chat", schema, why: "synthetic" }],
        (r) => (r.cap === "kimi_web_search" ? { id: "kimi_web_search", inputSchema: schema } : null)
      ),
    /kimi\/kimi_chat: the derivation reported this row but no manifest capability declares that id/,
    "a partially-resolvable report must fail on the unresolved row, not quietly compare less"
  );

  // 5) The backstop, isolated: `compared` is the assertion that fires when a row
  // is dropped WITHOUT being reported as unresolved. Assert it on the raw
  // compare() output, because assertNoDrift short-circuits on (4)'s list first.
  const narrowed = compare(
    [row, { site: "kimi", cap: "kimi_chat", schema, why: "synthetic" }],
    (r) => (r.cap === "kimi_web_search" ? { id: "kimi_web_search", inputSchema: schema } : null)
  );
  assert.equal(narrowed.drifted.length, 0, "the resolvable half still agrees");
  assert.equal(narrowed.unresolved.length, 1, "the unresolvable half is named");
  assert.equal(
    narrowed.compared,
    1,
    "compare() must report how many rows it actually compared, so a narrowed slice is visible"
  );
});

test("GOAL 139: every manifest capability carries a schema the registry validator ACCEPTS", () => {
  // A schema the loader would refuse is worse than none: the tool would fall
  // back to a guess while the package LOOKS like it declares a contract.
  let checked = 0;
  for (const site of readdirSync(CAP)) {
    const mf = resolve(CAP, site, "manifest.json");
    if (!existsSync(mf)) continue;
    const manifest = JSON.parse(readFileSync(mf, "utf8"));
    for (const c of manifest.capabilities ?? []) {
      if (typeof c !== "object" || c === null || !c.inputSchema) continue;
      const s = c.inputSchema as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
        anyOf?: { required: string[] }[];
      };
      checked++;
      assert.equal(s.type, "object", `${site}/${c.id}: schema type`);
      const props = Object.keys(s.properties ?? {});
      for (const r of s.required ?? []) {
        assert.ok(props.includes(r), `${site}/${c.id}: required "${r}" is not a property`);
      }
      for (const branch of s.anyOf ?? []) {
        assert.ok(branch.required.length > 0, `${site}/${c.id}: empty anyOf branch`);
        for (const r of branch.required) {
          assert.ok(props.includes(r), `${site}/${c.id}: anyOf requires "${r}" which is not a property`);
        }
      }
    }
  }
  assert.ok(checked > 100, `expected to validate the whole surface, checked ${checked}`);
});

test("GOAL 139: the runner files the derivation depends on are the ones that exist", () => {
  // Guards the extractor's own assumption: a package with capabilities must
  // have a runner, or its contract is unverifiable and the gate above is a lie.
  const runners = new Set(
    readdirSync(RUNNERS)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""))
  );
  for (const site of readdirSync(CAP)) {
    const mf = resolve(CAP, site, "manifest.json");
    if (!existsSync(mf)) continue;
    const manifest = JSON.parse(readFileSync(mf, "utf8"));
    if (!(manifest.capabilities ?? []).length) continue;
    assert.ok(
      runners.has(site),
      `package ${site} declares capabilities but src/capabilities/${site}.ts is missing — its arg contract cannot be verified`
    );
  }
});
