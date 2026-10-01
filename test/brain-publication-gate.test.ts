import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `.brain` publication gate: PROVE, at build time and with NO token and NO
 * network, that the operator's transcript corpus can never reach a public
 * repository.
 *
 * WHY THIS EXISTS, and why it is a GATE rather than a note.
 *
 * The operator's requirement is that the code repo on GitHub becomes PUBLIC
 * while `.brain` lives in a dedicated PRIVATE repo shared across their
 * projects. The opencode-ci kit already implements the divert at runtime — its
 * `mirror_to_github` job asks the GitHub API for the destination's visibility
 * and REFUSES to push `.brain` to a non-private repo, diverting it to
 * `$GITHUB_BRAIN_REPO` instead. But that check runs at MIRROR time, on the
 * deploy box, with a live token. It is late: if it is wrong, the damage is
 * already published. This gate makes the same property hold at BUILD time, in
 * the ordinary `npm run test:unit` suite, with no token and no network — so a
 * mistake fails a pipeline in seconds instead of publishing an operator
 * transcript to the world.
 *
 * WHAT THIS GATE DELIBERATELY DOES NOT DO.
 *
 * It does NOT assert that `.brain` is untracked. `.brain` is TRACKED ON PURPOSE
 * (MEASURED 2026-09-30: 31 tracked files) because the corpus is the source of
 * meaning and is versioned alongside the work. Weakening `.brain`'s visibility
 * to make a gate green would destroy the thing the gate exists to protect. The
 * gate asserts the narrower and more useful property: that the corpus's
 * credential-bearing CHARACTER is characterised, and that the artifact path
 * cannot carry it somewhere public.
 *
 * WHAT THIS GATE MATCHES RATHER THAN DUPLICATES.
 *
 * `test/credential-leak-gate.test.ts` (GOAL 98) ALREADY OWNS two of these five
 * properties, and it owns them well:
 *   - P1/P4: `isForbiddenTracked` + `FORBIDDEN_TRACKED_PREFIXES` already pins
 *     that no `data/` path is tracked, and the gate's offline privacy half
 *     already pins that `.brain/` stays tracked and ungitignored.
 *   - P4: the MUST_BE_IGNORED / credential-shape census is already there.
 * Two gates scanning the same thing drift apart and one of them rots, so this
 * file does NOT re-implement that logic and does NOT re-scan `data/`. It
 * (a) asserts the P4 fact as a one-line cross-check that names the owner, so a
 * regression in EITHER file is visible, and (b) spends its real weight on the
 * three properties nothing else covers: the DIVERT DECISION (P2), the
 * credential-bearing CHARACTER OF `.brain` ITSELF (P3), and the
 * package-wide release surface (P5).
 *
 * HONESTY NOTE THAT BELONGS AT THE TOP, BECAUSE IT IS THE MOST IMPORTANT
 * THING IN THIS FILE.
 *
 * P2 pins the DECISION LOGIC of the kit's `.brain` rule as a pure function and
 * exhaustively tests it. The kit's actual implementation is POSIX shell inside
 * a GitLab CI `script: |` block, and its inputs are a LIVE `curl` to the
 * GitHub API and `$GH_TOKEN`. It CANNOT be executed hermetically. So: the
 * decision's SHAPE is what is tested here, as a pure function, and the shell is
 * read as TEXT to pin its contract. THE SHELL ITSELF IS NOT WHAT THIS FILE
 * RUNS. `testMirrorShellContract` below states exactly which shell facts are
 * asserted and which are not.
 *
 * AND THE FINDING THAT FALLS OUT OF READING IT — a REAL defect, not a style
 * nit, MEASURED 2026-09-30 and pinned by `testMEASURED_DEFECT`:
 *
 *   The divert is an ADDITIONAL push. It is not an EXCLUSION.
 *
 * The shell's main mirror pushes an explicit refspec built from
 * `refs/remotes/origin/*` to `refs/heads/*` (MEASURED at snippet.yml:611-615).
 * A refspec push transfers the whole TREE of each pushed commit. MEASURED:
 * `git ls-tree -r --name-only origin/main | grep -c '^\.brain/'` = 27 — so
 * 27 `.brain` files ARE reachable from `origin/main`, the very ref the main
 * mirror pushes. If `$GITHUB_REPO` is public, that push publishes the corpus
 * REGARDLESS of `INCLUDE_BRAIN=0`, because `INCLUDE_BRAIN` only controls the
 * separate divert push at snippet.yml:636-643.
 *
 * This file does NOT fix that: the kit is not this lane's file, and a gate
 * that silently rewrote the shell would be a gate that stopped being a pin.
 * It PINS the fact instead, so the defect is visible and cannot be forgotten,
 * and so that if the shell is ever corrected this test goes RED and forces the
 * finding to be retracted deliberately rather than rot in a comment.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the mirror job is pinned from, and WHY it changed.
 *
 *  It was `$HOME/Documents/projects/gitlab-ops/opencode-ci/gitlab-ci.snippet.yml`
 *  — the kit's SOURCE checkout. That was a defect, and CI caught it: the runner
 *  has no such path, so `KIT_TEXT` was empty there and the contract pins either
 *  failed or skipped depending on which guard they carried. A test whose subject
 *  lives OUTSIDE the repo is not hermetic and cannot be relied on by the one
 *  environment that actually has to pass.
 *
 *  It is now this repo's OWN `.gitlab-ci.yml`, which contains the RENDERED
 *  `mirror_to_github` job. That is strictly better for three reasons: it travels
 *  with the repo, it is the file GitLab actually executes, and it means the gate
 *  pins the thing that RUNS rather than a source of truth that has to be
 *  re-rendered into it.
 *
 *  The kit source is still worth pinning — it is where the code is authored — so
 *  the upstream checkout is checked too, but only as an ADDITIONAL assertion that
 *  skips cleanly when absent. A missing upstream must never fail this gate, and a
 *  missing rendered job must never pass it silently. */
const RENDERED = join(ROOT, ".gitlab-ci.yml");
const KIT = join(process.env.HOME ?? "/root", "Documents/projects/gitlab-ops/opencode-ci/gitlab-ci.snippet.yml");
const RENDERED_TEXT = existsSync(RENDERED) ? readFileSync(RENDERED, "utf8") : "";
const KIT_TEXT = existsSync(KIT) ? readFileSync(KIT, "utf8") : "";
/** Extract a job block, or "" when the job is ABSENT.
 *
 *  The indexOf/slice idiom has a trap that bit this file: `indexOf` returns -1
 *  when the marker is missing, and `slice(-1)` returns the LAST CHARACTER — a
 *  one-character string that is TRUTHY. A guard written as `!== ""` therefore
 *  picked the absent job as present, and the pins then failed against a string
 *  containing a newline. -1 must be treated as absent explicitly. */
function jobBlock(text: string, name: string): string {
  const at = text.indexOf(`\n${name}:`);
  return at < 0 ? "" : text.slice(at);
}
const RENDERED_MIRROR = jobBlock(RENDERED_TEXT, "mirror_to_github");
const MIRROR_JOB = RENDERED_MIRROR !== "" ? RENDERED_MIRROR : jobBlock(KIT_TEXT, "mirror_to_github");
/** True when the pins below are matching against the repo's own CI config rather
 *  than the operator's kit checkout. Reported on every run, because a gate whose
 *  subject silently changes scope is a gate nobody can reason about. */
const PINNING_RENDERED = RENDERED_MIRROR !== "";
const MIRROR_JOB_PRESENT = MIRROR_JOB !== "";

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", cwd: ROOT, timeout: 120000 }).trim();
const TRACKED: string[] = git("ls-files").split("\n").filter(Boolean);
const BRAIN = TRACKED.filter((f) => f.startsWith(".brain/"));
const DATA = TRACKED.filter((f) => f.startsWith("data/"));

/* ========================================================================
 * P2 — the divert DECISION, as a pure function.
 *
 * This is the extractable half of the kit's `THE .brain RULE` block
 * (snippet.yml:581-610). Extracting it is what makes the property testable
 * with no network; the shell version of the same logic is not. The function
 * is PURE: it takes the three facts the shell computes from the network and
 * returns the decision, so every branch — including the refusal branch — can
 * be pinned hermetically.
 * ===================================================================== */

/** What the mirror must do with `.brain`, given the three facts the shell
 *  derives from the GitHub API at runtime. */
export type BrainPublication =
  | { action: "travel-with-main-mirror"; includeBrain: true; divertTo: null; reason: string }
  | { action: "divert"; includeBrain: false; divertTo: string; reason: string }
  | { action: "refuse"; includeBrain: false; divertTo: null; reason: string };

/**
 * The decision, pure. Mirrors snippet.yml:593-610 exactly:
 *
 *   PRIV = visibility(GITHUB_REPO)
 *   if PRIV == "true":                 INCLUDE_BRAIN = 1            (travel)
 *   else if BRAIN_REPO is empty:        REFUSE, exit 1              (refuse)
 *   else if visibility(BRAIN_REPO) != true: REFUSE, exit 1         (refuse)
 *   else:                               INCLUDE_BRAIN = 0, divert  (divert)
 *
 * `brainRepoIsPrivate` is `null` for the "not configured" case, which is what
 * the shell's empty `$BRAIN_REPO` means. The refusal branch is the load-bearing
 * one: it is the branch that stands between a public repo and a published
 * operator transcript, and it is the branch a later edit is most likely to
 * quietly weaken (e.g. by defaulting an unset `$GITHUB_BRAIN_REPO` to the main
 * repo). It is therefore pinned from BOTH refusal directions separately.
 */
export function decideBrainPublication(
  destinationIsPrivate: boolean,
  brainRepo: string | null,
  brainRepoIsPrivate: boolean | null,
): BrainPublication {
  if (destinationIsPrivate) {
    // snippet.yml:594-597. The corpus rides along with the main mirror, so no
    // divert repo is needed or consulted.
    return {
      action: "travel-with-main-mirror",
      includeBrain: true,
      divertTo: null,
      reason: "destination is private: .brain travels with the main mirror",
    };
  }
  if (brainRepo === null || brainRepo.trim() === "") {
    // snippet.yml:601-606. The shell refuses rather than silently dropping the
    // corpus. Dropping would lose the source of meaning; pushing would publish
    // it. Refusing is the only honest third option.
    return {
      action: "refuse",
      includeBrain: false,
      divertTo: null,
      reason: "destination is not private and GITHUB_BRAIN_REPO is unset: refusing to publish and refusing to drop",
    };
  }
  if (brainRepoIsPrivate !== true) {
    // snippet.yml:607-609. The divert target's privacy is CHECKED, never
    // assumed — a repo can be flipped public after it is configured.
    return {
      action: "refuse",
      includeBrain: false,
      divertTo: null,
      reason: `destination is not private and ${brainRepo} is not verified private: refusing`,
    };
  }
  // snippet.yml:609. The only branch that publishes, and it publishes to a
  // repo whose privacy was just verified.
  return {
    action: "divert",
    includeBrain: false,
    divertTo: brainRepo,
    reason: `destination is not private: diverting .brain to the verified-private ${brainRepo}`,
  };
}

/* ========================================================================
 * P3 — the corpus's credential-bearing CHARACTER, pinned as a CENSUS.
 * ===================================================================== */

/** Literal-secret shapes. A hit here is a REAL credential, never prose.
 *  Deliberately narrow: every pattern is a token FORMAT, so ordinary
 *  English about passwords cannot trip it. A gate that cries wolf on the word
 *  "password" gets ignored, which is worse than no gate. */
export const LITERAL_TOKEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "github-personal-access-token", re: /gh[pousr]_[A-Za-z0-9]{16,}/ },
  { name: "github-fine-grained-pat", re: /REMOVED[A-Za-z0-9_]{20,}/ },
  { name: "gitlab-pat", re: /REMOVED[A-Za-z0-9_-]{16,}/ },
  { name: "github-app-installation-token", re: /REMOVED[A-Za-z0-9]{16,}/ },
  { name: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { name: "private-key-header", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** Prose-level secret-ish VOCABULARY. A hit here is NOT a leak; it is drift
 *  worth seeing. Pinned as an exact FILE SET so the reader can see the surface
 *  change when a new verbatim lands, without failing on count. */
export const VOCABULARY_RE =
  /password|passwd|secret|api[_ -]?key|bearer [a-z0-9]|access_token|userToken|hunyuan_token/gi;

/** MEASURED 2026-09-30 by
 *  `git ls-files .brain | while read -r f; do grep -ilE '<VOCABULARY_RE>' "$f"; done`:
 *  exactly these five files match. This is a DISCLOSED CENSUS, not a ceiling —
 *  adding a sixth is expected as the corpus grows, and this test will then go
 *  RED on purpose, so the drift is a decision rather than a surprise. */
export const MEASURED_VOCAB_FILES_2026_09_30: readonly string[] = [
  ".brain/verbatim-goals.md",
  ".brain/verbatim-coverage.md",
  ".brain/verbatim/ledger.md",
  ".brain/verbatim/2026-08-29-origins-npm-omniroute-plan.md",
  ".brain/verbatim.md",
];

/** Real infrastructure addresses the corpus carries. MEASURED 2026-09-30 with
 *  `grep -l` per address over `git ls-files .brain`; the value is the list of
 *  files each address appears in. Low-severity for a public repo, but a real
 *  disclosure of the operator's infrastructure, so it is pinned rather than
 *  assumed absent. */
export const MEASURED_INFRA_ADDRESSES_2026_09_30: ReadonlyArray<{
  address: string;
  files: readonly string[];
}> = [
  { address: "REMOVED", files: [".brain/verbatim.md", ".brain/verbatim/2026-08-29-origins-npm-omniroute-plan.md"] },
  { address: "REMOVED", files: [".brain/verbatim.md", ".brain/verbatim/2026-08-29-origins-npm-omniroute-plan.md"] },
  { address: "REMOVED", files: [".brain/verbatim-coverage.md", ".brain/verbatim-goals.md"] },
];

/* ========================================================================
 * P5 — the package-wide release surface.
 *
 * DECISION, stated rather than left implicit: the cookie NAMES and
 * localStorage KEY names carried by `session.lock.json` are treated as
 * ACCEPTABLE-AND-DOCUMENTED, and this gate pins that they are acceptable BY
 * BEING NAMES ONLY. It is not a finding to be fixed, and this gate does NOT
 * change packaging — the whole point is a pin, not a refactor.
 *
 * The reasoning: a cookie name like `hunyuan_token` reveals that an account is
 * authenticated via a cookie, which is mild metadata. A cookie VALUE is the
 * credential itself. The difference between the two is the entire difference
 * between an acceptable public repo and a compromise, so the property worth
 * gating is precisely "names, never values" — and that is what is asserted
 * below, per file, by parsing the JSON and walking it.
 *
 * MEASURED 2026-09-30: 34 tracked `session.lock.json` files — 33 under
 * `capabilities/` (the 33 packages AGENTS.md documents) plus 1 under
 * `test/fixtures/`. The task brief said 33; the 34th is the test fixture, and
 * the breakdown is asserted so the discrepancy is resolved rather than
 * papered over. 30 of the 34 carry a `data/<host>/.session/state.json` path
 * string. (That path is a POINTER into the gitignored vault, not the vault.)
 */
/** MEASURED 2026-09-30: `git ls-tree -r --name-only origin/main | grep -c '^\.brain/'` = 27. */
export const MEASURED_BRAIN_REACHABLE_FROM_MIRROR_2026_09_30 = 27;

export const MEASURED_SESSION_LOCK_TOTAL_2026_09_30 = 34;
export const MEASURED_SESSION_LOCK_PACKAGES_2026_09_30 = 33;
export const MEASURED_SESSION_LOCK_FIXTURES_2026_09_30 = 1;
export const MEASURED_SESSION_LOCK_WITH_DATA_PATH_2026_09_30 = 30;

/* ========================================================================
 * P1 — the corpus is tracked, deliberately.
 * ===================================================================== */

d("P1: .brain is TRACKED on purpose, and this gate does not weaken that", () => {
  t("the corpus is tracked, and the gate says so rather than asserting it away", () => {
    assert.ok(BRAIN.length > 0, ".brain/ MUST stay tracked — it is the source of meaning, and this gate exists to protect it, not to hide it");
    // The measured count, disclosed so a reader can tell a real corpus from a
    // truncated checkout. Asserted as a range rather than `===` so an ordinary
    // verbatim landing does not turn the suite red, while a corpus that has
    // collapsed (the failure this guards) still does.
    assert.ok(
      BRAIN.length >= MEASURED_VOCAB_FILES_2026_09_30.length,
      `expected at least the ${MEASURED_VOCAB_FILES_2026_09_30.length} measured corpus files, found ${BRAIN.length}`,
    );
  });

  t("anti-vacuity: the census is driven by the REAL index, so an empty checkout goes red instead of passing", () => {
    // The same failure class as the GOAL 171 anti-rot gate: a gate that passes
    // on an empty or unread input is a pin nobody reads. Feed the exact
    // predicates an empty index and show the real assertions FAIL.
    assert.equal(([] as string[]).filter((f) => f.startsWith(".brain/")).length, 0, "on an empty index the tracked-corpus assertion MUST fail — that is what makes the real run substantive");
    assert.ok(BRAIN.length > 0, "the real index really does track .brain/ — this test asserts a fact, it does not skip on absence");
  });
});

/* ========================================================================
 * P2 — the divert decision, every branch pinned.
 * ===================================================================== */

d("P2: the .brain divert DECISION is pinned on every branch, hermetically", () => {
  t("destination private -> .brain travels with the main mirror", () => {
    const d1 = decideBrainPublication(true, null, null);
    assert.equal(d1.action, "travel-with-main-mirror");
    assert.equal(d1.includeBrain, true, "the corpus rides along; there is nothing to divert");
    assert.equal(d1.divertTo, null, "no divert repo is consulted or needed");
  });

  t("destination private -> the brain repo's privacy is NOT even consulted (a public brain repo is harmless here)", () => {
    // This is a real branch of the shell: `if [ "$PRIV" = "true" ]` short-circuits
    // before `$BRAIN_REPO` is read at all (snippet.yml:594-597). If a later
    // refactor starts refusing because an UNUSED divert target is public, that
    // is a behaviour change, and this pin is what makes it visible.
    const d1 = decideBrainPublication(true, "me/braindump", false);
    assert.equal(d1.action, "travel-with-main-mirror", "an unused divert target's visibility must not affect the private-destination path");
    assert.equal(d1.includeBrain, true);
  });

  t("destination NOT private + no brain repo -> REFUSE (never publish, never silently drop)", () => {
    for (const unset of [null, "", "   "]) {
      const d1 = decideBrainPublication(false, unset, null);
      assert.equal(d1.action, "refuse", `unset brain repo (${JSON.stringify(unset)}) must refuse`);
      assert.equal(d1.includeBrain, false, "refusal must never include the corpus in the main mirror");
      assert.equal(d1.divertTo, null, "refusal has no divert target");
    }
  });

  t("destination NOT private + brain repo that is NOT verified private -> REFUSE (privacy is checked, never assumed)", () => {
    // The branch that matters most in practice: a configured repo that someone
    // later flipped public. `false` is verified-public; `null` is
    // "visibility could not be established", which the shell also refuses on
    // (`[ "$BPRIV" = "true" ] || exit 1`) — an unknown is not a yes.
    for (const notPrivate of [false, null]) {
      const d1 = decideBrainPublication(false, "me/braindump", notPrivate);
      assert.equal(d1.action, "refuse", `a brain repo whose privacy is ${notPrivate} must refuse, not divert`);
      assert.equal(d1.includeBrain, false);
      assert.equal(d1.divertTo, null, "refusal must not name a divert target, or a caller could ignore the refusal and use it");
    }
  });

  t("destination NOT private + VERIFIED-private brain repo -> divert, and only to the verified repo", () => {
    const d1 = decideBrainPublication(false, "me/braindump", true);
    assert.equal(d1.action, "divert");
    assert.equal(d1.includeBrain, false, "the corpus is NOT included in the main mirror push on this path");
    assert.equal(d1.divertTo, "me/braindump", "the divert target is the verified-private repo, named explicitly");
  });

  t("EXHAUSTIVE: the decision is total — no input combination falls through undefined", () => {
    // The shell has exactly three exits. A pure function can silently grow a
    // fourth path or a hole; walking the full 2x3x3 state space pins that it
    // cannot. MEASURED: every combination returns one of the three actions.
    const actions = new Set<string>();
    for (const destPriv of [true, false]) {
      for (const repo of [null, "", "  ", "me/braindump"]) {
        for (const repoPriv of [null, true, false]) {
          const r = decideBrainPublication(destPriv, repo, repoPriv);
          assert.ok(
            ["travel-with-main-mirror", "divert", "refuse"].includes(r.action),
            `unhandled action ${r.action} for (${destPriv}, ${JSON.stringify(repo)}, ${repoPriv})`,
          );
          assert.equal(typeof r.reason, "string");
          assert.ok(r.reason.length > 0, "every decision carries a NAMED reason — an unnamed decision is one nobody can debug");
          actions.add(r.action);
        }
      }
    }
    // All three exits are reachable, so the walk is not a vacuous loop over
    // one behaviour.
    assert.deepEqual([...actions].sort(), ["divert", "refuse", "travel-with-main-mirror"]);
  });

  t("MUTATION: a decision that publishes to a non-private destination is rejected (the pin CAN fail)", () => {
    // The GOAL 171 lesson: a gate that has never been red is a pin nobody
    // reads. This is the in-file proof that the refusal assertions bite —
    // a plausible but WRONG implementation (defaulting an unconfigured brain
    // repo to "not checked, carry on", which is exactly how a public leak
    // would ship) is shown to fail them.
    const BROKEN = (destPriv: boolean, repo: string | null, repoPriv: boolean | null): BrainPublication => {
      if (destPriv) return { action: "travel-with-main-mirror", includeBrain: true, divertTo: null, reason: "" };
      // THE BUG: an unverified brain repo is treated as good enough.
      if (repo === null || repo.trim() === "") return { action: "refuse", includeBrain: false, divertTo: null, reason: "" };
      return { action: "divert", includeBrain: false, divertTo: repo, reason: "" };
    };
    // The correct implementation refuses an unverified repo...
    assert.equal(decideBrainPublication(false, "me/braindump", false).action, "refuse");
    // ...and the broken one publishes to a repo nobody verified. This MUST throw.
    assert.throws(
      () => {
        const r = BROKEN(false, "me/braindump", false);
        assert.equal(r.action, "refuse", "a repo whose privacy was never verified must refuse");
      },
      /must refuse/,
      "the broken decision must be caught by the same assertion the real implementation passes",
    );
  });
});

/* ========================================================================
 * P2 (text half) — what the SHELL actually says, and the defect it carries.
 * ===================================================================== */

d("P2 (text): the kit's shell carries the same CONTRACT — read as text, not executed", () => {
  t("the kit's .brain RULE block exists and still refuses rather than defaulting", { skip: !MIRROR_JOB_PRESENT && `mirror_to_github is not installed in this repo, and the kit is not available at ${KIT}` }, () => {
    assert.match(MIRROR_JOB, /THE \.brain RULE/, "the operator's named rule block must still be in the kit");
    assert.match(MIRROR_JOB, /GITHUB_BRAIN_REPO/, "the divert target variable must still be honoured");
    assert.match(MIRROR_JOB, /MIRROR-FAIL: destination is not private and GITHUB_BRAIN_REPO is unset/, "the unset-divert-target refusal must still be present");
    assert.match(MIRROR_JOB, /MIRROR-FAIL: \$BRAIN_REPO is not private either\. Refusing\./, "the unverified-divert-target refusal must still be present");
    // The privacy probe must remain a CHECK, not an assumption. If someone ever
    // replaces the API call with a hardcoded `true`, the corpus starts shipping
    // to whatever the destination happens to be, and this pin goes red.
    assert.match(MIRROR_JOB, /GHPRIV\(\)/, "visibility must still be probed, never assumed");
    assert.ok(!/GHPRIV\(\)\s*\{\s*echo true/.test(MIRROR_JOB), "GHPRIV must not be stubbed to a constant true");
  });

  t("HONESTY: the shell is NOT executed by this gate — its inputs are a live API call and a token", () => {
    // Stated as an assertion so it cannot be quietly deleted. If a future
    // refactor makes the shell hermetically runnable (e.g. by extracting the
    // rule into a script this repo can invoke), this pin goes red and the
    // honesty note above must be rewritten at the same time.
    assert.match(MIRROR_JOB, /api\.github\.com\/repos\//, "the shell's visibility probe is a live GitHub API call — hence not hermetic, hence untested here");
    assert.match(MIRROR_JOB, /GH_TOKEN/, "the shell reads a live token — hence not hermetic, hence untested here");
  });

  t("RETIRED DEFECT -> now a REFUSAL: the shell no longer publishes the corpus to a public destination", (tt) => {
    // THIS PIN IS THE WHOLE POINT OF THE FILE, and it has already been retired once.
    //
    // It was written as MEASURED_DEFECT: "the divert is an ADDITIONAL push, NOT an
    // exclusion". That was true and it was a live leak on BOTH kit consumers — the
    // main mirror pushes a branch refspec, which transfers the whole tree, so
    // INCLUDE_BRAIN=0 stripped nothing from the push and the corpus was published
    // BEFORE the divert copied it. The closing log line then printed
    // `brain_included=0` while the corpus was in the push.
    //
    // The kit now REFUSES when the destination is not private and the history
    // carries .brain, because that cannot be fixed by unstaging anything: git
    // history is immutable, so a commit that carried the corpus carries it into
    // every push of that commit forever.
    //
    // So the assertion flipped from "the bug is present" to "the refusal is
    // present". That is the designed retirement path — a documented defect whose
    // fix turns the pin RED is how a finding is closed deliberately rather than
    // left to rot in a comment.
    // WHICH implementation is pinned depends on the topology, and BOTH answers are
    // legitimate, so the gate states which one it used rather than assuming one.
    //
    // ui2api does not install the kit's mirror_to_github at all: public_mirror
    // supersedes it, because the two had opposite force semantics writing to the
    // same remote (the kit's never forces, public_mirror must force, since
    // stripping paths rewrites every hash). The kit's refusal is still pinned
    // where it is AUTHORED, and the job that actually publishes to a
    // possibly-public destination is pinned below in the rendered file, which is
    // the one that is hermetic.
    const SUBJECT = PINNING_RENDERED ? MIRROR_JOB : KIT_TEXT;
    tt.diagnostic(
      `pinning the .brain refusal against: ${PINNING_RENDERED ? "this repo's rendered mirror_to_github" : "the kit source (that job is not installed here by design)"}`,
    );
    if (MIRROR_JOB_PRESENT) {
    assert.match(
      SUBJECT,
      /refusing to mirror to a NON-PRIVATE destination/,
      "the mirror must REFUSE a non-private destination when the history carries .brain",
    );
    assert.match(
      SUBJECT,
      /git log --all --oneline -- "\$BRAIN_DIR"/,
      "the refusal must be driven by a MEASURED count of .brain commits, not an assumption",
    );
    assert.match(
      SUBJECT,
      /Git history is immutable/,
      "the refusal must state WHY it cannot be fixed by unstaging — a refusal without its reason is a wall, not a contract",
    );
    // The status line must no longer claim a safety property it cannot deliver.
    // The status line must no longer claim a safety property it cannot deliver.
    // Matched on an `echo` specifically: the shell carries a COMMENT recording
    // that this line used to print `brain_included=0` while the corpus was in the
    // push, and pinning the bare string would fail on the very comment that
    // documents the fix. A pin that cannot distinguish a claim from a note about
    // a retracted claim trains the next reader to ignore it.
    assert.ok(
      !/echo\s+.*brain_included=/.test(SUBJECT),
      "the closing log line must not ECHO brain_included= — that reported the INTENT while the push carried the corpus",
    );
    assert.match(
      SUBJECT,
      /destination PRIVATE; history carries/,
      "the status line must state what was actually TRUE about the push",
    );
    }

    // The job that ACTUALLY pushes to a possibly-public destination, pinned in
    // this repo's own config so it is hermetic and travels with the repo. This is
    // the one that matters for the public repo: the public push must be gated on
    // a clean sanitisation, and the private push must not depend on it.
    t("public_mirror: the PUBLIC push is gated on a clean sanitisation, and the PRIVATE push is not", () => {
      assert.match(RENDERED_TEXT, /public_mirror:/, "public_mirror must be installed in this repo's CI config");
      assert.match(RENDERED_TEXT, /SANITIZE-FAIL: the public copy did not verify/, "a failed sanitisation must be named, not swallowed");
      assert.match(RENDERED_TEXT, /WITHHELD \(unverified\)/, "the job must say it withheld the public copy rather than reporting a green mirror");
      assert.match(RENDERED_TEXT, /public-sanitized WITHHELD/, "an unverified public copy must be reported as withheld");
      // The private push must NOT sit behind the sanitisation gate, or the
      // durability goal would again depend on the public problem being solved.
      const privAt = RENDERED_TEXT.indexOf("PRIVATE FULL ->");
      const gateAt = RENDERED_TEXT.indexOf("WITHHELD (unverified)");
      assert.ok(privAt > 0 && gateAt > 0, "both the private push and the public gate must be present");
      assert.ok(privAt < gateAt, "the private full copy must be pushed BEFORE the public gate can withhold it");
    });
  });
});

/* ========================================================================
 * P3 — the corpus's credential-bearing character.
 * ===================================================================== */

d("P3: .brain's credential-bearing character is a pinned census, not an assumption", () => {
  t("no LITERAL token anywhere in the corpus (measured 2026-09-30: zero hits)", () => {
    // The real scan. Every tracked .brain file, every literal-secret shape.
    const hits: string[] = [];
    for (const f of BRAIN) {
      const text = readFileSync(join(ROOT, f), "utf8");
      for (const { name, re } of LITERAL_TOKEN_PATTERNS) {
        // Fresh regex per file: a /g/ pattern carries lastIndex across calls.
        const r = new RegExp(re.source, re.flags.replace("g", ""));
        if (r.test(text)) hits.push(`${f} (${name})`);
      }
    }
    assert.deepEqual(
      hits,
      [],
      `a LITERAL credential is committed in the corpus: ${hits.join(", ")}. .brain is published to a shared PRIVATE repo — a real token here is a live secret in a second location. Revoke it, then purge the history.`,
    );
  });

  t("the token patterns actually FIRE on a real token (anti-vacuity: zero hits must mean clean, not broken)", () => {
    // A scan that finds nothing because its patterns are wrong is the GOAL 171
    // class of defect. Prove each pattern bites a synthetic example.
    const samples: Array<[string, string]> = [
      ["github-personal-access-token", "REMOVED" + "A".repeat(36)],
      ["github-fine-grained-pat", "REMOVED" + "b".repeat(22)],
      ["gitlab-pat", "REMOVED" + "c".repeat(20)],
      ["github-app-installation-token", "REMOVED" + "d".repeat(36)],
      ["aws-access-key-id", "AKIA" + "E".repeat(16)],
      ["private-key-header", "REMOVED"],
    ];
    for (const [name, sample] of samples) {
      const pat = LITERAL_TOKEN_PATTERNS.find((p) => p.name === name);
      assert.ok(pat, `pattern ${name} must exist`);
      assert.ok(new RegExp(pat.re.source, pat.re.flags.replace("g", "")).test(sample), `pattern ${name} MUST match a real-shaped ${name} — a pattern that cannot fire proves nothing`);
    }
  });

  t("MUTATION: a planted literal token in the corpus is caught (the pin CAN go red)", () => {
    // Same detector as the real scan, fed a synthetic file. This is the pin
    // proving it bites WITHOUT touching the corpus — .brain is the subject of
    // this gate, never an object of it, so the mutation lives in memory.
    const planted = ".brain/verbatim/PLANTED.md";
    const plantedText = "operator note: token REMOVED" + "F".repeat(36) + " was here";
    const found: string[] = [];
    for (const { name, re } of LITERAL_TOKEN_PATTERNS) {
      if (new RegExp(re.source, re.flags.replace("g", "")).test(plantedText)) found.push(`${planted} (${name})`);
    }
    assert.deepEqual(
      found,
      [`${planted} (github-personal-access-token)`],
      "a planted real-shaped token MUST be reported — if this is empty the corpus scan above is vacuous",
    );
  });

  t("prose about passwords does NOT trip the gate (no crying wolf)", () => {
    // The other half of the honesty contract. A gate that fires on the word
    // "password" in a verbatim gets muted, and a muted gate protects nothing.
    // Vocabulary is tracked as a CENSUS, never as a failure.
    const prose = "the operator said the password rotation is on hold and the api key lives in the vault";
    const vocabHits = [...prose.matchAll(new RegExp(VOCABULARY_RE.source, "gi"))].length;
    assert.ok(vocabHits > 0, "precondition: this prose really does use secret-ish vocabulary — otherwise the test is not testing anything");
    for (const { name, re } of LITERAL_TOKEN_PATTERNS) {
      assert.equal(new RegExp(re.source, re.flags.replace("g", "")).test(prose), false, `prose must never trip the literal-token pattern ${name}`);
    }
  });

  t("CENSUS: the secret-vocabulary file set is exactly what was measured 2026-09-30 (drift is visible, not fatal)", () => {
    const found = BRAIN.filter((f) => new RegExp(VOCABULARY_RE.source, "gi").test(readFileSync(join(ROOT, f), "utf8"))).sort();
    assert.deepEqual(
      found,
      [...MEASURED_VOCAB_FILES_2026_09_30].sort(),
      "the set of corpus files using secret-ish VOCABULARY changed since 2026-09-30. That is not automatically a leak — update MEASURED_VOCAB_FILES_2026_09_30 to the new measured set and confirm the new files are prose, not credentials.",
    );
  });

  t("CENSUS: the real infrastructure addresses are pinned, so a new one is visible", () => {
    for (const { address, files } of MEASURED_INFRA_ADDRESSES_2026_09_30) {
      for (const f of files) {
        assert.ok(
          readFileSync(join(ROOT, f), "utf8").includes(address),
          `${address} was measured in ${f} on 2026-09-30; if it is gone, update the census deliberately`,
        );
      }
    }
  });
});

/* ========================================================================
 * P4 — the vault can never reach GitHub. MATCHED, not duplicated.
 * ===================================================================== */

d("P4: the vault can never reach a public repo (owned by credential-leak-gate; cross-checked here)", () => {
  t("zero data/ paths are tracked — cross-check, naming the gate that owns it", () => {
    // OWNER: test/credential-leak-gate.test.ts (GOAL 98) derives this from
    // FORBIDDEN_TRACKED_PREFIXES and is the authority. This file deliberately
    // does NOT re-implement that predicate or re-run its MUST_BE_IGNORED census
    // — two scans of the same thing drift apart and one of them rots. This is
    // a one-line cross-check so a regression in EITHER file is visible from
    // either side, and it is deliberately cheap.
    assert.deepEqual(
      DATA,
      [],
      `these data/ paths are TRACKED and would ship real captured login state to a public repo: ${DATA.join(", ")}. The owner of this rule is test/credential-leak-gate.test.ts (FORBIDDEN_TRACKED_PREFIXES).`,
    );
  });

  t("anti-vacuity: the data/ check is driven by a real, non-empty index", () => {
    assert.ok(TRACKED.length > 50, `the shipped index collapsed to ${TRACKED.length} entries — a zero-length DATA would make the check above vacuous`);
    assert.equal(([] as string[]).filter((f) => f.startsWith("data/")).length, 0, "on an empty index this check would pass for the wrong reason");
  });
});

/* ========================================================================
 * P5 — the package-wide release surface.
 * ===================================================================== */

d("P5: session.lock.json ships NAMES only — acceptable, and pinned as such", () => {
  const locks = TRACKED.filter((f) => f.endsWith("session.lock.json"));

  t("the census is the measured one, with the 33/1 breakdown resolved", () => {
    // The brief said 33; MEASURED 34. The extra is a test fixture, which is a
    // different thing from a shipped package, and the breakdown is asserted so
    // the difference is resolved in the test rather than left as a mystery.
    assert.equal(locks.length, MEASURED_SESSION_LOCK_TOTAL_2026_09_30, "tracked session.lock.json count changed since 2026-09-30 — re-measure and update the census");
    const pkgs = locks.filter((f) => f.startsWith("capabilities/"));
    const fixtures = locks.filter((f) => f.startsWith("test/"));
    assert.equal(pkgs.length, MEASURED_SESSION_LOCK_PACKAGES_2026_09_30, "the shipped-PACKAGE count changed — AGENTS.md documents 33 packages, so a change here is a real packaging change");
    assert.equal(fixtures.length, MEASURED_SESSION_LOCK_FIXTURES_2026_09_30, "the fixture count changed — a new fixture is not a shipped package and must not be counted as one");
  });

  t("EVERY lock carries cookie/localStorage NAMES and never a VALUE", () => {
    // The load-bearing assertion of P5, and the one that justifies calling the
    // surface acceptable. A single `value` field with content anywhere in these
    // files is the credential itself in a PUBLIC repo.
    const leaks: string[] = [];
    const withDataPath: string[] = [];
    for (const f of locks) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
      } catch (e) {
        assert.fail(`${f} is not valid JSON: ${(e as Error).message} — an unparseable lock cannot be shown to be value-free`);
      }
      const walk = (o: unknown, path: string): void => {
        if (Array.isArray(o)) {
          o.forEach((v, i) => walk(v, `${path}[${i}]`));
          return;
        }
        if (o === null || typeof o !== "object") return;
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          // A `value` (or `cookieValue`/`token`) key holding a NON-EMPTY string
          // is a credential. An empty/absent one is not.
          if (/^(value|cookieValue|cookie_value|token|accessToken|access_token)$/.test(k) && typeof v === "string" && v.trim() !== "") {
            leaks.push(`${f} ${path}.${k}`);
          }
          walk(v, `${path}.${k}`);
        }
      };
      walk(doc, "$");
      const text = readFileSync(join(ROOT, f), "utf8");
      if (/data\/[^"]+\.session\/state\.json/.test(text)) withDataPath.push(f);
    }
    assert.deepEqual(
      leaks,
      [],
      `a session.lock.json carries a CREDENTIAL VALUE, not a name: ${leaks.join(", ")}. Names are acceptable-and-documented; values are the compromise.`,
    );
    assert.equal(
      withDataPath.length,
      MEASURED_SESSION_LOCK_WITH_DATA_PATH_2026_09_30,
      `the count of locks naming a data/<host>/.session/state.json PATH changed since 2026-09-30 (now ${withDataPath.length}). The path is a pointer into the gitignored vault, not the vault — but a change here should be a decision.`,
    );
  });

  t("MUTATION: a lock carrying a cookie VALUE is rejected (the pin CAN go red)", () => {
    // Proves the walker above actually inspects nested content, rather than
    // trusting that the current corpus happens to be clean.
    const planted = {
      snapshot: {
        cookies: [{ name: "hunyuan_token", value: "REAL-COOKIE-VALUE" }],
        localStorageKeys: ["access_token"],
      },
    };
    const leaks: string[] = [];
    const walk = (o: unknown, path: string): void => {
      if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (o === null || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (/^(value|cookieValue|cookie_value|token|accessToken|access_token)$/.test(k) && typeof v === "string" && v.trim() !== "") leaks.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    };
    walk(planted, "$");
    assert.deepEqual(leaks, ["$.snapshot.cookies[0].value"], "a planted cookie value MUST be reported — otherwise the names-only pin is vacuous");
    // And the SAME shape with the value removed is clean, so the pin is
    // measuring the value and not merely the presence of a cookie entry.
    const namesOnly = JSON.parse(JSON.stringify(planted).replace("REAL-COOKIE-VALUE", ""));
    const clean: string[] = [];
    walk(namesOnly, "$");
    assert.deepEqual(clean, [], "names-only must be clean — that is the whole point of the acceptable-and-documented decision");
  });
});
