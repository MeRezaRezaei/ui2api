// The units have ONE definition, and the documented first-time bootstrap cannot
// reintroduce a second one.
//
// THE INCIDENT. Two definitions of the ui2api systemd units shipped at once:
//
//   scripts/ops/units/ui2api-{xvfb,chrome,api}.service   the CORRECT ones.
//     ui2api-api.service runs
//         ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd
//     out of the DEPLOYED tree, which only scripts/ops/deploy.sh writes.
//
//   scripts/ops/provision-ui2api-user.sh                  had its OWN three
//     `cat > "$UNIT_DIR/ui2api-*.service" <<EOF` heredocs, and its api unit ran
//         ExecStart=/usr/bin/env npx tsx $REPO_DIR/src/cli.ts promptd
//     — the daemon executing out of a GIT CHECKOUT.
//
// docs/DEPLOY.md step 1 IS this provisioning script. So a new operator following
// the documented bootstrap SILENTLY REVERTED the service to the git-checkout
// daemon: precisely the stale-daemon failure deploy.sh exists to eliminate,
// reintroduced by the very script the docs say to run first. Two definitions of
// one unit is not redundancy — it is a coin flip, and the losing side of that
// coin is a daemon serving code nobody deployed.
//
// WHY A NEW GATE AND NOT A LINE IN AN OLD ONE. Every existing gate stayed green
// through this. test/ui2api-provisioning.test.ts did not merely miss it, it
// ASSERTED the rot was correct: it sliced the script on
// `s.indexOf("ui2api-chrome.service\" <<EOF")` and then asserted the sliced
// heredoc carried `--remote-debugging-port=$DAEMON_PORT` and
// `ExecStart` running `cli.ts promptd`. A gate that reads the duplicate as the
// subject is worse than no gate, because it is trusted and it is wrong. This
// file therefore asserts the ABSENCE of a second definition, and the property it
// gates (one source of truth) is not one any existing file was checking.
//
// ------------------------------------------------ PURE PREDICATES, ONCE-READ ---
// The design constraint that makes the mutation tests possible at all:
//
//   Every rule below is a PURE function over TEXT. It takes file CONTENT as an
//   argument and reads nothing. It never touches the filesystem, never spawns,
//   never needs root, and never depends on cwd.
//
//   The file READING happens exactly once, at module scope, into two frozen
//   maps. The real-tree assertions and the mutation assertions then call the
//   SAME pure predicate — once with the real text, once with a mutated string.
//   That is what makes a mutation test meaningful: if the predicate read the
//   filesystem, a "mutated" input could not be fed to it at all, and the
//   mutation would degenerate into editing the real file. A gate whose rules
//   can only be exercised by really breaking production is a gate that has
//   never been SEEN to fire.
//
// STATIC AND HERMETIC. No root, no systemctl, no browser, no subprocess, no
// network. It runs on CI as an ordinary node:test file and reads only the repo.
//
// WHY THE ExecStart SCOPE IS WHAT IT IS (disclosed, deliberately narrow).
// docs/TROUBLESHOOTING.md quotes an `ExecStart=` inside a post-mortem narrative:
// the `chrome-cdp.service` that pkill-ed its own Chrome in a loop. That line is
// EVIDENCE about a unit that is no longer installed — it is not a definition,
// and flagging it would be a false red that teaches the next reader to ignore
// this gate. So the ExecStart rule is anchored on a definition, not on the
// token: a definition is either a real `.service` file, or shell text that
// contains a heredoc/redirect whose body is a unit (a `[Service]` section
// carrying an `ExecStart=`). test/doc-rot-truth.test.ts contains synthetic
// `[Service]` snippets too — those are FIXTURES in a test file, and a fixture
// is not a definition either. The archives (.brain/parked-gates, dated
// verbatim/evidence) record what was true at the time; history is not an
// instruction, and a gate that fails on history is a gate that gets disabled.
//
// DISCLOSED GAP, stated rather than faked: this file cannot prove the units
// *behave* correctly, and does not try. It proves there is one definition, that
// it runs the deployed tree, and that the bootstrap cannot add a second. The
// runtime correctness of the daemon is the deploy lane's and doc-rot-truth's
// subject, not this file's.

import { test as t, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(fileURLToPath(import.meta.url), "..", "..");

/** The ONE directory a unit definition may live in. */
export const UNIT_DIR_REL = "scripts/ops/units";
/** The ONE installer that may read that directory. */
export const INSTALLER_REL = "scripts/ops/install-services.sh";
/** The script docs/DEPLOY.md step 1 tells a new operator to run first. */
export const PROVISION_REL = "scripts/ops/provision-ui2api-user.sh";
/** The three units the deploy lane installs. */
export const EXPECTED_UNITS = ["ui2api-api.service", "ui2api-chrome.service", "ui2api-xvfb.service"] as const;

/** The single permitted daemon ExecStart: the compiled deployed tree. */
export const PERMITTED_DAEMON_EXECSTART = "ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd";

// ================================================================ pure rules ===

/**
 * A `ui2api-*.service` WRITE in shell text, as `{ line, lineText, reason }`.
 *
 * Two independent shapes, because the bug has been written both ways:
 *   1. a redirect whose TARGET is a `.service` path
 *      (`cat > "$UNIT_DIR/ui2api-api.service" <<EOF`, `tee …`, `printf … > …`);
 *   2. a heredoc whose BODY is a unit — a `[Service]` section carrying an
 *      `ExecStart=` — even when the redirect target is spelled indirectly, which
 *      is what a "helpful" refactor would produce.
 *
 * `shell` (default false) says the text is SHELL, where a `#` line is a comment
 * — and a COMMENT CANNOT WRITE. This is not a softening; it is the same lesson
 * test/doc-rot-truth.test.ts's parked twin learned the hard way, and this
 * predicate was CAUGHT making exactly that mistake on its first run: the
 * explanation of the incident, which necessarily quotes the bad heredoc, was
 * read as a heredoc. A gate that flags the comment explaining the bug it exists
 * to prevent is a gate that gets its rule loosened and then deleted. So the
 * exclusion is structural (a comment is skipped before any write-shape is
 * tested) rather than an allow-list entry somebody can add the next real hit to.
 *
 * PURE: takes text, reads nothing. `shell` is a parameter, not a read.
 */
export function unitWrites(
  text: string,
  shell = false,
): { line: number; lineText: string; reason: string }[] {
  const lines = text.split("\n");
  const out: { line: number; lineText: string; reason: string }[] = [];
  // Body of the most recent heredoc, so shape 2 can be judged by its content.
  let heredocOpenLine = -1;
  let heredocBody: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    // A shell comment writes nothing and opens no heredoc. Skipped BEFORE any
    // shape test, so quoting the bug is not the bug.
    if (shell && /^\s*#/.test(lineText)) continue;
    // A redirect/tee/printf aimed at a .service path.
    if (/\.(service)\b/.test(lineText) && /(cat\s*>>?\s|tee\s|printf?\b[^|]*>\s*)/.test(lineText)) {
      out.push({ line: i + 1, lineText, reason: "writes a .service file by redirect/tee/printf" });
    }
    const open = lineText.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (open) {
      heredocOpenLine = i + 1;
      heredocBody = [];
      continue;
    }
    if (heredocOpenLine > 0 && /^\s*[A-Za-z_][A-Za-z0-9_]*\s*$/.test(lineText)) {
      // Heredoc terminator reached — judge the body we just closed.
      const body = heredocBody.join("\n");
      if (/^\s*\[Service\]\s*$/m.test(body) && /^\s*ExecStart=/m.test(body)) {
        out.push({
          line: heredocOpenLine,
          lineText: lines[heredocOpenLine - 1]!,
          reason: "heredoc body is a systemd unit ([Service] + ExecStart=)",
        });
      }
      heredocOpenLine = -1;
      heredocBody = [];
      continue;
    }
    if (heredocOpenLine > 0) heredocBody.push(lineText);
  }
  return out;
}

/**
 * Every `ExecStart=` value in a text that is a unit DEFINITION, paired with its
 * 1-based line. PURE.
 *
 * A text qualifies as a definition when it is a `.service` file OR its text
 * contains a unit heredoc. Anything else (a markdown narrative quoting an
 * ExecStart, a test fixture building a synthetic snippet) yields nothing — see
 * the scope note in the header for why that is correct rather than convenient.
 */
export function definitionExecStarts(rel: string, text: string): { line: number; value: string }[] {
  const isUnitFile = rel.endsWith(".service");
  const defines = isUnitFile || unitWrites(text, rel.endsWith(".sh")).some((w) => /\[Service\]/.test(text));
  if (!defines) return [];
  const out: { line: number; value: string }[] = [];
  for (const [i, lineText] of text.split("\n").entries()) {
    const m = lineText.match(/^\s*ExecStart=(.*)$/);
    if (m) out.push({ line: i + 1, value: m[1]!.trim() });
  }
  return out;
}

/**
 * `ExecStart` values that run the daemon from something other than the compiled
 * deployed tree. PURE — the whole anti-revert claim lives here.
 *
 * Two failures, both the incident:
 *   * `npx tsx` / bare `tsx` — running TypeScript sources at boot, so the
 *     service's code is whatever the checkout happens to hold;
 *   * a path that is not under the deploy target — including a git checkout
 *     named as `$REPO_DIR`, `src/cli.ts`, or any `.../ui2api/src/...`.
 */
export function badDaemonExecStarts(rel: string, text: string): { line: number; value: string; reason: string }[] {
  return definitionExecStarts(rel, text)
    .filter(({ value }) => /(?:^|[\s/])npx\s+tsx\b|(?:^|[\s/])tsx\s+src\/cli\.ts\b/.test(value))
    .map(({ line, value }) => ({
      line,
      value,
      reason: "daemon ExecStart runs TypeScript via npx tsx — the git-checkout daemon deploy.sh exists to eliminate",
    }))
    .concat(
      // promptd, served out of the checkout rather than the build output.
      definitionExecStarts(rel, text)
        .filter(({ value }) => /promptd/.test(value) && !value.includes("/opt/ui2api/dist/cli.js"))
        .map(({ line, value }) => ({
          line,
          value,
          reason: "the daemon must run the compiled /opt/ui2api/dist/cli.js, not a checkout path",
        })),
    )
    .sort((a, b) => a.line - b.line);
}

/** Does this text still contain an inline unit heredoc? PURE. */
export function hasInlineUnitHeredoc(text: string, shell = false): boolean {
  return unitWrites(text, shell).length > 0;
}

/** Does this text delegate to the shipped units dir / installer? PURE. */
export function delegatesToUnitsDir(text: string): boolean {
  return text.includes(UNIT_DIR_REL) || text.includes("install-services.sh");
}

// ============================================================== derivation =====

/** Directories whose contents are HISTORY or BUILD OUTPUT, not instructions. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "graphify-out",
  "data",
  ".brain",
  "sites",
  "dist",
  "coverage",
]);

/** Repo-relative paths, POSIX-style, walked once. */
function repoFiles(root: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const abs = join(dir, entry);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Shell + unit + docs + config files, i.e. everything that could plausibly
 * DEFINITION a unit. `.brain/` is excluded wholesale (history).
 *
 * `test/` is excluded for the same reason MUTATION C pins: a test file's job is
 * to QUOTE the bad shape in order to assert its absence, and this file's own
 * mutation fixtures do exactly that. A gate that fires on the fixture proving
 * the bug is gone is a gate whose only correct response is to be deleted. The
 * exclusion is structural (the whole directory), not a filename allow-list that
 * the next real offender could be added to.
 */
function definitionalCandidates(files: string[]): string[] {
  return files.filter(
    (f) => !f.startsWith("test/") && (/\.(sh|service|md|ts|json|ya?ml)$/.test(f) || f === "Dockerfile"),
  );
}

// Read ONCE. Everything downstream is pure.
const ALL_FILES = repoFiles();
const CANDIDATES = definitionalCandidates(ALL_FILES);
const TEXT = new Map<string, string>(CANDIDATES.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

const PROVISION = readFileSync(join(ROOT, PROVISION_REL), "utf8");
const INSTALLER = readFileSync(join(ROOT, INSTALLER_REL), "utf8");
const UNIT_TEXT = new Map<string, string>(
  EXPECTED_UNITS.map((u) => [u, readFileSync(join(ROOT, UNIT_DIR_REL, u), "utf8")]),
);

// ================================================================ rules ======

t("ONE definition only: nothing outside scripts/ops/units/ writes a ui2api unit", (ctx: TestContext) => {
  const offenders = CANDIDATES.flatMap((f) =>
    unitWrites(TEXT.get(f)!, f.endsWith(".sh"))
      .filter((w) => /\bui2api-\S*\.service\b/.test(w.lineText) || /heredoc body is a systemd unit/.test(w.reason))
      .map((w) => `${f}:${w.line} (${w.reason}): ${w.lineText.trim()}`),
  );
  ctx.diagnostic(
    `unit-write scan: ${CANDIDATES.length} candidate files read; ${EXPECTED_UNITS.length} unit files in ${UNIT_DIR_REL}`,
  );
  // Non-vacuity: a scan that stopped matching is a silent pass, so the walker
  // and the reader are both proven to still be working.
  assert.ok(CANDIDATES.length > 100, `non-vacuity: expected >100 definitional candidates, read ${CANDIDATES.length}`);
  assert.ok(
    existsSync(join(ROOT, PROVISION_REL)),
    "non-vacuity: the provisioning script is in the scanned set",
  );
  assert.deepEqual(
    offenders,
    [],
    `a second definition of a ui2api unit exists outside ${UNIT_DIR_REL}:\n  ${offenders.join("\n  ")}`,
  );
});

t("the three shipped units exist, and install-services.sh installs from that directory", (ctx: TestContext) => {
  const onDisk = existsSync(join(ROOT, UNIT_DIR_REL))
    ? readdirSync(join(ROOT, UNIT_DIR_REL))
        .filter((f) => f.endsWith(".service"))
        .sort()
    : [];
  ctx.diagnostic(`units on disk: ${onDisk.join(" ")}`);
  assert.deepEqual(
    onDisk,
    [...EXPECTED_UNITS],
    `${UNIT_DIR_REL} must hold exactly the three shipped units — a fourth joins the audit, a missing one is a broken deploy`,
  );

  // The installer must READ that dir, and must not synthesise a unit itself.
  assert.ok(
    INSTALLER.includes(UNIT_DIR_REL) || INSTALLER.includes("units"),
    `${INSTALLER_REL} must install FROM ${UNIT_DIR_REL}, not from its own text`,
  );
  assert.match(
    INSTALLER,
    /install\s+-m\s+\S+\s+"\$UNIT_SRC\/\$u\.service"\s+"\$UNIT_DIR\/\$u\.service"/,
    "the installer must copy the shipped file, not write one",
  );
  assert.ok(
    !hasInlineUnitHeredoc(INSTALLER, true),
    `${INSTALLER_REL} must not contain an inline unit heredoc either`,
  );
});

t("no git-checkout daemon: every ExecStart runs the compiled deployed tree", (ctx: TestContext) => {
  const defs = CANDIDATES.filter((f) => definitionExecStarts(f, TEXT.get(f)!).length > 0);
  const all = defs.flatMap((f) =>
    definitionExecStarts(f, TEXT.get(f)!).map((e) => ({ file: f, ...e })),
  );
  ctx.diagnostic(
    `ExecStart scan: ${all.length} ExecStart directives in ${defs.length} defining files: ` +
      all.map((e) => `${e.file}:${e.line}`).join(" "),
  );
  // Non-vacuity: the two real violations this file exists for are both SHAPES
  // that must be visible in the unmutated scan, or the scan is blind.
  assert.ok(all.length >= 3, `non-vacuity: expected >=3 ExecStart directives across the repo, found ${all.length}`);

  const bad = defs.flatMap((f) =>
    badDaemonExecStarts(f, TEXT.get(f)!).map((b) => `${f}:${b.line} (${b.reason}): ${b.value}`),
  );
  assert.deepEqual(
    bad,
    [],
    `a daemon ExecStart runs out of a git checkout instead of the deployed build:\n  ${bad.join("\n  ")}`,
  );

  // Positive control on the real tree: the permitted line is really there, so
  // the rule above is not green because it matched nothing.
  const apiExec = definitionExecStarts(`${UNIT_DIR_REL}/ui2api-api.service`, UNIT_TEXT.get("ui2api-api.service")!)
    .find((e) => /promptd/.test(e.value));
  assert.ok(apiExec, "non-vacuity: ui2api-api.service must carry a promptd ExecStart");
  assert.equal(
    PERMITTED_DAEMON_EXECSTART,
    `ExecStart=${apiExec.value}`,
    "the single permitted daemon ExecStart is the compiled /opt/ui2api/dist/cli.js",
  );
});

t("the documented bootstrap delegates to scripts/ops/units/ and writes no unit", (ctx: TestContext) => {
  ctx.diagnostic("provision script: delegation asserted, zero inline unit heredocs");
  assert.ok(
    delegatesToUnitsDir(PROVISION),
    `${PROVISION_REL} must delegate to ${UNIT_DIR_REL} (directly or via ${INSTALLER_REL})`,
  );
  const writes = unitWrites(PROVISION, true);
  assert.deepEqual(
    writes.map((w) => `${w.line}: ${w.reason}`),
    [],
    `${PROVISION_REL} must contain no inline unit heredoc / .service redirect`,
  );
  // The refusal-to-synthesise seam: if the units dir is gone, the script must
  // STOP, not quietly write its own copy — that fallback is the bug.
  assert.match(
    PROVISION,
    /refusing: no unit definitions at \$UNIT_SRC/,
    "a missing units dir must be a named refusal, never a fallback to inline units",
  );
});

// ============================================================== mutation =====
//
// ANTI-VACUITY IS THE POINT OF THIS FILE. A gate nobody has SEEN fire is a
// gate nobody has read. Each mutation below therefore does two things in order:
//   1. proves the mutation is LOAD-BEARING (`mutated !== original`, plus a
//      content/length delta) — so a mutation that silently no-ops cannot fake
//      a green; a no-op mutation fed to a predicate proves nothing about it;
//   2. feeds the mutated text through the SAME pure predicate the real-tree
//      rule above uses, and asserts it REJECTS, with the named reason visible.
//
// The two failures below are the two halves of the incident, kept apart on
// purpose: A is a DUPLICATE definition, B is a WRONG definition. A fix that
// only removed the heredoc but let the api unit keep running a checkout would
// satisfy one and fail the other, and neither test is allowed to stand in for
// the other.

/** The bad heredoc, reconstructed as it was measured on the real script. */
const MUTATION_A_HEREDOC = [
  '  cat > "$UNIT_DIR/ui2api-api.service" <<EOF',
  "[Unit]",
  "Description=ui2api API (promptd)",
  "",
  "[Service]",
  "Type=simple",
  "User=$CHROME_USER",
  "WorkingDirectory=$REPO_DIR",
  "ExecStart=/usr/bin/env npx tsx $REPO_DIR/src/cli.ts promptd",
  "Restart=on-failure",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "EOF",
].join("\n");

t("MUTATION A: a reintroduced inline unit heredoc is a load-bearing RED", (ctx: TestContext) => {
  // 1. LOAD-BEARING, asserted first. A mutation that no-ops would let every
  //    assertion below pass while proving nothing.
  const mutated = `${PROVISION}\n${MUTATION_A_HEREDOC}\n`;
  assert.notEqual(mutated, PROVISION, "the mutation must actually alter the script");
  assert.ok(
    mutated.length > PROVISION.length,
    `the mutation must add content, not just reword it (${PROVISION.length} -> ${mutated.length})`,
  );
  assert.ok(
    MUTATION_A_HEREDOC.includes("npx tsx") && MUTATION_A_HEREDOC.includes("[Service]"),
    "precondition: the mutation carries the measured bad heredoc, not a decoy",
  );

  // 2. The real predicate, on the real rule's pure function.
  const writes = unitWrites(mutated, true);
  assert.ok(writes.length > 0, "the predicate must FIND the reintroduced heredoc");
  ctx.diagnostic(`mutation A verdict: ${writes.map((w) => `line ${w.line}: ${w.reason}`).join("; ")}`);
  assert.ok(
    hasInlineUnitHeredoc(mutated, true),
    "a reintroduced inline unit heredoc must be reported — this is the rule 4 regression",
  );
  // And the reason must be the SPECIFIC one, not merely non-empty.
  assert.ok(
    writes.some((w) => /heredoc body is a systemd unit/.test(w.reason)),
    `the named reason must be visible, got ${JSON.stringify(writes.map((w) => w.reason))}`,
  );
  // Rule 2's predicate fires on it too, because the duplicate carries the bad
  // ExecStart — the two halves of the incident are the same text.
  const badExec = badDaemonExecStarts(PROVISION_REL, mutated);
  assert.ok(
    badExec.length > 0,
    "the reintroduced heredoc's daemon ExecStart must be reported as a git-checkout daemon",
  );
  ctx.diagnostic(`mutation A daemon verdict: ${badExec[0]!.reason}`);

  // 3. POSITIVE CONTROL: the real, unmutated script PASSES the same predicate.
  //    Without this the gate could be simply always-red and nobody would know.
  assert.deepEqual(
    unitWrites(PROVISION, true),
    [],
    "positive control: the shipped script must pass the same predicate the mutation fails",
  );
  assert.equal(
    hasInlineUnitHeredoc(PROVISION, true),
    false,
    "positive control: the shipped script has no inline unit heredoc",
  );
});

t("MUTATION B: a git-checkout daemon ExecStart in the shipped unit is a load-bearing RED", (ctx: TestContext) => {
  const original = UNIT_TEXT.get("ui2api-api.service")!;

  // 1. LOAD-BEARING, asserted first.
  const mutated = original.replace(
    "ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd",
    "ExecStart=/usr/bin/env npx tsx /home/me/Documents/projects/ui2api/src/cli.ts promptd",
  );
  assert.notEqual(mutated, original, "the mutation must actually alter the unit");
  assert.equal(
    mutated.length - original.length,
    "ExecStart=/usr/bin/env npx tsx /home/me/Documents/projects/ui2api/src/cli.ts promptd".length -
      "ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd".length,
    "the mutation's length delta must match the edit exactly — no silent no-op",
  );
  assert.ok(
    !mutated.includes("/opt/ui2api/dist/cli.js"),
    "precondition: the mutated unit no longer runs the deployed tree",
  );

  // 2. The real predicate, on the real rule's pure function.
  const bad = badDaemonExecStarts(`${UNIT_DIR_REL}/ui2api-api.service`, mutated);
  ctx.diagnostic(`mutation B verdict: ${bad.map((b) => `line ${b.line} (${b.reason}): ${b.value}`).join("; ")}`);
  assert.ok(
    bad.length >= 1,
    "an ExecStart running the daemon from a git checkout must be reported",
  );
  assert.ok(
    bad.some((b) => /git-checkout daemon/.test(b.reason)),
    `the named reason must be visible, got ${JSON.stringify(bad.map((b) => b.reason))}`,
  );
  // The second, independent reason must also fire: a non-deployed promptd path
  // is wrong even if the `npx tsx` spelling were changed.
  assert.ok(
    bad.some((b) => /compiled \/opt\/ui2api\/dist\/cli\.js/.test(b.reason)),
    "the deployed-tree reason must fire independently of the npx-tsx spelling",
  );
  // And the daemon must also be flagged when it is moved out of /opt WITHOUT
  // npx — the shape a "fix" that only changed the interpreter would leave.
  const movedOnly = original.replace(
    "ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd",
    "ExecStart=/usr/bin/node /home/me/src/ui2api/dist/cli.js promptd",
  );
  assert.notEqual(movedOnly, original, "the control mutation must actually alter the unit");
  assert.ok(
    badDaemonExecStarts(`${UNIT_DIR_REL}/ui2api-api.service`, movedOnly).length > 0,
    "a daemon outside the deploy target must be reported even with no npx on the line",
  );

  // 3. POSITIVE CONTROL: the REAL shipped unit passes the same predicate.
  assert.deepEqual(
    badDaemonExecStarts(`${UNIT_DIR_REL}/ui2api-api.service`, original),
    [],
    "positive control: the shipped ui2api-api.service must pass the same predicate the mutation fails",
  );
  assert.equal(
    PERMITTED_DAEMON_EXECSTART,
    "ExecStart=/usr/bin/node /opt/ui2api/dist/cli.js promptd",
    "positive control: the one permitted daemon ExecStart is the compiled deployed tree",
  );
});

t("MUTATION C: the scope is a definition, so a post-mortem quote and a fixture are not false reds", () => {
  // Both of these are REAL strings in this repo today. If the ExecStart rule
  // matched the bare token, both would go red — and a gate with false reds on
  // its own documentation is a gate that gets deleted, taking its real catches
  // with it. The scope is therefore asserted, not assumed.
  const postMortem = [
    "```",
    "/etc/systemd/system/chrome-cdp.service",
    'ExecStartPre=/bin/sh -c "/usr/bin/pkill -f \\"chrome.*remote-debugging\\" >/dev/null 2>&1 || true"',
    "ExecStart=/usr/bin/google-chrome-stable --remote-debugging-port=9222 --headless=new ...",
    "Restart=always   RestartSec=3",
    "```",
  ].join("\n");
  assert.deepEqual(
    definitionExecStarts("docs/TROUBLESHOOTING.md", postMortem),
    [],
    "a post-mortem quoting an ExecStart is EVIDENCE, not a definition",
  );

  const fixture = ["[Service]", "ExecStart=/usr/bin/node /opt/ui2api/dist/prompt/ghost.js promptd", ""].join("\n");
  assert.deepEqual(
    definitionExecStarts("test/some-other.test.ts", fixture),
    [],
    "a synthetic fixture in a test file is not a definition",
  );

  // But the SAME text inside a real unit file, or written by a heredoc, IS one —
  // that is the whole content of the distinction, so it is proven both ways.
  const asUnit = definitionExecStarts(`${UNIT_DIR_REL}/ui2api-api.service`, fixture);
  assert.equal(asUnit.length, 1, "the identical text IS a definition when it is a .service file");
  const asHeredoc = `cat > "$UNIT_DIR/ui2api-x.service" <<EOF\n${fixture}\nEOF\n`;
  assert.equal(
    definitionExecStarts("scripts/ops/some.sh", asHeredoc).length,
    1,
    "the identical text IS a definition when a heredoc writes it",
  );
});
