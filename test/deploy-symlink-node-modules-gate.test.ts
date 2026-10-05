import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * GOAL: a mistake in a WORKTREE must never be able to damage PRODUCTION.
 *
 * THE INCIDENT. A lane symlinked `node_modules` into the worktree it deployed
 * from, to avoid a second `npm ci`. rsync matches an exclude pattern ending in
 * `/` against DIRECTORIES ONLY, and a symlink is not a directory for matching
 * purposes — so the shipped `--exclude 'node_modules/'` did not match it. The
 * symlink was transferred instead, `--delete` removed the destination's real
 * `node_modules` to make room, and /opt/ui2api/node_modules was replaced by a
 * link into that worktree.
 *
 * WHY THIS FILE IS A LIVE FALSIFIER AND NOT A TEXT GATE. A text gate can only
 * check that a pattern is spelled a certain way; the defect is what rsync DOES
 * with that pattern. So every behavioural pin below runs rsync for real, in a
 * scratch directory, against the patterns EXTRACTED FROM THE REAL deploy.sh —
 * never against a copy that can drift, and never against /opt/ui2api.
 *
 * The two halves are independent defences, and each is tested on its own:
 *   - the preflight refuses a source tree it does not recognise, before a
 *     single byte is written (the invariant);
 *   - the exclude patterns are type-agnostic, so even a hazard the preflight
 *     has never heard of cannot reach `--delete` (the belt).
 * Removing either one leaves the other, and each is proven to be load-bearing.
 */

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DEPLOY_SH = join(ROOT, "scripts", "ops", "deploy.sh");
const DEPLOY = readFileSync(DEPLOY_SH, "utf8");

/** Every scratch tree lives here, and is never /opt/ui2api. */
const SCRATCH = join(tmpdir(), "ui2api-deploy-symlink-gate");
const PRODUCTION = "/opt/ui2api";

/** Bounded on every call, per the repo's timeout discipline. */
const BOUND_MS = 60_000;
function run(cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { timeout: BOUND_MS, encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** deploy.sh's own `logicalLines`: continuations joined, so a regex sees the whole command. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (buf) buf += " " + line.trim();
    else buf = line;
    if (/\\$/.test(line)) {
      buf = buf.replace(/\\$/, "");
      continue;
    }
    out.push(buf);
    buf = "";
  }
  if (buf) out.push(buf);
  return out.filter((l) => l.trim().length > 0);
}

/** The rsync commands in the real script, split into the ones that must be audited. */
function rsyncCommands(text: string): { stage: string; preserve: string; restore: string } {
  const all = logicalLines(text);
  const stage = all.find((l) => l.includes('"$REPO_DIR/" "$TARGET_DIR/"'));
  const preserve = all.find((l) => l.includes('"$TARGET_DIR/" "$ROLLBACK_TMP/"'));
  const restore = all.find((l) => l.includes('"$ROLLBACK_DIR/" "$TARGET_DIR/"'));
  assert.ok(stage, "deploy.sh no longer has a stage rsync from $REPO_DIR to $TARGET_DIR");
  assert.ok(preserve, "deploy.sh no longer has a preserve rsync to $ROLLBACK_TMP");
  assert.ok(restore, "deploy.sh no longer has a restore rsync from $ROLLBACK_DIR");
  return { stage: stage!, preserve: preserve!, restore: restore! };
}

/** The `--exclude '<pattern>'` tokens of a real rsync command, in order. */
function excludePatterns(cmd: string): string[] {
  return [...cmd.matchAll(/--exclude '([^']*)'/g)].map((m) => m[1]!);
}

/** Build the hazard: a worktree whose `link` is a SYMLINK, and a destination whose `link` is a real, populated dir. */
function buildHazard(root: string, link: string): { src: string; dst: string } {
  rmSync(root, { recursive: true, force: true });
  const src = join(root, "src");
  const dst = join(root, "dst");
  const elsewhere = join(root, "elsewhere");
  mkdirSync(src, { recursive: true });
  // the worktree mistake
  for (const p of ["pkg-a", "pkg-b"]) mkdirSync(join(elsewhere, link, p), { recursive: true });
  writeFileSync(join(elsewhere, link, "pkg-a", "index.js"), "module");
  symlinkSync(join(elsewhere, link), join(src, link));
  // production's install dir: a REAL node_modules with a production-only payload
  for (const p of ["pkg-a", "pkg-b", "pkg-prod-only"]) mkdirSync(join(dst, link, p), { recursive: true });
  writeFileSync(join(dst, link, "pkg-prod-only", "index.js"), "PRODUCTION-ONLY-PAYLOAD");
  writeFileSync(join(dst, link, "pkg-a", "index.js"), "prod");
  writeFileSync(join(src, "package.json"), '{"name":"ui2api"}');
  return { src, dst };
}

type Verdict = "INTACT" | "SYMLINKED-INSTEAD" | "GUTTED" | "ABSENT";
function verdict(dst: string, link: string): Verdict {
  const p = join(dst, link);
  if (lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink()) return "SYMLINKED-INSTEAD";
  if (!existsSync(p)) return "ABSENT";
  if (existsSync(join(p, "pkg-prod-only", "index.js"))) return "INTACT";
  return "GUTTED";
}

d("deploy.sh: a symlinked node_modules in a worktree can never reach production's own", () => {
  t("the test can run rsync at all — a gate that cannot measure is not a gate", () => {
    const probe = spawnSync("rsync", ["--version"], { timeout: 10_000, encoding: "utf8" });
    assert.equal(
      probe.error?.message ?? null,
      null,
      "rsync is not on PATH. deploy.sh hard-depends on it, so this gate must fail loudly rather than skip: `apt-get install -y rsync` (Debian/Ubuntu)."
    );
    assert.match(probe.stdout ?? "", /rsync\s+version/, "rsync --version printed nothing recognisable");
  });

  t("LIVE FALSIFIER, OLD vs NEW: the shipped patterns leave production's node_modules alone, the old ones replace it", () => {
    const { stage } = rsyncCommands(DEPLOY);
    const realPatterns = excludePatterns(stage);

    // --- OLD: exactly what the script shipped, reproduced from git --------------
    const oldRoot = join(SCRATCH, "old");
    const old = buildHazard(oldRoot, "node_modules");
    const oldPatterns = realPatterns.map((p) => (p === "node_modules" ? "node_modules/" : p));
    assert.ok(
      !oldPatterns.includes("node_modules"),
      "the OLD pattern set is not reconstructible — this falsifier is no longer measuring the defect"
    );
    const rOld = run("rsync", ["-a", "--delete", ...oldPatterns.flatMap((p) => ["--exclude", p]), `${old.src}/`, `${old.dst}/`]);
    assert.equal(verdict(old.dst, "node_modules"), "SYMLINKED-INSTEAD", "the OLD patterns no longer reproduce the incident — the control is broken, not the fix");
    assert.equal(
      rOld.status,
      0,
      `the OLD destruction is expected to be silent (exit 0); it exited ${rOld.status} — which would mean set -e could stop it, so re-measure before trusting this file's claim`
    );

    // --- NEW: the patterns read out of the real script, right now ----------------
    const newRoot = join(SCRATCH, "new");
    const neu = buildHazard(newRoot, "node_modules");
    run("rsync", ["-a", "--delete", ...realPatterns.flatMap((p) => ["--exclude", p]), `${neu.src}/`, `${neu.dst}/`]);
    assert.equal(
      verdict(neu.dst, "node_modules"),
      "INTACT",
      "the REAL deploy.sh patterns let a symlinked worktree node_modules destroy the destination's real one"
    );
    assert.ok(
      !lstatSync(join(neu.dst, "node_modules"), { throwIfNoEntry: false })?.isSymbolicLink(),
      "the destination's node_modules is a symlink after the real stage rsync"
    );
  });

  t("LIVE: the same hole is not specific to node_modules — .git and dist are the same trap", () => {
    const { stage } = rsyncCommands(DEPLOY);
    const realPatterns = excludePatterns(stage);
    for (const link of [".git", "dist", "data", "sites"]) {
      // The control: the name matched ONLY by a directory-only pattern, which is
      // the shape that let the symlink through. Every OTHER pattern naming the
      // same path is dropped, so `data` is not accidentally rescued by the
      // anchored `/data` form the shipped script also carried.
      // The directory-only pattern is CONSTRUCTED, not read: the real script no
      // longer contains it, which is the whole point. It is exactly what git
      // shows the script shipped before this fix.
      const old = [...realPatterns.filter((p) => p !== link && p !== `/${link}`), `${link}/`];
      assert.ok(!old.includes(link), `the control for ${link} still matches the symlink`);
      const root = join(SCRATCH, `each-${link.replace(/\W/g, "")}`);
      const h = buildHazard(root, link);
      run("rsync", ["-a", "--delete", ...old.flatMap((p) => ["--exclude", p]), `${h.src}/`, `${h.dst}/`]);
      assert.equal(verdict(h.dst, link), "SYMLINKED-INSTEAD", `the control failed for ${link}: the trailing-slash pattern no longer reproduces the defect`);

      const root2 = join(SCRATCH, `each2-${link.replace(/\W/g, "")}`);
      const h2 = buildHazard(root2, link);
      run("rsync", ["-a", "--delete", ...realPatterns.flatMap((p) => ["--exclude", p]), `${h2.src}/`, `${h2.dst}/`]);
      assert.equal(verdict(h2.dst, link), "INTACT", `a symlinked source ${link} still reached --delete against the destination's real one`);
    }
  });

  t("LIVE: the wider patterns ship EXACTLY what the old ones shipped for a normal source", () => {
    // A fix that also changed what a deploy publishes would be a different bug.
    const { stage } = rsyncCommands(DEPLOY);
    const realPatterns = excludePatterns(stage);
    const src = join(SCRATCH, "equiv", "src");
    rmSync(join(SCRATCH, "equiv"), { recursive: true, force: true });
    mkdirSync(join(src, "pkg"), { recursive: true });
    for (const owned of ["node_modules", "dist", "data", "sites", ".brain", ".git", "graphify-out", ".agents", ".opencode"]) {
      mkdirSync(join(src, owned, "inner"), { recursive: true });
      writeFileSync(join(src, owned, "inner", "f.txt"), `secret-in-${owned}`);
    }
    writeFileSync(join(src, "pkg", "index.ts"), "export const x = 1;\n");
    writeFileSync(join(src, "package.json"), '{"name":"ui2api"}');

    const list = (root: string) => {
      const out: string[] = [];
      const walk = (rel: string) => {
        for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
          const p = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(p);
          else out.push(p);
        }
      };
      walk("");
      return out.sort().join("\n");
    };
    const oldDst = join(SCRATCH, "equiv", "dst-old");
    const newDst = join(SCRATCH, "equiv", "dst-new");
    mkdirSync(oldDst, { recursive: true });
    mkdirSync(newDst, { recursive: true });
    const oldPatterns = realPatterns.map((p) => (p === "node_modules" ? "node_modules/" : p === "dist" ? "dist/" : p === ".git" ? ".git/" : p === "sites" ? "sites/" : p === ".brain" ? ".brain/" : p === "graphify-out" ? "graphify-out/" : p === ".agents" ? ".agents/" : p === ".opencode" ? ".opencode/" : p));
    run("rsync", ["-a", "--delete", ...oldPatterns.flatMap((p) => ["--exclude", p]), `${src}/`, `${oldDst}/`]);
    run("rsync", ["-a", "--delete", ...realPatterns.flatMap((p) => ["--exclude", p]), `${src}/`, `${newDst}/`]);
    assert.equal(list(newDst), list(oldDst), "the new patterns changed what a normal deploy ships");
    assert.ok(list(newDst).includes("pkg/index.ts"), "the control shipped nothing, so the comparison is vacuous");
    for (const owned of ["node_modules", "dist", "data", "sites", ".brain", ".git", "graphify-out"]) {
      assert.ok(!existsSync(join(newDst, owned)), `the new patterns leaked ${owned} into the install dir`);
    }
  });

  t("LIVE: --delete-excluded is the one flag that would re-open the hole, so no rsync may carry it", () => {
    const { stage } = rsyncCommands(DEPLOY);
    const realPatterns = excludePatterns(stage);
    const root = join(SCRATCH, "delexcl");
    const h = buildHazard(root, "node_modules");
    run("rsync", [
      "-a", "--delete", "--delete-excluded",
      ...realPatterns.flatMap((p) => ["--exclude", p]),
      `${h.src}/`, `${h.dst}/`,
    ]);
    assert.notEqual(verdict(h.dst, "node_modules"), "INTACT", "--delete-excluded did NOT destroy the excluded dir — the justification for banning it is stale and the gate must be re-derived");
    for (const [label, cmd] of Object.entries(rsyncCommands(DEPLOY))) {
      assert.ok(!/--delete-excluded/.test(cmd), `the ${label} rsync carries --delete-excluded, which turns every exclusion into a deletion instruction`);
    }
  });

  t("MEASURED: `data` was never actually breached — the anchored `/data` form was an accidental belt", () => {
    // Worth stating rather than assuming: the vault exclusion shipped TWO forms,
    // and `--exclude '/data'` has no trailing slash, so it matched the symlink
    // too. That is the only reason a symlinked `data` in a worktree could not do
    // what a symlinked `node_modules` did. It was luck of a second pattern, not a
    // design — which is the same non-property as the set -e ordering, and the
    // reason the bare `data` form is now stated rather than left to chance.
    const { stage } = rsyncCommands(DEPLOY);
    const pats = excludePatterns(stage);
    assert.ok(pats.includes("/data"), "the anchored /data form is gone — re-measure whether a symlinked data/ was ever dangerous");
    const root = join(SCRATCH, "data-belt");
    const h = buildHazard(root, "data");
    const beltless = pats.filter((p) => p !== "/data" && p !== "data");
    run("rsync", ["-a", "--delete", ...beltless.flatMap((p) => ["--exclude", p]), `${h.src}/`, `${h.dst}/`]);
    assert.equal(verdict(h.dst, "data"), "SYMLINKED-INSTEAD", "removing both type-agnostic data forms did NOT reproduce the hazard — the claim that /data was the belt is stale");
  });

  t("no exclude pattern may rely on a trailing slash to match a directory name", () => {
    const { stage, preserve } = rsyncCommands(DEPLOY);
    const owned = (DEPLOY.match(/^DEPLOY_OWNED_PATHS=\((.*)\)$/m)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    assert.ok(owned.length >= 8, `DEPLOY_OWNED_PATHS did not parse out of deploy.sh (got ${JSON.stringify(owned)}) — the preflight and the excludes can no longer be compared`);
    for (const [label, cmd] of Object.entries({ stage, preserve })) {
      const pats = excludePatterns(cmd);
      for (const name of owned) {
        assert.ok(
          pats.includes(name),
          `the ${label} rsync has no type-agnostic --exclude '${name}'; a trailing-slash pattern does not match a symlink of that name`
        );
      }
    }
  });

  t("the REAL preflight refuses a worktree that symlinks an owned path, having written nothing", () => {
    const owned = DEPLOY.match(/^DEPLOY_OWNED_PATHS=.*$/m)?.[0];
    const assertFn = DEPLOY.match(/^assert_no_symlink_at_owned_path\(\) \{[\s\S]*?\n\}\n/m)?.[0];
    const preflightFn = DEPLOY.match(/^preflight\(\) \{[\s\S]*?\n\}\n/m)?.[0];
    assert.ok(owned && assertFn && preflightFn, "deploy.sh lost DEPLOY_OWNED_PATHS / assert_no_symlink_at_owned_path() / preflight() — the gate cannot find the code it guards");

    const root = join(SCRATCH, "pf-source");
    const h = buildHazard(root, "node_modules");
    const dst = join(root, "install");
    mkdirSync(join(dst, "node_modules", "pkg-a"), { recursive: true });
    mkdirSync(join(dst, "node_modules", "pkg-prod-only"), { recursive: true });
    writeFileSync(join(dst, "package.json"), '{"name":"ui2api"}');
    writeFileSync(join(dst, "node_modules", "pkg-a", "index.js"), "prod");
    writeFileSync(join(dst, "node_modules", "pkg-prod-only", "index.js"), "PRODUCTION-ONLY-PAYLOAD");

    const harness = join(root, "harness.sh");
    writeFileSync(
      harness,
      [
        "set -uo pipefail",
        'say()  { printf "[deploy] %s\\n" "$*"; }',
        'loud() { printf "[deploy] %s\\n" "$*" >&2; }',
        'fail() { printf "[deploy] FATAL: %s\\n" "$*" >&2; exit 1; }',
        "CHROME_USER=ui2api",
        `REPO_DIR=${JSON.stringify(h.src)}`,
        `TARGET_DIR=${JSON.stringify(dst)}`,
        owned,
        assertFn,
        preflightFn,
        "preflight",
        "",
      ].join("\n")
    );
    const r = run("bash", [harness]);
    assert.equal(r.status, 1, `the real preflight ACCEPTED a source that symlinks node_modules (exit ${r.status})\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /PREFLIGHT REFUSED/, `the refusal is not loud:\n${r.stderr}`);
    assert.match(r.stderr, /is a SYMLINK/, `the refusal does not name the symlink:\n${r.stderr}`);
    assert.equal(verdict(dst, "node_modules"), "INTACT", "the preflight refused, yet the destination was still damaged");
  });

  t("the REAL preflight refuses an install dir whose node_modules is already gone — the damage-detection half", () => {
    const owned = DEPLOY.match(/^DEPLOY_OWNED_PATHS=.*$/m)?.[0] ?? "";
    const assertFn = DEPLOY.match(/^assert_no_symlink_at_owned_path\(\) \{[\s\S]*?\n\}\n/m)?.[0] ?? "";
    const preflightFn = DEPLOY.match(/^preflight\(\) \{[\s\S]*?\n\}\n/m)?.[0] ?? "";
    assert.ok(owned && assertFn && preflightFn, "deploy.sh lost the preflight code this gate executes");

    const runPreflight = (name: string, shape: (dst: string) => void): { status: number | null; stdout: string; stderr: string } => {
      const root = join(SCRATCH, `pf-dmg-${name}`);
      rmSync(root, { recursive: true, force: true });
      const src = join(root, "src");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "package.json"), '{"name":"ui2api"}');
      const dst = join(root, "install");
      mkdirSync(dst, { recursive: true });
      writeFileSync(join(dst, "package.json"), '{"name":"ui2api"}');
      shape(dst);
      const harness = join(root, "harness.sh");
      writeFileSync(
        harness,
        [
          "set -uo pipefail",
          'say()  { printf "[deploy] %s\\n" "$*"; }',
          'loud() { printf "[deploy] %s\\n" "$*" >&2; }',
          'fail() { printf "[deploy] FATAL: %s\\n" "$*" >&2; exit 1; }',
          "CHROME_USER=ui2api",
          `REPO_DIR=${JSON.stringify(src)}`,
          `TARGET_DIR=${JSON.stringify(dst)}`,
          owned, assertFn, preflightFn, "preflight", "",
        ].join("\n")
      );
      return run("bash", [harness]);
    };

    const healthy = runPreflight("healthy", (dst) => {
      mkdirSync(join(dst, "node_modules", "pkg-a"), { recursive: true });
      writeFileSync(join(dst, "node_modules", "pkg-a", "index.js"), "prod");
    });
    assert.equal(healthy.status, 0, `a HEALTHY install dir was refused — the damage gate is firing on everything, which is a different lie:\n${healthy.stderr}`);
    assert.match(healthy.stdout, /holds 1 entries/, `the preflight does not report the node_modules entry count:\n${healthy.stdout}`);

    const emptied = runPreflight("emptied", (dst) => mkdirSync(join(dst, "node_modules"), { recursive: true }));
    assert.equal(emptied.status, 1, "an EMPTY node_modules was accepted — a green deploy would be reported on top of an already-broken release");
    assert.match(emptied.stderr, /is EMPTY or unreadable/, `the empty-node_modules refusal is not named:\n${emptied.stderr}`);

    const missing = runPreflight("missing", () => {});
    assert.equal(missing.status, 1, "a MISSING node_modules was accepted on a tree that has a package.json");
    assert.match(missing.stderr, /is not a directory/, `the missing-node_modules refusal is not named:\n${missing.stderr}`);

    const linked = runPreflight("linked", (dst) => symlinkSync(SCRATCH, join(dst, "node_modules")));
    assert.equal(linked.status, 1, "a SYMLINKED node_modules in the INSTALL DIR was accepted");
    assert.match(linked.stderr, /is a SYMLINK/, `the install-dir symlink refusal is not named:\n${linked.stderr}`);

    const vaulted = runPreflight("vaulted", (dst) => {
      mkdirSync(join(dst, "node_modules", "pkg-a"), { recursive: true });
      writeFileSync(join(dst, "node_modules", "pkg-a", "index.js"), "prod");
      mkdirSync(join(dst, "data", "sessions"), { recursive: true });
    });
    assert.equal(vaulted.status, 1, "an install dir that already carries data/ was accepted");
    assert.match(vaulted.stderr, /must never create or replace the vault/, `the pre-sync vault refusal is not named:\n${vaulted.stderr}`);
  });

  t("ORDER INDEPENDENCE: the preflight runs before the FIRST rsync, so no step order can matter", () => {
    const preflightAt = DEPLOY.search(/^preflight$/m);
    const firstRsyncAt = DEPLOY.search(/^(\s*)(\S.*\s)?if ! rsync -a --delete|^\s*rsync -a --delete/m);
    assert.ok(preflightAt >= 0, "deploy.sh never calls preflight()");
    assert.ok(firstRsyncAt >= 0, "deploy.sh no longer has an rsync to compare against");
    assert.ok(
      preflightAt < firstRsyncAt,
      `preflight() is called at offset ${preflightAt} but the first rsync is at ${firstRsyncAt} — the guard runs AFTER the first destructive step, so the safety is order-dependent again`
    );
    // and it is before the restart, which is the order the last incident relied on
    const restartAt = DEPLOY.search(/^\s*systemctl restart ui2api-api\.service/m);
    assert.ok(restartAt > firstRsyncAt, "the restart no longer follows the sync, so the reported order proof no longer holds — re-derive it");
    assert.ok(preflightAt < restartAt, "preflight() runs after the restart");
  });

  t("the restore rsync is safe by an EMPTY DESTINATION, and that reason is on the record", () => {
    const { restore } = rsyncCommands(DEPLOY);
    // Its destination is created fresh immediately above it, after the target is
    // moved aside — so `--delete` has nothing to delete and the absence of a
    // node_modules exclude is structural rather than an oversight. Pin BOTH the
    // code and the note, so a future reader cannot mistake it for the bug.
    // A logical line (continuations joined) does NOT occur verbatim in the raw
    // text, so index the PHYSICAL fragment that identifies the restore instead.
    const idx = DEPLOY.indexOf('"$ROLLBACK_DIR/" "$TARGET_DIR/"');
    assert.ok(idx > 0, "the restore rsync's destination pair is not in deploy.sh");
    const before = DEPLOY.slice(Math.max(0, idx - 1200), idx);
    assert.match(before, /mv "\$TARGET_DIR" "\$\{TARGET_DIR\}\.broken"/, "the restore no longer moves the install dir aside before restoring into it");
    assert.match(before, /mkdir -p "\$TARGET_DIR"/, "the restore's destination is no longer created empty right before the rsync");
    const after = DEPLOY.slice(idx, idx + 500);
    assert.match(after, /\[\[ -e "\$TARGET_DIR\/data" \]\]/, "the restore no longer re-asserts the vault is absent");
  });
});

d("ANTI-VACUITY: each pin must go RED when its own fix is reverted", () => {
  /** The gate, re-expressed over a given deploy.sh text. */
  const pinExcludesAreTypeAgnostic = (text: string) => {
    const owned = (text.match(/^DEPLOY_OWNED_PATHS=\((.*)\)$/m)?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    assert.ok(owned.length >= 8, "DEPLOY_OWNED_PATHS did not parse");
    // NOT the restore: its destination is created empty, so it needs no
    // node_modules exclude at all. Pinned separately, with that reason.
    const { stage, preserve } = rsyncCommands(text);
    for (const cmd of [stage, preserve]) {
      for (const name of owned) {
        assert.ok(excludePatterns(cmd).includes(name), `no type-agnostic --exclude '${name}'`);
      }
    }
  };
  const pinPreflightPrecedesRsync = (text: string) => {
    const p = text.search(/^preflight$/m);
    const r = text.search(/^(\s*)(\S.*\s)?if ! rsync -a --delete|^\s*rsync -a --delete/m);
    assert.ok(p >= 0 && r >= 0 && p < r, `preflight at ${p} is not before the first rsync at ${r}`);
  };
  const pinNoDeleteExcluded = (text: string) => {
    for (const [label, cmd] of Object.entries(rsyncCommands(text))) {
      assert.ok(!/--delete-excluded/.test(cmd), `the ${label} rsync carries --delete-excluded`);
    }
  };

  t("reverting the exclude to the trailing-slash form turns the pin RED", () => {
    const reverted = DEPLOY.replace(/--exclude 'node_modules'/g, "--exclude 'node_modules/'");
    assert.notEqual(reverted, DEPLOY, "the mutation anchor is gone — deploy.sh no longer contains --exclude 'node_modules'");
    assert.throws(() => pinExcludesAreTypeAgnostic(reverted), /node_modules/, "the type-agnostic pin is DECORATIVE: it survived the exact revert that caused the incident");
    // and the pins still hold on the real text
    pinExcludesAreTypeAgnostic(DEPLOY);
  });

  t("reverting every owned name to a trailing slash turns the pin RED", () => {
    let reverted = DEPLOY;
    for (const name of ["dist", ".git", "sites", ".brain", "graphify-out", ".agents", ".opencode"]) {
      reverted = reverted.replaceAll(`--exclude '${name}'`, `--exclude '${name}/'`);
    }
    assert.throws(() => pinExcludesAreTypeAgnostic(reverted), /no type-agnostic/, "the pin is DECORATIVE for the names other than node_modules");
    pinExcludesAreTypeAgnostic(DEPLOY);
  });

  t("moving the preflight() call after the first rsync turns the pin RED", () => {
    const moved = DEPLOY.replace(/^preflight$/m, "# preflight (moved down by the mutation)");
    assert.notEqual(moved, DEPLOY, "the mutation anchor is gone — there is no bare `preflight` call line");
    assert.throws(() => pinPreflightPrecedesRsync(moved), /not before the first rsync/, "the order pin is DECORATIVE");
    pinPreflightPrecedesRsync(DEPLOY);
  });

  t("adding --delete-excluded to any rsync turns the pin RED", () => {
    const poisoned = DEPLOY.replace("rsync -a --delete \\", "rsync -a --delete --delete-excluded \\");
    assert.notEqual(poisoned, DEPLOY, "the mutation anchor is gone");
    assert.throws(() => pinNoDeleteExcluded(poisoned), /--delete-excluded/, "the --delete-excluded ban is DECORATIVE");
    pinNoDeleteExcluded(DEPLOY);
  });
});

d("SCOPE: this gate never touches production", () => {
  t("no scratch path in this file is /opt/ui2api or under it", () => {
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    // Exactly ONE hardcoded production path in this file: the constant, which is
    // only ever compared against. A second literal would be a path this gate
    // could write to, so the count is pinned rather than trusted.
    assert.equal(
      self.match(/["`]\/opt\/ui2api["`]/g)?.length ?? 0,
      1,
      "this file hardcodes a production path somewhere other than the PRODUCTION constant — inspect every occurrence before trusting this pin"
    );
    assert.notEqual(SCRATCH, PRODUCTION);
    assert.ok(!SCRATCH.startsWith(PRODUCTION), `the scratch root is inside production: ${SCRATCH}`);
    assert.ok(SCRATCH.startsWith(tmpdir()), `the scratch root is not under the OS temp dir: ${SCRATCH}`);
  });

  t("cleanup: the scratch tree is removable and contains no symlink into the repo", () => {
    rmSync(SCRATCH, { recursive: true, force: true });
    assert.ok(!existsSync(SCRATCH), "the scratch tree survived removal");
  });
});
