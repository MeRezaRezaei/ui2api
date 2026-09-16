// Capability probe unit tests — the pure, JSON-safe logic behind capability
// reflection: restriction-marker matching, report shape, honest-unknown, and
// the model-availability decision. No browser: these are the deterministic
// parts the live probe is built on.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  matchRestrictionMarkers,
  buildReport,
  type CapabilityReport,
  type RestrictionMarker,
} from "../src/runtime/capability-probe.js";

const markers: RestrictionMarker[] = [
  { kind: "upgrade", patterns: ["upgrade to", "get gemini pro", "switch to plus"] },
  { kind: "limit", patterns: ["you've reached your limit", "rate limit reached", "too many requests"] },
  { kind: "login", patterns: ["log in to get answers", "sign in to continue"] },
];

test("matchRestrictionMarkers finds a hit by case-insensitive substring", () => {
  const hits = matchRestrictionMarkers(
    "You've reached your limit on the free plan. Upgrade to Pro to keep going.",
    markers
  );
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.kind === "upgrade"));
  assert.ok(hits.some((h) => h.kind === "limit"));
  assert.ok(hits.every((h) => h.matched.length > 0));
});

test("matchRestrictionMarkers returns [] when no marker matches", () => {
  assert.deepEqual(matchRestrictionMarkers("Gemini said hello.", markers), []);
});

test("matchRestrictionMarkers is safe on empty/odd input", () => {
  assert.deepEqual(matchRestrictionMarkers("", markers), []);
  assert.deepEqual(matchRestrictionMarkers(undefined as unknown as string, markers), []);
  assert.deepEqual(matchRestrictionMarkers("x", []), []);
});

test("buildReport carries declared fields and an ok flag", () => {
  const report = buildReport({
    site: "gemini",
    host: "gemini.google.com",
    account: "merezarezaei@gmail.com",
    tier: { value: "pro", method: "dom" },
    models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", selected: true }],
    modelsMethod: "wire",
    restrictions: [{ kind: "upgrade", matched: "upgrade to" }],
  });
  assert.equal(report.site, "gemini");
  assert.equal(report.account, "merezarezaei@gmail.com");
  assert.equal(report.modelsMethod, "wire");
  assert.equal(report.ok, true);
  assert.ok(report.observedAt);
  assert.equal(report.tier.method, "dom");
});

test("buildReport honest-unknown: nothing readable -> ok:false with reason", () => {
  const report = buildReport({
    site: "venice",
    host: "venice.ai",
    account: "x",
    tier: { value: null, method: "unknown" },
    models: [],
    modelsMethod: "none",
  });
  assert.equal(report.ok, false);
  assert.ok(report.reason);
});

test("model availability decision: present -> allowed, absent -> explicit error", async () => {
  const observed = ["gemini-2.5-pro", "gemini-2.5-flash"];
  assert.equal(observed.includes("gemini-2.5-pro"), true);
  assert.equal(observed.includes("gemini-2.5-nano"), false);
  const absent = "gemini-2.5-nano";
  const err = `model "${absent}" not available on this account (observed: [${observed.join(", ")}])`;
  assert.match(err, /not available on this account/);
  assert.match(err, /gemini-2.5-nano/);
});