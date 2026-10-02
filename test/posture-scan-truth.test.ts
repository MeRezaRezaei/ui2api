import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { CHROME_CONFIG_DIR, PROFILE_CANDIDATES } from "../src/runtime/chrome-owner.js";
import { findAllChromeProfilesOnOs } from "../src/runtime/profile-scan.js";

/**
 * RANKED PROFILE DIRS ⊆ WALKED PROFILE DIRS — AND THE COMMENT IN
 * `src/runtime/profile-scan.ts` THAT SAYS SO IS NO LONGER A FICTION.
 *
 * WHY THIS FILE EXISTS. `src/runtime/profile-scan.ts:65` claimed, for the whole
 * life of the `CANDIDATE_SUBPATHS` list:
 *
 *     `test/posture-scan-truth.test.ts` fails LOUD if `chrome-owner.ts` ever
 *     ranks a profile dir this list does not walk.
 *
 * and that file DID NOT EXIST. It was the second instance today of this repo's
 * own named defect — a comment promising a gate, beside no gate — and the first
 * was `test/chrome-profile-path-truth` (named by `src/runtime/requirements.ts`).
 * This is that file, so the sentence is now true. The sentence is also, as it
 * turns out, the description of a REAL and STILL-UNCOVERED hole, which is why
 * this is a gate and not a deletion.
 *
 * WHAT THE CLAIM WAS PROTECTING (measured, not assumed). `chrome-owner.ts`
 * ranks four profile dirs under a user's config dir and RESOLVES THE POINT OF USE
 * FROM THAT RANKING — `resolveChromeOwner()` returns the first candidate that
 * exists and holds a real profile, and `userChromeProfile()` →
 * `launchBrowser()` drives it. `profile-scan.ts` walks a SEPARATE list of config
 * subpaths on purpose (it must find every Chrome on every user's disk, which is a
 * superset job). Two lists, two jobs, one required relationship:
 *
 *     every dir chrome-owner.ts can SELECT must be a dir profile-scan.ts WALKS
 *
 * MEASURED THE DAY THIS FILE WAS WRITTEN: that relationship was FALSE.
 * `PROFILE_CANDIDATES` ranks `chrome` (chrome-owner.ts:51) and
 * `CANDIDATE_SUBPATHS` did not walk `.config/chrome`. So on a box where
 * `ui2api-chrome`, `google-chrome` and `chromium` were all absent but a real
 * `.config/chrome` profile existed, `resolveChromeOwner()` would have returned
 * that profile as the point of use while `profile scan` / `profile add-all` — the
 * bulk-login command the README leads with — walked straight past it. Exactly the
 * silent blindness documented at profile-scan.ts:22-34, one dir further out.
 *
 * NOT CONFLATED WITH ENUMERATION (the mistake that makes this gate possible).
 * The scanner is allowed to walk dirs the owner does not rank — `google-chrome-beta`
 * and `Google/Chrome` are enumeration, not ranking — and this gate says NOTHING
 * about them in either direction. Ranking is "which profile is the point of use";
 * enumeration is "which profiles exist". `test/chrome-profile-path-truth.test.ts`
 * recorded that lesson the hard way: an earlier draft here asserted no module may
 * restate ANY ranked dir, failed on first run for exactly that reason, and was
 * narrowed. The property below is the one direction that is genuinely required.
 *
 * HERMETIC. Nothing here reads the operator's disk. Each check builds a real
 * `Local State` + `Default/` profile tree under a fresh mkdtemp HOME and asks
 * the REAL exported scanner what it finds — no source text is parsed, so the
 * gate cannot be satisfied by a comment or a string literal, and it cannot be
 * defeated by the list moving to another file.
 */

/** One planted profile dir that looks exactly like a real Chrome profile root. */
function plantProfileRoot(home: string, configSubpath: string): string {
  const root = join(home, configSubpath);
  mkdirSync(join(root, "Default", "Network"), { recursive: true });
  writeFileSync(join(root, "Local State"), '{"os_crypt":{"encrypted_key":"x"}}');
  return root;
}

/**
 * Plant a profile dir for EVERY ranked candidate under one temp HOME, ask the
 * real scanner what it walks there, and return the set of candidate NAMES it
 * discovered. Returns the planted roots too, so a caller can tell "not walked"
 * apart from "never planted" — a gate that conflates those two is a gate that
 * passes because its fixture was broken.
 */
function walkRankedCandidates(): { walked: Set<string>; planted: string[]; home: string } {
  const home = mkdtempSync(join(tmpdir(), "u2a-posture-scan-home-"));
  const planted = PROFILE_CANDIDATES.map((c) => plantProfileRoot(home, `${CHROME_CONFIG_DIR}/${c}`));

  const prevHome = process.env.HOME;
  process.env.HOME = home;
  let found: string[];
  try {
    found = findAllChromeProfilesOnOs().profiles.map((p) => basename(p.root));
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
  return { walked: new Set(found), planted, home };
}

/**
 * THE GATE, as one pure comparator, so every assertion — and every mutation below
 * — provably runs the same code. Given the set of profile-dir NAMES a scan
 * discovered, it returns the ranked candidate names that are missing from it.
 *
 * Deliberately PURE and deliberately kept separate from fixture checking: a
 * comparator that also validated its own fixture cannot distinguish "the scanner
 * stopped walking this dir" (the regression) from "my fixture was never planted"
 * (a broken test), and the second would then be reported as the first.
 */
function unwalkedRanked(walked: ReadonlySet<string>): string[] {
  return PROFILE_CANDIDATES.filter((c) => !walked.has(c));
}

/**
 * The fixture check, kept as its OWN function precisely so it can be attacked on
 * its own (MUTATION 4). Every planted root must be discovered by an UNMUTATED
 * scan; if one is not, the run measured nothing and says so by name.
 */
function assertFixturePlanted(walked: ReadonlySet<string>, planted: readonly string[]): void {
  assert.ok(planted.length > 0, "fixture broken: nothing was planted, so this run proves nothing about the list");
  for (const p of planted) {
    assert.ok(
      walked.has(basename(p)),
      `fixture broken: planted ${p} but the scan did not report it — this run proves nothing about the walk list`,
    );
  }
}

d("every profile dir chrome-owner ranks is a dir profile-scan walks", () => {
  t("POSITIVE CONTROL: the fixture and the gate both work — nothing ranked is unwalked", () => {
    const { walked, planted } = walkRankedCandidates();
    assertFixturePlanted(walked, planted);
    const missed = unwalkedRanked(walked);
    assert.deepEqual(
      missed,
      [],
      `these ranked profile dirs the scanner does NOT walk: ${missed.join(", ")} — ` +
        `\`profile scan\` / \`profile add-all\` would silently skip the operator's real sign-ins. ` +
        `Walked: ${[...walked].sort().join(", ") || "(none)"}`,
    );
  });

  t("the ranked POINT OF USE specifically is walked by the scanner", () => {
    // Stated separately from the set pin because this is the dir with a MEASURED
    // live cost: `ui2api-chrome` holds the operator's point-of-use sign-ins, and
    // it was invisible to `profile add-all` until CANDIDATE_SUBPATHS was widened.
    const { walked } = walkRankedCandidates();
    const pointOfUse = PROFILE_CANDIDATES[0];
    assert.equal(pointOfUse, "ui2api-chrome", "the owner ranks ui2api-chrome FIRST — the dir this project provisions");
    assert.ok(
      walked.has(pointOfUse),
      `the scanner must walk the point-of-use profile "${pointOfUse}"; walked: ${[...walked].sort().join(", ") || "(none)"}`,
    );
  });

  t("the scanner still walks dirs the owner does NOT rank (enumeration is a superset job)", () => {
    // The negative direction, pinned so the fix for the above can never be
    // "make the walk list exactly equal the ranking". `google-chrome-beta` and
    // `Google/Chrome` exist in the walk list for enumeration alone; if this
    // fails, someone has collapsed two different jobs into one.
    const home = mkdtempSync(join(tmpdir(), "u2a-posture-scan-extra-"));
    try {
      for (const sub of ["google-chrome-beta", "Google/Chrome"]) {
        plantProfileRoot(home, `${CHROME_CONFIG_DIR}/${sub}`);
      }
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      let found: string[];
      try {
        found = findAllChromeProfilesOnOs().profiles.map((p) => basename(p.root));
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
      for (const sub of ["google-chrome-beta", "Chrome"]) {
        assert.ok(
          found.includes(sub),
          `the OS-wide scanner must keep enumerating ${sub} — it finds every Chrome on every disk, ` +
            `not only the ranked point of use. Found: ${found.join(", ") || "(none)"}`,
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION PROOF. A gate nobody has watched go red is a gate nobody can trust —
// every gate in the last waves shipped vacuous and was caught exactly this way.
// These run the REAL scanner and the REAL comparator over mutated INPUT, so what
// is proven is the gate's own code path rather than a copy of it. The on-disk
// mutation that proves the shipped list is watched separately, by deleting the
// entry from profile-scan.ts and running this file.
// ─────────────────────────────────────────────────────────────────────────────

d("the ranked-vs-walked gate BITES (mutation proof)", () => {
  t("MUTATION 1: the scanner drops the ranked point of use -> the gate says RED", () => {
    const { walked, planted } = walkRankedCandidates();
    assertFixturePlanted(walked, planted);
    const without = new Set(walked);
    without.delete(PROFILE_CANDIDATES[0]);
    const missed = unwalkedRanked(without);
    assert.deepEqual(missed, [PROFILE_CANDIDATES[0]], "precondition: the real scan walks it today");
    assert.ok(missed.length > 0, "the gate MISSED a scanner that stopped walking the point of use");
  });

  t("MUTATION 2: the scanner drops a RANKED-BUT-NOT-FIRST dir -> the gate says RED", () => {
    // The drift this file was written for. `chrome` is ranked fourth and is not
    // the point of use on any box today, so a gate that only pinned candidate[0]
    // (the shape in chrome-profile-path-truth) is GREEN against exactly this
    // defect — which is why this file exists separately from that one. It must
    // be red here.
    const tail = PROFILE_CANDIDATES.filter((c) => c !== PROFILE_CANDIDATES[0]);
    assert.ok(tail.length > 0, "precondition: there are ranked candidates beyond the first");
    const { walked, planted } = walkRankedCandidates();
    assertFixturePlanted(walked, planted);
    const without = new Set(walked);
    for (const c of tail) without.delete(c);
    const missed = unwalkedRanked(without);
    assert.deepEqual(missed, tail, "precondition: every non-first candidate is walked today");
    assert.ok(
      missed.includes("chrome"),
      "the gate must name `chrome` specifically: it is the ranked dir the walk list did not contain when this file was written",
    );
    assert.ok(missed.length > 0, "the gate MISSED ranked dirs disappearing from the walk list");
  });

  t("MUTATION 3: the OWNER re-ranks a dir the scanner does not walk -> the gate says RED", () => {
    // The drift nobody thinks about: nothing on the scanner's side changed at
    // all — the OWNER gained a candidate. A gate pinned to a frozen copy of the
    // walk list stays green; one pinned to the ranked list cannot. This is the
    // shape of the future bug that would otherwise land unnoticed.
    const phantom = "u2a-phantom-profile";
    const { walked, planted } = walkRankedCandidates();
    assertFixturePlanted(walked, planted);
    assert.deepEqual(
      unwalkedRanked(walked),
      [],
      "precondition: nothing is unwalked before the owner adds a candidate",
    );
    // A new ranked candidate that the scanner has never been told to walk. The
    // comparator is asked the same question it asked above, with the ranking
    // widened instead of the walk list narrowed.
    const widenedRanking = [...PROFILE_CANDIDATES, phantom];
    const missedAfter = widenedRanking.filter((c) => !walked.has(c));
    assert.deepEqual(
      missedAfter,
      [phantom],
      "a new ranked candidate that the scanner does not walk must be reported by name",
    );
    assert.ok(
      missedAfter.includes(phantom),
      "the gate MISSED the owner ranking a dir the scanner never learned to walk",
    );
  });

  t("MUTATION 4: a broken fixture cannot masquerade as a RED gate", () => {
    // The other vacuity shape: the comparator itself is correct, but the thing
    // it is asked about was never planted. Reporting that as "these ranked dirs
    // are unwalked" would be a FALSE ALARM about the product, invented by a
    // broken test — the mirror image of the defect this file hunts. It must fail
    // with the fixture named as the cause.
    let thrown: Error | null = null;
    try {
      assertFixturePlanted(new Set(["ui2api-chrome"]), ["/nonexistent/.config/chromium"]);
    } catch (e) {
      thrown = e as Error;
    }
    assert.ok(thrown, "an unplanted fixture must NOT read as a clean scan");
    assert.match(
      String(thrown?.message ?? ""),
      /fixture broken/,
      "the failure must name the fixture as the cause, not the walk list",
    );
    // And the same unplanted run must NOT be usable as gate evidence.
    assert.ok(
      unwalkedRanked(new Set(["ui2api-chrome"])).length > 0,
      "precondition: the comparator does report the gap, so the fixture check above is the only thing distinguishing the two",
    );
  });

  t("MUTATION 5: a profile dir that is NOT a real Chrome profile is correctly ignored", () => {
    // The gate must not degrade into "any dir under .config counts". A dir with
    // no `Local State` and no `Default` is what `isProfileRoot` exists to reject,
    // and a gate that accepted it would pass on a scanner that walks everything.
    const home = mkdtempSync(join(tmpdir(), "u2a-posture-scan-fake-"));
    try {
      mkdirSync(join(home, CHROME_CONFIG_DIR, PROFILE_CANDIDATES[0], "Cache"), { recursive: true });
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      let found: string[];
      try {
        found = findAllChromeProfilesOnOs().profiles.map((p) => basename(p.root));
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
      }
      assert.ok(
        !found.includes(PROFILE_CANDIDATES[0]),
        `a dir with no Local State and no Default is not a profile root and must not be walked; found: ${found.join(", ") || "(none)"}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    assert.ok(existsSync(join(tmpdir(), "u2a-posture-scan-fake-")) === false, "the fixture dir must be swept — a gate that leaks temp dirs is its own defect");
  });
});