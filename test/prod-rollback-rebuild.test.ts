import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * GOAL: the rollback path of `scripts/ops/deploy.sh` must REBUILD the previous
 * release, not merely copy it back.
 *
 * The rollback point is a BARE SOURCE TREE by construction: the preserve rsync
 * excludes `dist/` and `node_modules/` (the same excludes the stage rsync
 * uses). So a copy-only restore produces a tree with no `node_modules/` and no
 * `dist/cli.js`, and the restart it immediately performs would launch a service
 * that cannot start. "Restored, still broken" is the worst outcome a rollback
 * can have: it looks like recovery, so the operator believes the service is
 * back. A rollback that does not run the same `npm ci` + `npm run build` the
 * stage path runs is not a rollback, it is a second outage with better logs.
 *
 * This gate is PURE STATIC TEXT analysis of deploy.sh — no systemd, no root, no
 * /opt, no real deploy — so it runs on CI. It pins, against the real shipped
 * file:
 *   - the restore path BUILDS, exactly once, as the SERVICE USER, and BEFORE
 *     anything is pointed at the restored tree;
 *   - the rebuild is what makes the restore usable at all: the artifact
 *     (`dist/cli.js`) is asserted AFTER the build, and the premise that the
 *     rollback point carries no `dist/`/`node_modules/` is pinned too, so the
 *     reasoning cannot rot into a myth;
 *   - the rebuild is BOUNDED (a real timeout value, plus a kill grace), and a
 *     timeout (124/137) is DISTINGUISHED from a plain build failure;
 *   - the exit code is CAPTURED with `|| rc=$?` — under `set -e` a bare
 *     `rc=$?` on the following line would abort the script before the code
 *     could be read, silently turning a reportable failure into a dead script;
 *   - a failed or killed rebuild `return 1`s (structurally, per branch) so a
 *     half-built tree is never restarted, and says so loudly;
 *   - the restore cannot re-enter itself: no loop, no self-call, no re-exec;
 *   - every rsync — PRESERVE, RESTORE and STAGE, each classified by its own
 *     source/destination, not by ordinal position — excludes `data/` AND is
 *     followed by a `$.../data` absence assertion BEFORE the next build, on
 *     every path;
 *   - a failed deploy still exits NONZERO.
 *
 * Every guarantee is proven by a MUTATION RED: mutate the real text, assert the
 * checker then REFUSES it. A gate that cannot go red is a gate nobody reads.
 *
 * ── WHY THIS FILE WAS REWRITTEN INSTEAD OF RESTORED ────────────────────────
 * The previous version of this gate scored 8 pass / 3 fail for a reason that
 * had nothing to do with deploy.sh:
 *   * its expectations were MISMAPPED. Deleting the restore build was caught
 *     (by `restore-rebuilds`, `restore-build-bounded`, …) but the test demanded
 *     one specific gate, `build-asserts-vault-both-sides`, that the mutation
 *     does not reach;
 *   * one mutation ("restore stops asserting the vault is absent") was caught
 *     by an unrelated guard, because the old per-rsync window was too WIDE —
 *     it ran from the end of the copy to the NEXT rsync, so the post-BUILD
 *     assertion silently satisfied the pre-build requirement;
 *   * one mutation ("failed rebuild restarts a half-built tree") was a NO-OP:
 *     the old `failed-rebuild-refuses-restart` only asked whether *some*
 *     `return 1` existed before the restart, which the three other failure
 *     branches already satisfied, so the mutant passed WITHOUT ever exercising
 *     anything.
 * A no-op mutation is worse than no mutation: it manufactures confidence in a
 * check that does not exist. So this file is built to make that class
 * impossible:
 *   - every mutation is applied through `replaceOnce`, which REFUSES to run
 *     unless its target appears EXACTLY ONCE in the real text. A mutation that
 *     matches nothing, or matches ambiguously, fails the test instead of
 *     passing it;
 *   - every mutation test additionally asserts the mutant differs from the
 *     real text AND no longer contains the literal it was supposed to destroy;
 *   - the failure branches are matched STRUCTURALLY (per `if` block), never by
 *     "does a `return 1` exist somewhere".
 *
 * NOTE the run-a-single-mutation escape hatch, so every red can be shown with
 * real output:
 *     ROLLBACK_MUTATION='restore build deleted' node --import tsx --test test/prod-rollback-rebuild.test.ts
 */

const DEPLOY_SH = fileURLToPath(new URL("../scripts/ops/deploy.sh", import.meta.url));
const realText = readFileSync(DEPLOY_SH, "utf8");

type Violation = { id: string; why: string };

// ── structure extractors ────────────────────────────────────────────────────

/** The `rollback() { ... }` function body — the restore path, in isolation. */
function rollbackBody(text: string): string {
  return text.match(/^rollback\(\) \{[\s\S]*?^\}/m)?.[0] ?? "";
}

/**
 * Every `if …; then … fi` block inside the restore body, with its text.
 *
 * Structural on purpose. The previous gate asked "is there a `return 1`
 * anywhere before the restart?", which the three UNRELATED failure branches
 * (move-aside, rsync, vault-absence) already satisfied — so a mutation that
 * deleted the failed-rebuild `return 1` still passed. This returns the actual
 * blocks, so a loud FAILED/REFUSED branch can be required to `return 1` on its
 * own.
 */
function ifBlocks(body: string): { start: number; end: number; text: string }[] {
  const lines = body.split("\n");
  const offsetAt: number[] = [];
  let off = 0;
  for (const line of lines) {
    offsetAt.push(off);
    off += line.length + 1;
  }
  const out: { start: number; end: number; text: string }[] = [];
  const open: number[] = [];
  for (const [i, line] of lines.entries()) {
    if (/^ {2}if\b/.test(line)) open.push(i);
    if (/^ {2}fi\s*$/.test(line) && open.length > 0) {
      const s = open.pop() as number;
      out.push({ start: offsetAt[s], end: offsetAt[i] + line.length, text: lines.slice(s, i + 1).join("\n") });
    }
  }
  return out;
}

/**
 * The body with shell COMMENTS removed, quotes respected.
 *
 * This is load-bearing, not cosmetic. `deploy.sh` documents the `|| rc=$?`
 * trap in a comment that CONTAINS the literal `|| rc=$?`. A gate that greps the
 * raw text is therefore satisfied by its own documentation: deleting the
 * command's `|| rc=$?` while leaving the comment — exactly the bug the pin
 * exists to catch — would still pass. Every gate about a command FORM is
 * evaluated against this.
 */
function stripComments(src: string): string {
  const out: string[] = [];
  for (const line of src.split("\n")) {
    let q: '"' | "'" | null = null;
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c as '"' | "'";
      else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        cut = i;
        break;
      }
    }
    out.push(cut < 0 ? line : line.slice(0, cut));
  }
  return out.join("\n");
}

/** The build invocation itself (`npm ci … && npm run build`), by offset. */
function buildInvocations(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  const re = /npm ci --no-audit --no-fund && npm run build/g;
  for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

/** The vault-absence assertions: `[[ -e "<something>/data" ]]`. */
function vaultAssertions(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /\[\[ -e "\$[A-Z_]+\/data" \]\]/g;
  for (const m of text.matchAll(re)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

type RsyncKind = "preserve" | "restore" | "stage" | "unknown";
type Rsync = { kind: RsyncKind; start: number; end: number; text: string };

/**
 * Every rsync, taken LINE BY LINE and CLASSIFIED BY WHAT IT COPIES — not by its
 * ordinal position in the file. The previous gate named its expectations
 * `rsync-2-asserts-vault-absent`, which silently re-points itself if anyone
 * adds or reorders a copy; here the same guarantee is asserted under a name
 * that cannot move (`rsync-restore-…`, `rsync-stage-…`, `rsync-preserve-…`).
 *
 * Line-based rather than regex-to-`; then` on purpose: a regex that runs past
 * the end of the command swallows the very assertions that follow it, which
 * makes the per-rsync audit report a violation on the CORRECT text.
 */
function rsyncs(text: string): Rsync[] {
  const out: Rsync[] = [];
  const lines = text.split("\n");
  const offsetAt: number[] = [];
  let off = 0;
  for (const line of lines) {
    offsetAt.push(off);
    off += line.length + 1;
  }
  for (let [i, line] of lines.entries()) {
    if (!/^\s*(if ! )?rsync -a/.test(line)) continue;
    const cmd: string[] = [line];
    let j = i;
    while (cmd[cmd.length - 1].trimEnd().endsWith("\\") && j + 1 < lines.length) cmd.push(lines[++j]);
    const text0 = cmd.join("\n");
    const kind: RsyncKind = text0.includes('"$REPO_DIR/"')
      ? "stage"
      : text0.includes('"$ROLLBACK_DIR/"')
        ? "restore"
        : text0.includes('"$ROLLBACK_TMP/"')
          ? "preserve"
          : "unknown";
    out.push({ kind, start: offsetAt[i], end: offsetAt[j] + lines[j].length, text: text0 });
    i = j;
  }
  return out;
}

/**
 * The window in which a given rsync's own vault-absence assertion must appear:
 * from the end of that copy to the FIRST of {the next copy, the next build}.
 *
 * The upper bound is what makes the pin real. The previous version's window ran
 * to the next rsync, which meant the restore's POST-BUILD assertion
 * (`rollback rebuild` → `[[ -e "$TARGET_DIR/data" ]]`) silently satisfied the
 * requirement that the copy itself be asserted clean — so deleting the
 * post-copy assertion was a mutation that could not go red. A copy is only
 * proven clean by an assertion that runs before anything else touches the tree.
 */
function postWindow(text: string, all: Rsync[], r: Rsync): string {
  const from = r.end;
  let to = text.length;
  for (const other of all) if (other.start > r.end && other.start < to) to = other.start;
  for (const b of buildInvocations(text)) if (b.start > r.end && b.start < to) to = b.start;
  return text.slice(from, to);
}

// ── the gates ──────────────────────────────────────────────────────────────

/** Every gate the real deploy.sh must satisfy. Returns [] when clean. */
function checkDeploy(text: string): Violation[] {
  const v: Violation[] = [];
  const has = (re: RegExp) => re.test(text);
  const need = (id: string, why: string, ok: boolean) => {
    if (!ok) v.push({ id, why });
  };

  const body = rollbackBody(text);
  need("rollback-body-found", "the `rollback()` function body could not be located", body.length > 0);
  if (!body) return v;

  // Every STRUCTURAL gate reads the comment-stripped body: a comment that
  // quotes the very command form a gate requires must never satisfy it, or the
  // gate documents the property instead of enforcing it.
  const code = stripComments(body);
  const all = rsyncs(text);
  const blocks = ifBlocks(code);
  const buildAt = code.indexOf("&& npm run build");
  const restartAt = code.indexOf("systemctl restart");

  // ── 1. the restore BUILDS, once, as the service user, before it is used ───
  need(
    "restore-rebuilds",
    "the restore path does NOT build — it copies the bare source tree (which has no node_modules/ and no dist/, because the preserve rsync excludes both) and restarts a service that cannot start",
    buildAt >= 0
  );
  need(
    "restore-build-exactly-once",
    "the restore does not run its rebuild exactly once (a second rebuild is a restore that can loop; zero is a copy-only restore)",
    buildInvocations(code).length === 1
  );
  need(
    "restore-build-runs-as-service-user",
    "the restore build does not run as $CHROME_USER (the stage path builds as the service user; a root-owned node_modules breaks the service)",
    /sudo -u "\$CHROME_USER" -H bash -lc/.test(code)
  );
  need(
    "restore-build-before-restart",
    "the restore does not build before the restart (a restart on an unbuilt tree is the exact bug)",
    buildAt >= 0 && restartAt >= 0 && buildAt < restartAt
  );

  // ── 2. the rebuild is what makes the restore usable at all ────────────────
  // The PREMISE, pinned so the reasoning stays honest rather than rotting: the
  // rollback point carries no dist/ and no node_modules/, which is exactly why
  // the restore has to build. If a future change starts PRESERVING dist/, the
  // rebuild is still correct but this premise would no longer be the reason.
  const preserve = all.find((r) => r.kind === "preserve");
  need(
    "restore-preserve-excludes-build-outputs",
    "the PRESERVE rsync no longer excludes node_modules/ and dist/ — either the rollback point is no longer a bare source tree (so the restore's rebuild premise changed), or the rollback point carries machine-specific build output",
    !!preserve && /--exclude 'node_modules\//.test(preserve.text) && /--exclude 'dist\//.test(preserve.text)
  );
  const distAt = code.indexOf('[[ ! -f "$TARGET_DIR/dist/cli.js" ]]');
  need(
    "restore-build-asserts-artifact",
    "the restore rebuild is not asserted to have produced dist/cli.js AFTER the build (a tree with no dist/cli.js cannot be served)",
    buildAt >= 0 && distAt > buildAt
  );

  // ── 3. the rebuild is BOUNDED, and a timeout is its own outcome ──────────
  need(
    "restore-build-bounded",
    "the restore rebuild has no time bound — a hung `npm ci` would hang the rollback forever",
    /timeout -k "\$RESTORE_BUILD_KILL_GRACE" "\$RESTORE_BUILD_TIMEOUT"/.test(code)
  );
  const timeoutVal = Number(/RESTORE_BUILD_TIMEOUT=(\d+)/.exec(text)?.[1]);
  const graceVal = Number(/RESTORE_BUILD_KILL_GRACE=(\d+)/.exec(text)?.[1]);
  need(
    "restore-build-timeout-valued",
    "RESTORE_BUILD_TIMEOUT / RESTORE_BUILD_KILL_GRACE are referenced but not assigned a real, positive integer — a bound that is not a number is not a bound",
    Number.isInteger(timeoutVal) && timeoutVal > 0 && Number.isInteger(graceVal) && graceVal > 0
  );
  need(
    "restore-timeout-exit-named",
    "a killed/timed-out rebuild (exit 124/137) is not named — a timeout would read as a plain build failure",
    /-eq 124/.test(code) && /-eq 137/.test(code)
  );
  const timeoutBranch = blocks.find((b) => /-eq 124/.test(b.text))?.text ?? "";
  const failureBranch = blocks.find((b) => /"\$rc" -ne 0/.test(b.text))?.text ?? "";
  need(
    "restore-timeout-distinct-from-failure",
    "the timeout branch and the plain-failure branch are not DISTINGUISHED — a killed rebuild must be reportable as a timeout in its own right, not folded into 'build failed'",
    timeoutBranch.length > 0 &&
      failureBranch.length > 0 &&
      /timeout|timed out|killed/i.test(timeoutBranch) &&
      !/timeout|timed out|killed/i.test(failureBranch)
  );

  // ── 4. the exit code is CAPTURED, not swallowed by `set -e` ──────────────
  // Read off the comment-stripped body: deploy.sh's own explanatory comment
  // contains the literal `|| rc=$?`, so a raw-text grep is satisfied by the
  // documentation and would NOT notice the command losing it.
  need(
    "restore-build-exit-captured",
    "the restore build's exit code is not captured (`|| rc=$?`) — under `set -e` a failing build would abort the script before it could be reported",
    /\|\|\s*rc=\$\?/.test(code)
  );
  // The subtle trap, pinned separately: `rc=$?` on its OWN line is a bug, not a
  // style choice. Under `set -e` the failing build already aborted the script
  // before that line ever ran, so the rollback dies with no verdict at all.
  need(
    "restore-build-not-bare-rc",
    "the restore reads `$?` on a line of its own (`rc=$?`) instead of in the command's `|| rc=$?` — under `set -e` the script aborts before that line, and the rebuild failure is never reported",
    !/^[ \t]*rc=\$\?[ \t]*$/m.test(code)
  );

  // ── 5. a failed/killed rebuild never restarts a half-built tree ───────────
  // STRUCTURAL, per branch: a loud FAILED/REFUSED branch must `return 1`
  // itself. The previous gate asked only whether SOME `return 1` preceded the
  // restart, which the move-aside / rsync / vault branches already satisfied —
  // so deleting the failed-rebuild `return 1` was a no-op mutation.
  const loudFailureBranches = blocks.filter((b) => /ROLLBACK (FAILED|REFUSED TO FINISH):/.test(b.text));
  need(
    "failed-rebuild-returns-1",
    "a branch that announces ROLLBACK FAILED / REFUSED TO FINISH does not `return 1` — the restore would carry on and restart a half-built tree",
    loudFailureBranches.length > 0 && loudFailureBranches.every((b) => /return 1\b/.test(b.text))
  );
  need(
    "failed-rebuild-is-loud",
    "a rebuild-failure branch does not announce itself on stderr (`loud \"ROLLBACK FAILED:`) — a rollback that fails quietly is a rollback nobody reads",
    /loud "ROLLBACK FAILED:/.test(timeoutBranch) && /loud "ROLLBACK FAILED:/.test(failureBranch)
  );
  need(
    "failed-rebuild-says-not-restarting",
    "the failed/timed-out rebuild branches do not say, loudly, that a half-built tree is NOT being restarted",
    /NOT restarting a half-built tree/.test(timeoutBranch) && /NOT restarting a half-built tree/.test(failureBranch)
  );

  // ── 6. the restore CANNOT re-enter itself ────────────────────────────────
  need(
    "restore-no-loop",
    "the restore contains a loop construct — a restore that can loop is an outage that never ends",
    !/(^[ \t]*(for|while|until)\b)|(\bseq 1\b)|(\$\(\([^)]*\+\+[^)]*\)\))/m.test(code)
  );
  need(
    "restore-no-self-call",
    "the restore calls `rollback` from inside itself — the restore CAN re-enter itself",
    !/\brollback\s+"/.test(code) && !/rollback\s*\$/.test(code)
  );
  need(
    "restore-no-self-exec",
    "the restore re-executes deploy.sh (or any script) from inside itself — the restore CAN re-enter itself",
    !/(bash|sh|source|\.)\s+"?\$\{?(BASH_SOURCE|0)/.test(code) && !/\bexec\b/.test(code)
  );

  // ── 7. a failure still exits NONZERO (nothing weakened) ───────────────────
  need("set-euo-pipefail", "the `set -euo pipefail` guard is gone", has(/set -euo pipefail/));
  need("fail-exits-nonzero", "`fail()` must still exit nonzero", has(/fail\(\)\s*\{[^}]*exit 1/));
  need(
    "stage-build-gates-restart",
    "the stage build must still gate the restart (`dist/cli.js` assertion + a fail)",
    has(/\[\[ -f "\$TARGET_DIR\/dist\/cli\.js" \]\]\s*\|\| fail/)
  );
  const healthFailBranch = text.match(/if \[\[ "\$ok" -ne 1 \]\]; then[\s\S]*?\n {2}fi\n/)?.[0] ?? "";
  need(
    "health-failure-rolls-back",
    "a health failure does not roll back to the DEFINED rollback()",
    /rollback\(\)\s*\{/.test(text) && /rollback "/.test(healthFailBranch)
  );
  need(
    "health-failure-exits-nonzero",
    "a health failure does not exit nonzero (a green pipeline with a dead service)",
    /fail "/.test(healthFailBranch)
  );

  // ── 8. EVERY copy excludes the vault AND asserts its absence ─────────────
  // Per CLASSIFIED copy, so the guarantee cannot slide onto a different rsync.
  const allVaultForms = (r: Rsync) => /--exclude 'data\/'/.test(r.text) && /--exclude '\/data'/.test(r.text);
  need("rsyncs-found", "expected the PRESERVE, RESTORE and STAGE rsyncs, found none", all.length >= 3);
  for (const kind of ["preserve", "restore", "stage"] as const) {
    const r = all.find((x) => x.kind === kind);
    need(`rsync-${kind}-found`, `no rsync could be classified as the ${kind.toUpperCase()} copy`, !!r);
    if (!r) continue;
    need(
      `rsync-${kind}-excludes-vault`,
      `the ${kind.toUpperCase()} rsync does not exclude BOTH forms of \`data/\` (a copy that could carry the captured-session vault into a tree the service reads)`,
      allVaultForms(r)
    );
    need(
      `rsync-${kind}-asserts-vault-absent`,
      `the ${kind.toUpperCase()} rsync is not followed by a \`$.../data\` absence assertion BEFORE the next build — an exclusion nobody checks is an exclusion nobody proved`,
      /\[\[ -e "\$[A-Z_]+\/data" \]\]/.test(postWindow(text, all, r))
    );
  }
  need(
    "rsyncs-classified",
    "an rsync could not be classified (preserve / restore / stage) — an unaudited copy is a copy whose vault handling is unknown",
    all.every((r) => r.kind !== "unknown")
  );
  // Backstop: a vault assertion guarded by a disabled condition reads like a
  // check and checks nothing.
  need(
    "vault-assertions-not-neutered",
    "a `$.../data` absence assertion is guarded by a disabled condition (`if false; then`) — it reads like a check and checks nothing",
    !/if false; then[\s\S]{0,200}?ROLLBACK (REFUSED|FAILED)/.test(text) && !/if false; then\n {2}fail "\$TARGET_DIR\/data/.test(text)
  );

  // ── 9. every BUILD is bracketed by a vault assertion ─────────────────────
  // `npm ci` is the one step in either path that writes into the tree from the
  // network. An exclusion proves the COPY was clean; it does NOT prove the
  // install left nothing behind. So each build is audited on both sides.
  // Offsets are taken from the comment-stripped file, so a build that only
  // appears inside a comment cannot be counted as a real, bracketed build.
  const stripped = stripComments(text);
  const builds = buildInvocations(stripped);
  const asserts = vaultAssertions(stripped);
  need("build-count", "expected BOTH the restore rebuild and the stage build, and found a different number", builds.length >= 2);
  // NEAREST bracket, not ANY bracket. With "any" the assertion is satisfied by
  // a LATER one belonging to a different path — deleting the restore's own
  // post-build assertion was satisfied by the STAGE path's assertion, so the
  // mutation could not go red. The trailing assertion must also land BEFORE
  // the next build, so it belongs to this build's own step.
  // The trailing assertion must also land before the next build AND before the
  // first restart that follows the build — otherwise the STAGE path's
  // post-rsync assertion, which sits past the restore's own restart, silently
  // becomes the restore rebuild's bracket.
  const restarts = [...stripped.matchAll(/systemctl restart/g)].map((m) => m.index);
  builds.forEach((b, i) => {
    const before = asserts.filter((a) => a.end <= b.start).at(-1);
    const after = asserts.find((a) => a.start >= b.end);
    const nextBuild = builds[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    const nextRestart = restarts.find((r) => r > b.start) ?? Number.POSITIVE_INFINITY;
    need(
      "build-asserts-vault-both-sides",
      "a build invocation is not bracketed by its OWN `$.../data` absence assertions (npm ci could leave a vault behind, and a later path's assertion is not a bracket for this one)",
      !!before && !!after && after.start < nextBuild && after.start < nextRestart
    );
  });

  return v;
}

function violationIds(text: string): string[] {
  return checkDeploy(text).map((x) => x.id);
}

// ── mutations ───────────────────────────────────────────────────────────────

/**
 * Apply a mutation that must hit its target EXACTLY ONCE.
 *
 * This is the anti-no-op floor the previous version lacked. A `String.replace`
 * whose pattern does not match returns the text UNCHANGED, and the test's
 * "did it change?" assertion then fires — but only after a confusing failure
 * about a different gate. Here the mutation refuses to exist at all unless it
 * is unambiguous, so "the mutation found nothing" can never be mistaken for
 * "the mutation proved nothing".
 */
function replaceOnce(text: string, from: string | RegExp, to: string, id: string): string {
  const count = typeof from === "string" ? text.split(from).length - 1 : [...text.matchAll(new RegExp(from.source, from.flags.replace("g", "") + "g"))].length;
  assert.equal(count, 1, `mutation "${id}": its target must appear EXACTLY ONCE in the real deploy.sh, found ${count}`);
  return typeof from === "string" ? text.replace(from, to) : text.replace(from, to);
}

/** The classified rsync's own text, for a mutation scoped to exactly that copy. */
function rsyncText(text: string, kind: RsyncKind, id: string): string {
  const all = rsyncs(text);
  const hit = all.filter((x) => x.kind === kind);
  assert.equal(hit.length, 1, `mutation "${id}": expected exactly one ${kind} rsync, found ${hit.length}`);
  return hit[0].text;
}

/** The post-copy window of one classified copy (bounded by the next build). */
function postWindowOf(text: string, kind: RsyncKind): string {
  const all = rsyncs(text);
  const r = all.find((x) => x.kind === kind);
  assert.ok(r, `no rsync could be classified as ${kind}`);
  return postWindow(text, all, r);
}

/** Drop BOTH forms of the `data/` exclusion from exactly one classified copy. */
function dropVaultExclude(text: string, kind: RsyncKind, id: string): string {
  const body = rsyncText(text, kind, id);
  const stripped = body.replace("--exclude 'data/' ", "").replace("--exclude '/data' ", "");
  assert.notEqual(stripped, body, `mutation "${id}": the ${kind} rsync did not carry the expected \`data/\` exclusions`);
  return text.replace(body, stripped);
}

type Mutation = {
  id: string;
  mutate: (t: string) => string;
  /**
   * PROOF THAT THE MUTATION IS LOAD-BEARING, in the strong sense: a predicate
   * that must hold of the MUTANT. Not "the text differs" — that is the weak
   * form the previous version used, and it is exactly the form that let a
   * no-op mutation pass. A scoped mutation additionally asserts the OTHER
   * copies kept their protection, so it can neither be a blanket replace nor
   * have silently hit the wrong rsync.
   */
  prove: (mutated: string) => boolean;
  /**
   * The EXACT, COMPLETE set of gate ids this mutation trips. Not aspirational,
   * and not a subset: the test asserts equality, so this table cannot rot into
   * a list of "some gate that fires" while the real behaviour drifts. A future
   * deploy.sh improvement that adds a gate a mutation trips fails loudly here
   * with the new id, and the fix is one line.
   */
  caught: string[];
};

const MUTATIONS: Mutation[] = [
  // ── anti-vacuity #1: the restore's build line is deleted ─────────────────
  {
    id: "restore build deleted (copy-only restore)",
    prove: (m) => !stripComments(rollbackBody(m)).includes("&& npm run build") && buildInvocations(stripComments(rollbackBody(m))).length === 0 && m.includes("&& npm run build"),
    mutate: (t) =>
      replaceOnce(
        t,
        '  timeout -k "$RESTORE_BUILD_KILL_GRACE" "$RESTORE_BUILD_TIMEOUT" \\\n    sudo -u "$CHROME_USER" -H bash -lc "cd \'$TARGET_DIR\' && npm ci --no-audit --no-fund && npm run build" \\\n    || rc=$?\n',
        "",
        "restore build deleted"
      ),
    caught: [
      "restore-rebuilds",
      "restore-build-exactly-once",
      "restore-build-runs-as-service-user",
      "restore-build-before-restart",
      "restore-build-asserts-artifact",
      "restore-build-bounded",
      "restore-build-exit-captured",
      "build-count",
    ],
  },
  // ── anti-vacuity #2: a `data/` exclusion is dropped ──────────────────────
  // Scoped to ONE classified copy, and `prove` asserts the OTHER copies kept
  // theirs — so this cannot degenerate into a blanket search-and-replace, and
  // cannot silently target the wrong rsync.
  {
    id: "data/ exclusion dropped from the STAGE rsync",
    prove: (m) => !rsyncText(m, "stage", "p").includes("--exclude 'data/'") && !rsyncText(m, "stage", "p").includes("--exclude '/data'") && rsyncText(m, "restore", "p").includes("--exclude 'data/'") && rsyncText(m, "preserve", "p").includes("--exclude 'data/'"),
    mutate: (t) => dropVaultExclude(t, "stage", "stage exclude dropped"),
    caught: ["rsync-stage-excludes-vault"],
  },
  {
    id: "data/ exclusion dropped from the RESTORE rsync",
    prove: (m) => !rsyncText(m, "restore", "p").includes("--exclude 'data/'") && !rsyncText(m, "restore", "p").includes("--exclude '/data'") && rsyncText(m, "stage", "p").includes("--exclude 'data/'") && rsyncText(m, "preserve", "p").includes("--exclude 'data/'"),
    mutate: (t) => dropVaultExclude(t, "restore", "restore exclude dropped"),
    caught: ["rsync-restore-excludes-vault"],
  },
  {
    id: "data/ exclusion dropped from the PRESERVE rsync",
    prove: (m) => !rsyncText(m, "preserve", "p").includes("--exclude 'data/'") && !rsyncText(m, "preserve", "p").includes("--exclude '/data'") && rsyncText(m, "stage", "p").includes("--exclude 'data/'") && rsyncText(m, "restore", "p").includes("--exclude 'data/'"),
    mutate: (t) => dropVaultExclude(t, "preserve", "preserve exclude dropped"),
    caught: ["rsync-preserve-excludes-vault"],
  },
  {
    id: "the rollback point stops excluding dist/ and node_modules/ (the restore's premise)",
    prove: (m) => !rsyncText(m, "preserve", "p").includes("--exclude 'node_modules/'") && rsyncText(m, "stage", "p").includes("--exclude 'node_modules/'"),
    mutate: (t) => {
      const body = rsyncText(t, "preserve", "preserve build outputs kept");
      return t.replace(body, body.replace("--exclude 'node_modules/' --exclude 'dist/' ", ""));
    },
    caught: ["restore-preserve-excludes-build-outputs"],
  },
  // ── anti-vacuity #3: a vault-absence assertion is neutered ───────────────
  // The OLD version of this mutation was mapped to `rsync-2-asserts-vault-absent`
  // and could NOT go red: the old per-rsync window ran to the next rsync, and
  // the restore's POST-BUILD assertion silently satisfied a requirement about
  // the COPY. The window is now bounded by the next BUILD, so the same
  // mutation is caught by the gate that actually owns the property — and by
  // its name, which (unlike `rsync-2-…`) cannot slide onto a different copy.
  {
    id: "restore stops asserting the vault is absent after the copy",
    prove: (m) => /if false; then\n {4}loud "ROLLBACK REFUSED TO FINISH: \$TARGET_DIR\/data appeared during the restore/.test(m) && !postWindowOf(m, "restore").includes('[[ -e "$TARGET_DIR/data" ]]'),
    mutate: (t) =>
      replaceOnce(
        t,
        '  if [[ -e "$TARGET_DIR/data" ]]; then\n    loud "ROLLBACK REFUSED TO FINISH: $TARGET_DIR/data appeared during the restore —',
        '  if false; then\n    loud "ROLLBACK REFUSED TO FINISH: $TARGET_DIR/data appeared during the restore —',
        "restore vault assertion neutered"
      ),
    caught: ["rsync-restore-asserts-vault-absent", "vault-assertions-not-neutered"],
  },
  {
    id: "stage stops asserting the vault is absent after the copy",
    prove: (m) => /if false; then\n {2}fail "\$TARGET_DIR\/data exists/.test(m) && !postWindowOf(m, "stage").includes('[[ -e "$TARGET_DIR/data" ]]'),
    mutate: (t) =>
      replaceOnce(
        t,
        'if [[ -e "$TARGET_DIR/data" ]]; then\n  fail "$TARGET_DIR/data exists',
        'if false; then\n  fail "$TARGET_DIR/data exists',
        "stage vault assertion neutered"
      ),
    caught: ["rsync-stage-asserts-vault-absent", "vault-assertions-not-neutered"],
  },
  {
    id: "the post-BUILD vault assertion is dropped (npm ci left unbracketed)",
    prove: (m) => !m.includes("appeared during the install/build"),
    mutate: (t) =>
      replaceOnce(
        t,
        /if \[\[ -e "\$TARGET_DIR\/data" \]\]; then\n {2}fail "\$TARGET_DIR\/data appeared during the install\/build[^\n]*\nfi\n/,
        "",
        "post-build vault assertion dropped"
      ),
    caught: ["build-asserts-vault-both-sides"],
  },
  {
    id: "the restore's post-build vault assertion is dropped (npm ci left unbracketed in the restore)",
    prove: (m) => !m.includes("appeared during the restore rebuild"),
    mutate: (t) =>
      replaceOnce(
        t,
        /  if \[\[ -e "\$TARGET_DIR\/data" \]\]; then\n    loud "ROLLBACK REFUSED TO FINISH: \$TARGET_DIR\/data appeared during the restore rebuild[^\n]*\n {4}return 1\n {2}fi\n/,
        "",
        "restore post-build vault assertion dropped"
      ),
    caught: ["build-asserts-vault-both-sides"],
  },
  // ── the rebuild's shape ──────────────────────────────────────────────────
  {
    id: "restore rebuild made unbounded (a hung npm ci hangs the rollback forever)",
    prove: (m) => !stripComments(rollbackBody(m)).includes('timeout -k "$RESTORE_BUILD_KILL_GRACE" "$RESTORE_BUILD_TIMEOUT"'),
    mutate: (t) => replaceOnce(t, /timeout -k "\$RESTORE_BUILD_KILL_GRACE" "\$RESTORE_BUILD_TIMEOUT" \\\n    sudo/, "sudo", "unbounded rebuild"),
    caught: ["restore-build-bounded"],
  },
  {
    id: "the restore build timeout is no longer a real number",
    prove: (m) => m.includes("RESTORE_BUILD_TIMEOUT=forever") && !/RESTORE_BUILD_TIMEOUT=\d+/.test(m),
    mutate: (t) => replaceOnce(t, "RESTORE_BUILD_TIMEOUT=900", "RESTORE_BUILD_TIMEOUT=forever", "timeout not a number"),
    caught: ["restore-build-timeout-valued"],
  },
  {
    id: "a timeout is no longer distinguished from a plain build failure",
    prove: (m) => !stripComments(rollbackBody(m)).includes('-eq 124') && !stripComments(rollbackBody(m)).includes('-eq 137'),
    mutate: (t) => replaceOnce(t, 'if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then', 'if [[ "$rc" -eq 0 ]]; then', "timeout branch collapsed"),
    // Collapsing the branch also makes the timeout verdict indistinguishable from
    // a plain failure, and the loud "NOT restarting" wording disappears with the
    // branch it lived in. All four are MEASURED, not guessed — the mapping is
    // asserted for exactness precisely so an under-declared entry cannot hide.
    caught: ["restore-timeout-exit-named", "restore-timeout-distinct-from-failure", "failed-rebuild-is-loud", "failed-rebuild-says-not-restarting"],
  },
  {
    id: "the timeout and the build failure report the same verdict (a kill reads as a plain failure)",
    prove: (m) => {
      const f1 = ifBlocks(stripComments(rollbackBody(m))).find((x) => /"\$rc" -ne 0/.test(x.text))?.text ?? "";
      return f1.includes("FAILED or TIMED OUT") && !f1.includes("exit or TIMED OUT");
    },
    mutate: (t) =>
      replaceOnce(
        t,
        'ROLLBACK FAILED: the restore rebuild FAILED (npm ci/build exit $rc) — the previous release is restored as SOURCE but has no working build. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."',
        'ROLLBACK FAILED: the restore rebuild FAILED or TIMED OUT (npm ci/build exit $rc) — the previous release is restored as SOURCE but has no working build. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."',
        "timeout folded into failure"
      ),
    caught: ["restore-timeout-distinct-from-failure"],
  },
  {
    id: "the exit code is read on a bare `rc=$?` line (set -e swallows the failure)",
    // The trap: under `set -e` the failing build aborts the script BEFORE the
    // next line runs, so the rollback dies with no verdict at all. Note the
    // explanatory COMMENT (which quotes `|| rc=$?`) is left in place, so this
    // mutation also proves the gate is not satisfied by documentation.
    prove: (m) => {
      const c = stripComments(rollbackBody(m));
      return /^[ \t]*rc=\$\?[ \t]*$/m.test(c) && !/\|\|\s*rc=\$\?/.test(c) && m.includes("|| rc=$?");
    },
    mutate: (t) =>
      replaceOnce(
        t,
        '    sudo -u "$CHROME_USER" -H bash -lc "cd \'$TARGET_DIR\' && npm ci --no-audit --no-fund && npm run build" \\\n    || rc=$?\n',
        '    sudo -u "$CHROME_USER" -H bash -lc "cd \'$TARGET_DIR\' && npm ci --no-audit --no-fund && npm run build"\n  rc=$?\n',
        "bare rc=$?"
      ),
    caught: ["restore-build-exit-captured", "restore-build-not-bare-rc"],
  },
  {
    id: "the restore builds as root instead of the service user",
    prove: (m) => !stripComments(rollbackBody(m)).includes('sudo -u "$CHROME_USER" -H bash -lc') && m.includes('sudo -u "$CHROME_USER" -H bash -lc'),
    mutate: (t) =>
      replaceOnce(
        t,
        '    sudo -u "$CHROME_USER" -H bash -lc "cd \'$TARGET_DIR\' && npm ci --no-audit --no-fund && npm run build"',
        '    bash -lc "cd \'$TARGET_DIR\' && npm ci --no-audit --no-fund && npm run build"',
        "root build"
      ),
    caught: ["restore-build-runs-as-service-user"],
  },
  {
    id: "the restore rebuilds twice",
    prove: (m) => buildInvocations(stripComments(rollbackBody(m))).length === 2,
    mutate: (t) => {
      const line = '    sudo -u "$CHROME_USER" -H bash -lc "cd \'$TARGET_DIR\' && npm ci --no-audit --no-fund && npm run build"';
      return replaceOnce(t, line, `${line}\n${line}`, "double rebuild");
    },
    // The second copy also has no vault assertion between it and the first, so
    // the bracket gate fires too — a rebuild that runs twice is two builds with
    // one bracket.
    caught: ["restore-build-exactly-once", "build-asserts-vault-both-sides"],
  },
  {
    id: "rebuild wrapped in a retry loop",
    prove: (m) => stripComments(rollbackBody(m)).includes("for _ in 1 2 3; do"),
    mutate: (t) =>
      replaceOnce(t, '  say "ROLLBACK: rebuilding the restored release', '  for _ in 1 2 3; do\n  say "ROLLBACK: rebuilding the restored release', "retry loop").replace(
        '  say "ROLLBACK: rebuild OK (dist/cli.js present, vault still absent)"',
        '  done\n  say "ROLLBACK: rebuild OK (dist/cli.js present, vault still absent)"'
      ),
    caught: ["restore-no-loop"],
  },
  {
    id: "failed rebuild restarts a half-built tree",
    // The old mutation of this name was a NO-OP. It removed the failed-rebuild
    // `return 1`, but the gate only asked whether SOME `return 1` existed before
    // the restart — and the move-aside, rsync and vault branches already supply
    // three. The gate is now STRUCTURAL (per `if` block), so the same edit is
    // caught by the branch that owns the property.
    prove: (m) => {
      const b = ifBlocks(stripComments(rollbackBody(m)));
      const branch = b.find((x) => /restore rebuild FAILED \(npm ci\/build exit/.test(x.text));
      return !!branch && !/return 1\b/.test(branch.text);
    },
    mutate: (t) =>
      replaceOnce(
        t,
        // anchored on the FAILED-specific prefix: BOTH rebuild-failure branches
        // end with the same two lines, so anchoring on those alone matches TWICE
        'ROLLBACK FAILED: the restore rebuild FAILED (npm ci/build exit $rc) — the previous release is restored as SOURCE but has no working build. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."\n    return 1',
        'ROLLBACK FAILED: the restore rebuild FAILED (npm ci/build exit $rc) — the previous release is restored as SOURCE but has no working build. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."',
        "failed rebuild continues"
      ),
    caught: ["failed-rebuild-returns-1"],
  },
  {
    id: "a timed-out rebuild restarts a half-built tree",
    prove: (m) => {
      const b = ifBlocks(stripComments(rollbackBody(m)));
      const branch = b.find((x) => /-eq 124/.test(x.text));
      return !!branch && !/return 1\b/.test(branch.text);
    },
    mutate: (t) =>
      replaceOnce(
        t,
        'KILLED after ${RESTORE_BUILD_TIMEOUT}s (timeout) — the previous release could not be rebuilt. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."\n    return 1',
        'KILLED after ${RESTORE_BUILD_TIMEOUT}s (timeout) — the previous release could not be rebuilt. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."',
        // (anchored on the KILLED-specific prefix; the two failure branches end
        //  with identical lines, so anchoring on those matches TWICE)
        "timed-out rebuild continues"
      ),
    caught: ["failed-rebuild-returns-1"],
  },
  {
    id: "the rebuild fails silently (no loud verdict at all)",
    prove: (m) => /say "the restore rebuild FAILED \(npm ci\/build exit \$rc\)/.test(m) && !m.includes('loud "ROLLBACK FAILED: the restore rebuild FAILED'),
    mutate: (t) =>
      replaceOnce(
        t,
        'ROLLBACK FAILED: the restore rebuild FAILED (npm ci/build exit $rc) — the previous release is restored as SOURCE but has no working build. Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."',
        'say "the restore rebuild FAILED (npm ci/build exit $rc)',
        "silent rebuild failure"
      ),
    // `say` instead of `loud` also drops the phrase the half-built-tree gate
    // reads, so both fire — measured, not guessed.
    caught: ["failed-rebuild-is-loud", "failed-rebuild-says-not-restarting"],
  },
  {
    id: "a failed rebuild no longer says it will not restart a half-built tree",
    prove: (m) => {
      const b = ifBlocks(stripComments(rollbackBody(m)));
      const branch = b.find((x) => /"\$rc" -ne 0/.test(x.text));
      return !!branch && !branch.text.includes("NOT restarting a half-built tree");
    },
    mutate: (t) =>
      replaceOnce(
        t,
        'Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR. NOT restarting a half-built tree."\n    return 1\n  fi\n  if [[ ! -f "$TARGET_DIR/dist/cli.js" ]]',
        'Broken tree at ${TARGET_DIR}.broken, source at $ROLLBACK_DIR."\n    return 1\n  fi\n  if [[ ! -f "$TARGET_DIR/dist/cli.js" ]]',
        "quiet about the half-built tree"
      ),
    caught: ["failed-rebuild-says-not-restarting"],
  },
  {
    id: "a health failure rolls back but exits 0 (green pipeline, dead service)",
    prove: (m) => !m.includes('rollback "the new release never became healthy"\n    fail "deploy FAILED'),
    mutate: (t) =>
      replaceOnce(
        t,
        'rollback "the new release never became healthy"\n    fail "deploy FAILED and was ROLLED BACK to the previous release; exit nonzero on purpose"',
        'rollback "the new release never became healthy"',
        "health failure exits 0"
      ),
    caught: ["health-failure-exits-nonzero"],
  },
];

// ── tests ───────────────────────────────────────────────────────────────────

// The exact lines a mutation changed, as unified-ish diff output. Used ONLY by
// the ROLLBACK_MATRIX=2 report path, so it stays deliberately small: it reports
// the lines that differ between the real text and the mutant, prefixed with the
// sign of the change, which is what makes a mutation auditable by eye.
function changedLines(real: string, mutant: string): string[] {
  const a = real.split("\n");
  const b = mutant.split("\n");
  const out: string[] = [];
  // A single mutation is a single contiguous edit in practice, so a positional
  // window around the first/last differing index reports it without pulling in
  // a real diff library.
  let first = -1;
  let last = -1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return [];
  for (let i = first; i <= last; i++) {
    if (a[i] !== undefined && a[i] !== b[i]) out.push(`- ${a[i]}`);
    if (b[i] !== undefined && a[i] !== b[i]) out.push(`+ ${b[i]}`);
  }
  return out;
}

const RAW = process.env.ROLLBACK_MUTATION;

d("deploy.sh: the rollback REBUILDS the previous release, and can still never touch the vault", () => {
  // Escape hatch: run ONE mutation raw, so its red can be seen in real output.
  //   ROLLBACK_MUTATION='restore build deleted (copy-only restore)' \
  //     node --import tsx --test test/prod-rollback-rebuild.test.ts
  // ROLLBACK_MATRIX=1 — print the DERIVED mutation→gate mapping. The table in
  // the report is this output, not a hand-typed copy of it.
  // ROLLBACK_MATRIX=2 — the same, plus the exact lines each mutation changed,
  // so "the mutation is load-bearing" is auditable by eye and not only by the
  // `prove` predicates.
  if (process.env.ROLLBACK_MATRIX) {
    const withDiff = process.env.ROLLBACK_MATRIX !== "1";
    for (const m of MUTATIONS) {
      const mutant = m.mutate(realText);
      const hit = violationIds(mutant);
      console.log(`\n### ${m.id}`);
      if (withDiff) {
        for (const line of changedLines(realText, mutant)) console.log(line);
      }
      console.log(`caught by: ${hit.join(", ") || "(none)"}`);
    }
    return;
  }

  if (RAW) {
    const hit = MUTATIONS.find((m) => m.id === RAW);
    assert.ok(hit, `unknown ROLLBACK_MUTATION=${JSON.stringify(RAW)}; known: ${MUTATIONS.map((m) => m.id).join(" | ")}`);
    const mutated = hit.mutate(realText);
    assert.notEqual(mutated, realText, `mutation "${RAW}" did not change the text — it is a no-op and proves nothing`);
    assert.ok(hit.prove(mutated), `mutation "${RAW}" is NOT load-bearing: its own proof predicate fails on the mutant, so the mutation destroyed nothing`);
    const found = checkDeploy(mutated);
    assert.deepEqual(found, [], `MUTATION RED: "${RAW}" should have been caught, and was: ${JSON.stringify(found, null, 2)}`);
    return;
  }

  t("the real deploy.sh satisfies every gate", () => {
    const found = checkDeploy(realText);
    assert.deepEqual(
      found.map((x) => `${x.id} — ${x.why}`),
      []
    );
  });

  t("the restore's rebuild is a real, load-bearing command — not prose", () => {
    // Anti-vacuity of the ANCHOR: the gate must hang off the invocation
    // (`&& npm run build`), never off the say-line that MENTIONS it, or a
    // deleted build would still look like a build.
    const body = rollbackBody(realText);
    const invoked = /sudo -u "\$CHROME_USER" -H bash -lc "cd '\$TARGET_DIR' && npm ci --no-audit --no-fund && npm run build"/.test(body);
    assert.ok(invoked, "the restore must literally invoke `npm ci … && npm run build` as the service user");
    const without = body.replace(/(npm ci --no-audit --no-fund && npm run build)/, "");
    assert.ok(!without.includes("&& npm run build"), "the anchor must be the invocation itself, so removing it is observable");
  });

  t("every copy in the file is classified, so no rsync can escape the audit", () => {
    const all = rsyncs(realText);
    assert.deepEqual(
      all.map((r) => r.kind).sort(),
      ["preserve", "restore", "stage"],
      `every rsync must be classified as preserve/restore/stage; got ${JSON.stringify(all.map((r) => r.kind))}`
    );
  });

  for (const m of MUTATIONS) {
    t(`MUTATION RED — ${m.id}`, () => {
      const mutated = m.mutate(realText);
      // Load-bearing, in two independent senses: the text changed, AND the
      // literal the mutation names is gone from the mutant. A mutation that
      // changed nothing, or that left its own target intact, proves nothing and
      // must not be allowed to pass quietly.
      assert.notEqual(mutated, realText, `mutation "${m.id}" was a NO-OP: it cannot prove anything`);
      assert.ok(m.prove(mutated), `mutation "${m.id}" is NOT load-bearing: its own proof predicate fails on the mutant, so it destroyed nothing`);
      // ...and the REAL deploy.sh must satisfy the gate the mutation targets,
      // so a red here is attributable to the mutation alone.
      const baseline = violationIds(realText);
      const ids = violationIds(mutated);
      for (const want of m.caught) {
        assert.ok(!baseline.includes(want), `gate "${want}" already fails on the REAL deploy.sh — the mapping is not honest`);
      }
      assert.deepEqual(
        [...ids].sort(),
        [...m.caught].sort(),
        `mutation "${m.id}" tripped a DIFFERENT set of gates than it declares. Actual: [${ids.join(", ")}] — declared: [${m.caught.join(", ")}]. Update the mapping to the measured reality; do not loosen it.`
      );
    });
  }
});
