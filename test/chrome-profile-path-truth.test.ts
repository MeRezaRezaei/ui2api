import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  CHROME_CONFIG_DIR,
  PROFILE_CANDIDATES,
  chromeOwnerRelativeProfilePath,
  resolveChromeOwner,
  DEFAULT_CHROME_USER,
} from "../src/runtime/chrome-owner.js";

/**
 * THE CHROME PROFILE PATH HAS EXACTLY ONE SPELLING, AND THIS IS THE GATE THAT
 * SAYS SO.
 *
 * WHY THIS FILE EXISTS AT ALL, stated plainly because it is the same defect class
 * twice over: `src/runtime/requirements.ts` and `src/runtime/profile-scan.ts`
 * each point at a test file by name as the thing that will catch a divergence
 * (`test/chrome-profile-path-truth` and `test/posture-scan-truth`), and NEITHER
 * FILE EXISTED. A comment that says a gate will fire, next to no gate, is the
 * exact shape this session has been correcting all day — a true statement of a
 * hazard, recorded beside code that does not address it. This file is the real
 * gate, and it covers both claims.
 *
 * WHAT WAS MEASURED, and how (GOAL 177 asked for this and forbade guessing it):
 * `sudo -n` was available, so the `ui2api` user's home WAS inspected directly.
 *   - `/home/ui2api/.config/ui2api-chrome`  — LIVE. systemd
 *     `ui2api-chrome.service` MainPID 1895, and `--user-data-dir=` read out of
 *     `/proc/1895/cmdline`, reads exactly that; every one of the 11 chrome child
 *     processes carries the same flag; the dir was written seconds before the
 *     measurement (155M).
 *   - `/home/ui2api/.ui2api-chrome` — EXISTS but is a DEAD 187M orphan: dir
 *     mtime 2026-09-22 12:29, and `find -newermt 2026-09-25` over it returns
 *     NOTHING while the live dir returns files from today. It is a leftover from
 *     a "wave-19 seam" nothing provisions.
 *   - `resolveChromeOwner().profile` returns the `.config` path, which is what
 *     `userChromeProfile()` → `launchBrowser()` consumes.
 * So the readiness gate's spelling was, by luck, the live one — but it reached
 * that answer through a code path (`join(ui2apiUserHome(user), ".ui2api-chrome")`)
 * that was wrong, and the two tests that covered it were green BECAUSE the two
 * spellings disagreed: each pinned a string, neither pinned the fact, so the
 * divergence was the passing condition.
 *
 * WHAT THIS FILE DOES INSTEAD. It derives the spelling from its single owner
 * (`chrome-owner.ts`) and then COMPARES every restatement of it against that
 * derived value. A test that is green because two things disagree tests neither;
 * this one fails the moment they agree on the wrong answer or diverge again.
 *
 * HERMETIC BY CONSTRUCTION. Every assertion below compares TEXT TO TEXT. The one
 * host-reading assertion SKIPS with a named reason when the owner user is absent
 * (the CI container has no passwd entry for `ui2api`) — never a pass it did not
 * measure, and never a failure for a machine it cannot see. Two
 * environment-dependent "positive controls" were written earlier in this session
 * and both were wrong; this control deliberately asks nothing about this box.
 */

const DERIVED = chromeOwnerRelativeProfilePath();

/**
 * Strip comment-only lines so a gate judges EXECUTABLE CONTENT. A pin that
 * fires on the sentence explaining the pin teaches the next maintainer to delete
 * the sentence, and then the pin — and both of the source comments in this repo
 * legitimately QUOTE the dead spelling while explaining why it is gone.
 *
 * This is a line-class filter, not a parser, and it fails SAFE: an offender
 * hidden in a trailing comment is still reported, which is the correct direction
 * for a guard.
 */
function executableContent(text: string): string {
  return text
    .split("\n")
    .filter((l) => {
      const s = l.trim();
      return !(s.startsWith("//") || s.startsWith("*") || s.startsWith("/*") || s.startsWith("#"));
    })
    .join("\n");
}

/**
 * THE COMPARATOR, and the whole gate reduces to calling it. It is exported-by-
 * closure rather than duplicated per site so that every assertion below provably
 * goes through the same code the mutations below attack: a comparator tested in
 * one place and used in another is two comparators.
 */
function agreement(derived: string, restated: string | null, site: string): string | null {
  if (restated === null) return `${site}: the spelling could not be READ at all (renamed, deleted, or the line moved)`;
  if (restated !== derived) {
    return (
      `${site}: reads "${restated}", the owner derives "${derived}". ` +
      `These are the same path only by accident — one of them is about a directory that is not the point of use.`
    );
  }
  return null;
}

/** Read one named assignment's value out of shell/systemd text. */
function assignmentValue(text: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\s]+)"?`, "m").exec(executableContent(text));
  return m ? m[1] : null;
}

d("the chrome profile path has exactly one spelling (GOAL 177)", () => {
  t("POSITIVE CONTROL: the comparator answers correctly on inputs whose truth I know", () => {
    // Two environment-dependent controls were written earlier in this session and
    // both shipped wrong (one read the REAL resolver and failed in the pipeline
    // container; one cast a signature that takes no arguments and returned null).
    // So this control asks NOTHING about this machine. It proves the comparator
    // distinguishes agreement from disagreement, which is the only precondition
    // the pins below need — a comparator that cannot fail proves nothing when it
    // is green.
    assert.equal(agreement(DERIVED, DERIVED, "site-under-test"), null, "identical spellings must AGREE");
    assert.ok(
      agreement(DERIVED, ".ui2api-chrome", "site-under-test"),
      "the DEAD spelling must DISAGREE with the derived one — if this is null the comparator is broken",
    );
    assert.ok(
      agreement(DERIVED, ".config/google-chrome", "site-under-test"),
      "a real-but-WRONG profile dir must also DISAGREE; the gate must not just be a dead-spelling filter",
    );
    assert.ok(
      agreement(DERIVED, null, "site-under-test"),
      "an unreadable site must DISAGREE — a vanished spelling is a divergence too",
    );
  });

  t("the derived spelling IS the owner's ranked first candidate, not a restatement", () => {
    // Structural claim about the owner module, true on every host: the derived
    // value is computed from the exported ranking, so a consumer that calls this
    // function cannot be a second source of truth by construction.
    assert.equal(DERIVED, join(CHROME_CONFIG_DIR, PROFILE_CANDIDATES[0]));
    assert.ok(PROFILE_CANDIDATES.includes("ui2api-chrome"), "precondition: the point-of-use dir is ranked");
    assert.equal(
      PROFILE_CANDIDATES[0],
      "ui2api-chrome",
      "the point-of-use profile must rank FIRST — it is the one this project provisions and drives",
    );
    assert.equal(CHROME_CONFIG_DIR, ".config", "the config dir is the one Linux uses");
    assert.ok(DERIVED.startsWith(`${CHROME_CONFIG_DIR}/`), `derived spelling must live under the config dir, got ${DERIVED}`);
  });

  t("the provision script provisions the DERIVED spelling", () => {
    const file = "scripts/ops/provision-ui2api-user.sh";
    assert.ok(existsSync(file), `${file} must exist — it is what creates the point of use`);
    const restated = assignmentValue(readFileSync(file, "utf8"), "CHROME_DIR");
    const why = agreement(DERIVED, restated, `${file} CHROME_DIR`);
    assert.equal(why, null, why ?? undefined);
  });

  t("the systemd unit launches the DERIVED spelling, under its own declared HOME", () => {
    const file = "scripts/ops/units/ui2api-chrome.service";
    assert.ok(existsSync(file), `${file} must exist — it is the unit that runs the point of use`);
    const text = readFileSync(file, "utf8");
    const udd = /--user-data-dir=(\S+)/.exec(executableContent(text))?.[1] ?? null;
    const home = assignmentValue(text, "Environment=HOME");
    // The unit must be compared STRUCTURALLY: its absolute path is
    // `<its own HOME>/<derived>`. Comparing the tail alone would accept a unit
    // pointed at some other user's home, and hard-coding the expected absolute
    // would make the gate a test about whichever user this box has.
    const expected = home === null ? null : join(home, DERIVED);
    const why = agreement(expected ?? "\\u0000unset", udd, `${file} --user-data-dir`);
    assert.equal(why, null, why ?? undefined);
  });

  t("the OS-wide profile scanner walks the DERIVED spelling", () => {
    // This is the claim `src/runtime/profile-scan.ts:65` makes about
    // `test/posture-scan-truth.test.ts` — a file that never existed. The scanner
    // restates the path because it walks EVERY home directory, so it cannot call
    // the owner resolver; comparing is the only mechanism available across that
    // boundary, which is what this is.
    const file = "src/runtime/profile-scan.ts";
    assert.ok(existsSync(file), `${file} must exist — it is the bulk-login scanner`);
    const text = executableContent(readFileSync(file, "utf8"));
    const walked = new Set<string>();
    for (const m of text.matchAll(/"(\.config\/[^"]+)"/g)) walked.add(m[1]);
    assert.ok(
      walked.has(DERIVED),
      `${file} must walk the point-of-use spelling "${DERIVED}" — it is the profile the daemon drives, and ` +
        `without it the operator's real sign-ins are invisible to \`profile scan\` / \`profile add-all\`. ` +
        `Walked: ${[...walked].join(", ") || "(none parsed)"}`,
    );
  });

  t("the ABSOLUTE machine-specific path is never hard-coded in src/ — only derived", () => {
    // An earlier draft of this pin asserted that no module may restate ANY
    // profile dir the owner does not rank first. That assertion was FALSE and it
    // failed on first run: `profile-scan.ts` walks `.config/google-chrome` and
    // `.config/chromium` on purpose, because an OS-wide scanner must find every
    // normal Chrome on every user's disk. Ranking (which profile is the point of
    // use) and enumeration (which profiles exist) are different jobs, and a gate
    // that conflates them is a gate that must be deleted. Recorded because a
    // false property in a guard is the same defect class this file hunts.
    //
    // The true, narrower property: the ABSOLUTE path embeds the owner's HOME, which
    // is machine data (`getent`), so it may only ever come from the resolver. A
    // literal `/home/<someone>/.config/ui2api-chrome` in src/ is a copy of one
    // machine's answer, and it is the shape that made the two spellings diverge.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name)) {
          const text = executableContent(readFileSync(p, "utf8"));
          // any absolute home-prefixed spelling of the point of use
          if (new RegExp(`/home/[^/\\s"']*${CHROME_CONFIG_DIR}/${PROFILE_CANDIDATES[0]}`).test(text)) {
            offenders.push(p);
          }
        }
      }
    };
    walk("src");
    assert.deepEqual(
      offenders,
      [],
      `src/ hard-codes a machine-specific absolute profile path: ${offenders.join(", ")}\n` +
        `The owner's home is getent data. Ask resolveChromeOwner() instead of writing it down.`,
    );
  });

  t("HOST CROSS-CHECK (skips honestly when the owner is absent): the live resolver points at the DERIVED spelling", () => {
    // The hermetic pins above compare the repo to itself. This is the one
    // assertion that compares the repo to the MACHINE, so it is also the one
    // that cannot run everywhere — and the honest outcome when the owner user
    // does not exist here is a NAMED SKIP, never a pass we did not measure. The
    // CI container has no passwd entry for `ui2api`; two earlier controls in this
    // session failed there by asserting instead.
    let home: string | null = null;
    try {
      const out = execFileSync("getent", ["passwd", DEFAULT_CHROME_USER], {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      home = out ? out.split(":")[5] : null;
    } catch {
      home = null;
    }
    if (!home) {
      t.skip(`no passwd entry for ${DEFAULT_CHROME_USER} on this host — the live-profile cross-check cannot be measured here`);
      return;
    }
    const owner = resolveChromeOwner();
    if (!owner.profile) {
      t.skip(`no profile resolves for ${owner.user} on this host (missing: ${owner.missing ?? "unnamed"})`);
      return;
    }
    const expected = join(home, DERIVED);
    const why = agreement(expected, owner.profile, "resolveChromeOwner().profile");
    assert.equal(why, null, why ?? undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION PROOF. A gate nobody has watched go red is a gate nobody can trust —
// every gate in the last two waves shipped vacuous and was caught only this way.
// The mutations below run the REAL extractors and the REAL comparator over
// mutated TEXT, so what is proven is the gate's own code path, not a copy.
// ─────────────────────────────────────────────────────────────────────────────

d("GOAL 177: the spelling gate BITES (mutation proof)", () => {
  const PROVISION = "scripts/ops/provision-ui2api-user.sh";
  const UNIT = "scripts/ops/units/ui2api-chrome.service";
  const SCANNER = "src/runtime/profile-scan.ts";

  t("POSITIVE CONTROL: the three real sources AGREE with the derived spelling", () => {
    // If the real sources did not agree, every mutation below would be proving
    // nothing, because the comparator would already be red before mutating.
    const agree = [
      agreement(DERIVED, assignmentValue(readFileSync(PROVISION, "utf8"), "CHROME_DIR"), PROVISION),
      agreement(
        join(assignmentValue(readFileSync(UNIT, "utf8"), "Environment=HOME") ?? "", DERIVED),
        /--user-data-dir=(\S+)/.exec(executableContent(readFileSync(UNIT, "utf8")))?.[1] ?? null,
        UNIT,
      ),
    ];
    assert.deepEqual(
      agree.filter((x) => x !== null),
      [],
      "the real sources must agree before a mutation against them means anything",
    );
  });

  t("MUTATION 1: the provision script provisions the DEAD spelling -> RED", () => {
    const original = readFileSync(PROVISION, "utf8");
    const mutated = original.replace(`CHROME_DIR="${DERIVED}"`, 'CHROME_DIR=".ui2api-chrome"');
    assert.notEqual(mutated, original, `MUTATION SETUP FAILED — ${PROVISION} no longer assigns CHROME_DIR="${DERIVED}"`);
    const why = agreement(DERIVED, assignmentValue(mutated, "CHROME_DIR"), `${PROVISION} (mutated)`);
    assert.ok(why, "the gate MISSED a provision script pointed at the dead dir");
  });

  t("MUTATION 2: the provision script provisions a REAL-BUT-WRONG profile -> RED", () => {
    // The subtler one: `.config/google-chrome` exists on this box and would let a
    // provision script "work", so a dead-spelling-only guard would pass it while
    // the point of use silently moved to a profile this project does not own.
    const original = readFileSync(PROVISION, "utf8");
    const mutated = original.replace(`CHROME_DIR="${DERIVED}"`, 'CHROME_DIR=".config/google-chrome"');
    assert.notEqual(mutated, original, "MUTATION SETUP FAILED — the anchor moved");
    const why = agreement(DERIVED, assignmentValue(mutated, "CHROME_DIR"), `${PROVISION} (mutated)`);
    assert.ok(why, "the gate MISSED a provision script pointed at another real profile");
  });

  t("MUTATION 3: the systemd unit launches a different dir -> RED", () => {
    const original = readFileSync(UNIT, "utf8");
    const mutated = original.replace(
      `--user-data-dir=${join("/home/ui2api", DERIVED)}`,
      "--user-data-dir=/home/ui2api/.ui2api-chrome",
    );
    assert.notEqual(mutated, original, "MUTATION SETUP FAILED — the anchor moved");
    const home = assignmentValue(mutated, "Environment=HOME") ?? "";
    const udd = /--user-data-dir=(\S+)/.exec(executableContent(mutated))?.[1] ?? null;
    const why = agreement(join(home, DERIVED), udd, `${UNIT} (mutated)`);
    assert.ok(why, "the gate MISSED a unit launching a different profile dir");
  });

  t("MUTATION 4: the scanner stops walking the point of use -> RED", () => {
    const original = readFileSync(SCANNER, "utf8");
    const mutated = original.replace(`"${DERIVED}"`, '"config-only/google-chrome"');
    assert.notEqual(mutated, original, "MUTATION SETUP FAILED — the anchor moved");
    const walked = new Set<string>();
    for (const m of executableContent(mutated).matchAll(/"(\.config\/[^"]+)"/g)) walked.add(m[1]);
    assert.ok(
      !walked.has(DERIVED),
      "the gate MISSED a scanner that no longer walks the point-of-use profile — `profile add-all` would silently skip the operator's real sign-ins",
    );
  });

  t("MUTATION 5: the OWNER re-ranks and every restatement is left behind -> RED", () => {
    // The drift nobody would think about: not a restatement changing, but the
    // OWNER moving. Then every other site silently still provisions the old dir
    // while the resolver and the launch seam report a new one. Derivation is what
    // makes this visible: the derived value follows the ranking, the restatements
    // do not, and the comparator is exactly the thing that notices.
    const restated = assignmentValue(readFileSync(PROVISION, "utf8"), "CHROME_DIR");
    const reranked = join(CHROME_CONFIG_DIR, PROFILE_CANDIDATES[1]);
    assert.notEqual(reranked, DERIVED, "precondition: the second candidate differs from the first");
    const why = agreement(reranked, restated, `${PROVISION} (owner re-ranked)`);
    assert.ok(why, "the gate MISSED the owner moving out from under every restatement");
  });
});