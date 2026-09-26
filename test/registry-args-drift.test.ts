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

test("GOAL 139: NO manifest schema has drifted from its runner", () => {
  const report = derive();
  const drifted: string[] = [];
  for (const r of report) {
    const mf = resolve(CAP, r.site, "manifest.json");
    if (!existsSync(mf)) continue;
    const manifest = JSON.parse(readFileSync(mf, "utf8"));
    const entry = (manifest.capabilities ?? []).find(
      (c: { id?: string }) => c?.id === r.cap
    );
    if (!entry) continue;
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
  assert.deepEqual(
    drifted,
    [],
    `arg contracts drifted from the runners.\nRun: node --import tsx scripts/derive-capability-args.ts --write\n${drifted
      .slice(0, 12)
      .map((d) => `  - ${d}`)
      .join("\n")}`
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
