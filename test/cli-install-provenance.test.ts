import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { installSummaryLine } from "../src/cli.js";

/**
 * The install line no longer reports a stranger's JSON as a verified fact.
 *
 * `cmdInstall` used to print one sentence:
 *
 *   Installed <host> v<version> (<trust>) -> <dir>
 *
 * which glues together two LOCAL facts (`host`/`dir` — the install really ran and
 * really wrote there) with two THIRD-PARTY claims (`version`/`trust` are
 * `index[host].version` / `index[host].trust` read off the remote REGISTRY INDEX
 * at `src/registry/install.ts:335-336`, defaulted to the literal strings
 * `"unknown"` / `"unreviewed"` when omitted). Nothing in the install path compares
 * either value against the bytes actually fetched, so `v1.2.3 (reviewed)` was a
 * stranger asserting a version and grading its own package, rendered exactly like
 * a verified install. The repo's core red line is that nothing claimed may be
 * unverified, so the claim is still reported — labelled, by provenance, in the
 * same voice the repo uses for `unverified-candidate` (src/prompt/registry.ts:387).
 */

const CLAIM = { version: "1.2.3", trust: "reviewed" };
const DIR = "/x/capabilities/shop.test";
const REG = "https://example.invalid/registry";

describe("installSummaryLine (provenance of a registry-index claim)", () => {
  test("the version and trust are STILL reported — the operator keeps both numbers", () => {
    const out = installSummaryLine("shop.test", DIR, CLAIM, REG).join("\n");
    assert.match(out, /v1\.2\.3/, "the claimed version must survive; removing it is not the fix");
    assert.match(out, /reviewed/, "the claimed trust must survive");
    assert.match(out, /shop\.test/, "the site must be named");
    assert.match(out, new RegExp(DIR.replace(/\//g, "\\/")), "the install dir is a LOCAL fact and must stay");
  });

  test("the two claims are attributed to the registry, and marked unverified", () => {
    const out = installSummaryLine("shop.test", DIR, CLAIM, REG).join("\n");
    assert.match(out, /registry-claims-trust/, "the repo's named voice for a third-party claim");
    assert.match(out, /UNVERIFIED/, "an unverified claim must say so in words");
    assert.match(out, /third-party claim/i, "whose claim it is");
    assert.match(out, new RegExp(REG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the provenance is named, not implied");
  });

  test("regression — the bare-fact sentence can no longer be produced", () => {
    // The exact shape that presented a stranger's JSON as verified fact.
    const out = installSummaryLine("shop.test", DIR, CLAIM, REG).join("\n");
    assert.ok(
      !/Installed shop\.test v1\.2\.3 \(reviewed\)/.test(out),
      "the old one-sentence bare-fact form must be gone"
    );
    // A bare `Installed <host> v<ver> (<trust>)` in any arrangement is the defect.
    assert.ok(
      !/Installed[^\n]*\bv[\d]/.test(out),
      "no line may present a version in the same breath as the install as a verified fact"
    );
  });

  test("the install's own defaults are shown AS claims, not laundered into facts", () => {
    // installPackage returns `version: entry.version ?? "unknown"` and
    // `trust: entry.trust ?? "unreviewed"`. Those are install-side DEFAULTS for a
    // stranger's omission — they must be attributed like any other claim.
    const out = installSummaryLine("shop.test", DIR, { version: "unknown", trust: "unreviewed" }, REG).join("\n");
    assert.match(out, /vunknown/, "the default must be shown, not hidden");
    assert.match(out, /unreviewed/, "the default must be shown, not hidden");
    assert.match(out, /UNVERIFIED/);
  });

  test("a package with no registry at all still yields the same unverified framing", () => {
    // `http://none` is what the hub passes when no uplink is configured, so the
    // framing must not depend on the base looking like a real host.
    const out = installSummaryLine("shop.test", DIR, CLAIM, "http://none").join("\n");
    assert.match(out, /UNVERIFIED/);
    assert.match(out, /http:\/\/none/);
  });

  test("each output line is non-empty — a blank line would read as a verdict", () => {
    for (const line of installSummaryLine("shop.test", DIR, CLAIM, REG)) {
      assert.ok(line.trim().length > 0, `no blank lines: got ${JSON.stringify(line)}`);
    }
  });
});

/**
 * Drop TS comments before asserting on source text. The documentation for this
 * fix QUOTES the line it removes, verbatim, on purpose — so a naive substring
 * scan reads its own explanation as the defect and the pin can never go green.
 * (`test/helpers/ci-contract-scan.ts`'s `stripComments` is hash-based, for
 * YAML/shell, and handles neither the block nor the line comment form, so it
 * cannot be reused here.)
 */
function stripTsComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("cmdInstall wiring (the pure helper is actually on the print path)", () => {
  test("cmdInstall prints through installSummaryLine, and the old bare-fact literal is gone", () => {
    const cli = stripTsComments(readFileSync("src/cli.ts", "utf8"));
    assert.match(
      cli,
      /for \(const line of installSummaryLine\(host, result\.dir, result, reg\)\)/,
      "cmdInstall must route the claim through the labelled helper"
    );
    assert.ok(
      !cli.includes("`Installed ${host} v${result.version} (${result.trust})"),
      "the bare-fact install line must be deleted, not just superseded in a test"
    );
  });

  test("the claim is passed the SAME registry base the install fetched from", () => {
    const cli = readFileSync("src/cli.ts", "utf8");
    // `reg` is the resolved `--registry` / UI2API_REGISTRY_URL / DEFAULT value —
    // naming a different base would attribute the claim to the wrong stranger.
    const call = /installSummaryLine\(([^)]*)\)/.exec(cli);
    assert.ok(call, "the call must be findable");
    assert.match(call![1], /reg/, "the provenance must be the registry actually used");
  });
});
