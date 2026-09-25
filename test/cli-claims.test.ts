import { strict as assert } from "node:assert";
import { describe, it, test } from "node:test";
import { readFileSync } from "node:fs";
import { HELP_LINES, installFollowUp } from "../src/cli.js";

// --- GOAL 67 pin (a): the help block no longer advertises the REFUSED
// `ui2api package` command as a working --author invocation ---

describe("HELP_LINES (GOAL 67 claim truth)", () => {
  it("the ui2api package line carries the refusal marker + the modern path, and no line advertises a working --author invocation", () => {
    const pkgLine = HELP_LINES.find((l) => l.includes("ui2api package"));
    assert.ok(pkgLine, "help must still list ui2api package");
    assert.match(pkgLine!, /REFUSED/);
    assert.match(pkgLine!, /DEAD metadata\+action-map pair/);
    assert.match(pkgLine!, /capabilities\/<id>\//);
    // No line instructs running the command with the old working flags:
    for (const l of HELP_LINES) {
      assert.ok(
        !l.includes("ui2api package") || !l.includes("--author"),
        `line must not advertise a working --author package invocation: ${l}`
      );
    }
  });

  it("regression — install/requirements/smoke lines still present with their documented flags", () => {
    const join = HELP_LINES.join("\n");
    assert.match(join, /ui2api install  <host>  \[--registry URL\] \[--out DIR\]/);
    assert.match(join, /ui2api install  --catalog/);
    assert.match(join, /ui2api requirements \[site\].*--json/);
    assert.match(join, /ui2api smoke.*\[--json = \{ok, site, answer\?, ms\?, message, installedAnon\?, report\}\]/);
    assert.match(join, /ui2api promptd.*POST \/prompt/);
  });

  it("the help block is byte-stable through console.log-per-line (title keeps its blank line)", () => {
    assert.equal(HELP_LINES[0], "UI2API — turn any website into MCP tools for AI\n");
    assert.equal(HELP_LINES[1], "  ui2api analyse  <url>   [--root App] [--out DIR] [--llm] [--max-tasks N] [--login] [--cookies FILE]");
  });
});

// --- GOAL 67 pins (c)+(d): installFollowUp verdicts ---

describe("installFollowUp (GOAL 67 claim truth)", () => {
  it("default install names the RESOLVED daemon root and prints the promptd + registry lines", () => {
    const lines = installFollowUp("/x/capabilities/duckduckgo", "/x/capabilities", {
      outOverride: false,
      registryBase: "localhost:9797",
    });
    assert.ok(lines.some((l) => l.includes("serves installed capability packages from /x/capabilities")));
    assert.ok(lines.includes("  ui2api promptd"));
    assert.ok(lines.includes("  curl -s localhost:9797/registry"));
    // The old placeholder-string fabrication is gone:
    assert.ok(!lines.some((l) => l.includes("defaultPackagesRoot)")));
  });

  it("--out install is honestly isolated — both dirs named, NOT verdict, no promptd/registry lines", () => {
    const lines = installFollowUp("/tmp/iso/duckduckgo", "/x/capabilities", {
      outOverride: true,
      registryBase: "localhost:9797",
    });
    assert.ok(lines.some((l) => l.includes("/x/capabilities, NOT /tmp/iso/duckduckgo")));
    assert.ok(lines.some((l) => l.includes("isolated")));
    assert.ok(lines.some((l) => l.includes("install without --out")));
    for (const l of lines) {
      assert.ok(!l.includes("ui2api promptd"), `--out case must not print the daemon lines: ${l}`);
      assert.ok(!l.includes("/registry"), `--out case must not print the registry curl line: ${l}`);
    }
  });
});

// --- source anchor: cmdInstall wires the pure verdict through the real dirs ---

test("cli anchors — cmdInstall passes (result.dir, defaultPackagesRoot(), outOverride) (GOAL 67)", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  assert.match(cli, /const daemonRoot = defaultPackagesRoot\(\);/);
  assert.match(cli, /const root = flags\.out \?\? daemonRoot;/);
  assert.match(cli, /installFollowUp\(result\.dir, daemonRoot, \{\s*\n\s*outOverride: flags\.out !== undefined,/);
  // The dead "package dir = defaultPackagesRoot" placeholder is gone from the install print:
  assert.ok(!cli.includes("package dir = defaultPackagesRoot"));
});