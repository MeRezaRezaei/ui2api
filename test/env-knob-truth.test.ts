import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** GOAL 94: every UI2API_* knob the code READS must be discoverable in the
 *  shipped docs. One direction only: a knob read in code but absent from the
 *  docs is drift; a doc line whose knob no longer exists is harmless and must
 *  not silently rewrite prose. */
const DOC_FILES = ["README.md", "AGENTS.md", "docs/ONBOARDING.md", "docs/ENGINE.md", "docs/TROUBLESHOOTING.md"];
const DOCS = DOC_FILES.filter((f) => { try { statSync(f); return true; } catch { return false; } })
  .map((f) => readFileSync(f, "utf8")).join("\n");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const p = resolve(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, acc);
    else if (/\.(ts|mjs|js)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

export function readKnobs(): Set<string> {
  const out = new Set<string>();
  for (const dir of ["src", "scripts"]) {
    let files: string[] = [];
    try { files = sourceFiles(dir); } catch { continue; }
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/UI2API_[A-Z0-9_]+/g)) out.add(m[0]);
    }
  }
  return out;
}

d("GOAL 94: every UI2API_* knob the code reads is documented", () => {
  t("no code-read knob is invisible to an operator", () => {
    const knobs = readKnobs();
    assert.ok(knobs.size >= 40, `expected to scan >=40 knobs, found ${knobs.size}`);
    const missing = [...knobs].filter((k) => !DOCS.includes(k)).sort();
    assert.deepEqual(missing, [], `these knobs are read by the code but documented nowhere: ${missing.join(" ")}`);
  });
  t("the trust-relevant knobs are documented AND flagged", () => {
    for (const k of ["UI2API_TRUST", "UI2API_TOKEN", "UI2API_ATTACH_ROOTS", "UI2API_ATTACH_MAX_BYTES"]) {
      assert.ok(DOCS.includes(k), `${k} must be documented`);
      assert.ok(DOCS.includes(k) && new RegExp(`${k}[^\\n]*trust|trust[^\\n]*${k}`, "i").test(DOCS), `${k} must be flagged as trust-relevant on its own line`);
    }
  });
  t("negative: a knob read in code but absent from the docs is reported (the pin CAN fail)", () => {
    const knobs = readKnobs();
    const invented = "UI2API_PIN_PROOF_OF_FAILURE";
    assert.ok(!knobs.has(invented) && !DOCS.includes(invented), "precondition: the scratch knob exists nowhere yet");
    const asIfRead = new Set([...knobs, invented]);
    const missing = [...asIfRead].filter((k) => !DOCS.includes(k)).sort();
    assert.deepEqual(missing, [invented], `a code-read knob absent from the docs must be reported, got ${JSON.stringify(missing)}`);
  });
});
