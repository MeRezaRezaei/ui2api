import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCapabilityReportShape, buildReport } from "../src/runtime/capability-probe.js";
import { loadCapabilities, saveCapabilities, capabilitiesPath } from "../src/runtime/session-store.js";

// GOAL 58 (2026-09-25): read-side truth gate for STORED capability
// fingerprints. The write side is gated (GOAL 49/50 refuse anonymous
// snapshots at the write seam) and the profile shapes are pinned (GOAL
// 54-57), but `GET /capabilities?site=&account=` served whatever
// loadCapabilities parsed (raw `unknown`, never throws) — a hand-edited /
// stale / partially-written file with valid JSON but the WRONG shape 200'd
// as a real fingerprint (garbage-as-truth: wrong tier, wrong
// restrictions[], TypeError for a consumer reading `.length` off a string).
// These pins prove the validator names the FIRST violation and the stored
// round-trip of a genuine report validates clean. All node-only — no
// browser, no network, tmp data-dir fixtures only.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("GOAL58(a): validator accepts a genuine buildReport round-trip and names the FIRST violation of each malformed shape", () => {
  const good = buildReport({
    site: "gemini",
    host: "gemini.google.com",
    account: "a@b.c",
    tier: { value: "free", method: "dom" },
    models: [{ id: "m1", name: "M1" }],
    modelsMethod: "dom",
    restrictions: [{ kind: "limit", matched: "rate limit" }],
    abilities: [{ id: "web", label: "Web", on: true, present: true }],
    abilitiesMethod: "dom",
  });
  assert.equal(validateCapabilityReportShape(good), null, "a genuine buildReport shape is valid");

  const cases: Array<[unknown, RegExp]> = [
    [{ site: "x", host: "h", account: "a", observedAt: "", tier: { value: null, method: "unknown" }, models: [], modelsMethod: "none", restrictions: [], ok: true }, /observedAt must be a non-empty string/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free" }, models: [], modelsMethod: "none", restrictions: [], ok: true }, /tier\.method must be one of dom\|declared\|unknown/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "bogus" }, models: [], modelsMethod: "none", restrictions: [], ok: true }, /tier\.method must be one of dom\|declared\|unknown/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: "m1", modelsMethod: "none", restrictions: [], ok: true }, /models must be an array/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [{ name: "no id" }], modelsMethod: "none", restrictions: [], ok: true }, /models\[0\]\.id must be a string/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "bogus", restrictions: [], ok: true }, /modelsMethod must be one of wire\|dom\|declared\|none/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: "nope", ok: true }, /restrictions must be an array/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: [{ kind: "limit" }], ok: true }, /restrictions\[0\] must be \{ kind: string, matched: string \}/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: [], ok: "yes" }, /ok must be a boolean/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: [], ok: true, abilities: "no" }, /abilities must be an array/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: [], ok: true, abilities: [{ id: "w" }] }, /abilities\[0\] must be \{ id, label, on, present \}/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: [], ok: true, abilities: [{ id: "w", label: "W", on: true, present: true }], abilitiesMethod: "bogus" }, /abilitiesMethod must be "dom" \| "unknown"/],
    [{ site: "x", host: "h", account: "a", observedAt: "t", tier: { value: "free", method: "dom" }, models: [], modelsMethod: "dom", restrictions: [], ok: true, reason: 42 }, /reason must be a string/],
  ];
  for (const [report, re] of cases) {
    const err = validateCapabilityReportShape(report);
    assert.ok(err !== null && re.test(err), `expected ${re} from ${JSON.stringify(report).slice(0, 80)}…, got ${err}`);
  }
  assert.match(validateCapabilityReportShape("x") ?? "", /report must be an object/);
  assert.match(validateCapabilityReportShape(null) ?? "", /report must be an object/);
  assert.match(validateCapabilityReportShape([]) ?? "", /report must be an object/);
});

test("GOAL58(b): stored round-trip — a genuine report save→load validates clean; a malformed stored file is REFUSED with the named reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "u2a-goal58-"));
  try {
    const host = "fingerprint.test.host";
    const slug = "someone-gmail-com";
    const report = buildReport({
      site: "test",
      host,
      account: "someone@gmail.com",
      tier: { value: null, method: "unknown" },
      models: [],
      modelsMethod: "none",
    });
    saveCapabilities(dir, host, slug, report);
    assert.ok(existsSync(capabilitiesPath(dir, host, slug)), "stored file written");
    const loaded = loadCapabilities(dir, host, slug);
    assert.ok(loaded, "loadCapabilities returns the stored report");
    assert.equal(validateCapabilityReportShape(loaded), null, "save→load round-trip stays valid");

    // A malformed stored file (hand-edited / stale build) is refused by the
    // validator with the FIRST named violation — the http.ts read seam uses
    // this to answer probed:false + error instead of garbage-as-truth.
    const path = capabilitiesPath(dir, host, slug);
    writeFileSync(path, JSON.stringify({ site: "test", host, account: "someone@gmail.com", observedAt: "t", tier: { value: "pro", method: "dom" }, models: [], modelsMethod: "dom", restrictions: "rate limit", ok: true }));
    assert.equal(validateCapabilityReportShape(loadCapabilities(dir, host, slug)), "restrictions must be an array");
    writeFileSync(path, JSON.stringify({ site: "test", host, account: "someone@gmail.com", observedAt: "t", tier: { value: "pro" }, models: [], modelsMethod: "dom", restrictions: [], ok: true }));
    assert.match(validateCapabilityReportShape(loadCapabilities(dir, host, slug)) ?? "", /tier\.method/);

    // loadCapabilities never throws on a corrupt file (the read seam's "never
    // throws" contract) — corrupt JSON yields null, which http.ts answers as
    // probed:false, not a crash.
    writeFileSync(path, "{ not json");
    assert.equal(loadCapabilities(dir, host, slug), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GOAL58(c): the http.ts read-back seam is wired — the validator import exists and the route refuses malformed storage", () => {
  const src = readFileSync(join(ROOT, "src", "prompt", "http.ts"), "utf8");
  assert.match(src, /validateCapabilityReportShape/, "http.ts must import + call the validator at the read-back seam");
  assert.match(src, /not a valid CapabilityReport/, "the route must answer the NAMED reason, never raw malformed storage");
  assert.match(src, /probed: false/, "the malformed-storage answer must be the honest probed:false path");
});