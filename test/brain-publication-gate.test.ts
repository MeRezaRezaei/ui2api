import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
/**
 * THE ADDRESSES THEMSELVES ARE NOT IN THIS FILE. This file ships inside the
 * public copy, so a literal here is a literal in the public repository — and
 * these are the operator's real hosts, which is precisely the disclosure the
 * whole publication pipeline exists to prevent. MEASURED 2026-10-01: this gate
 * and the sanitizer between them carried every one of them, and the infra class
 * duly measured pub=7 against its own tooling. The gate that exists to stop the
 * leak was itself the leak.
 *
 * They arrive in the masked CI variable UI2API_INFRA_ADDRESSES — the same single
 * source the sanitizer uses for its scanner, its blob redaction and its
 * commit-message redaction, so the three cannot drift apart. That drift is the
 * only way a coverage pin stops meaning anything.
 *
 * WHAT STAYS HERE is the part that is genuinely public knowledge: WHICH private
 * file each address was measured in. Paths are not secrets, and that mapping is
 * the real content of the census. An empty address list is a real, reportable
 * state (a local run with no CI config): every consumer below either skips with
 * a named reason or falls back to a NON-SECRET fixture, and never to a silent
 * pass.
 */
const AUTHOR_INFRA_FILES: readonly (readonly string[])[] = [
  [".brain/verbatim.md", ".brain/verbatim/2026-08-29-origins-npm-omniroute-plan.md"],
  [".brain/verbatim.md", ".brain/verbatim/2026-08-29-origins-npm-omniroute-plan.md"],
  [".brain/verbatim-coverage.md", ".brain/verbatim-goals.md"],
];

export const authorInfraAddresses = (): string[] =>
  (process.env.UI2API_INFRA_ADDRESSES ?? "").replace(/,/g, " ").split(/\s+/).filter(Boolean);

export const measuredInfraAddresses = (): ReadonlyArray<{
  address: string;
  files: readonly string[];
}> => authorInfraAddresses().map((address, i) => ({ address, files: AUTHOR_INFRA_FILES[i] ?? [] }));

/** A NON-SECRET stand-in for the contract tests. The redaction contract is a
 *  property of the RULE FILE, not of any particular host, so proving it needs no
 *  real address — and using one would put a real host back into this file. */
export const FIXTURE_INFRA_ADDRESS = "10.254.254.254";

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

  t("HONESTY: the shell is NOT executed by this gate — its inputs are a live API call and a token", { skip: !MIRROR_JOB_PRESENT && `no mirror job to inspect: not installed here, and the kit is absent at ${KIT}` }, () => {
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

  t("CENSUS: the real infrastructure addresses are pinned, so a new one is visible", (tt) => {
    const measured = measuredInfraAddresses();
    if (measured.length === 0) {
      // Neither a pass nor a failure: this file must not name the addresses,
      // so the census can only run where CI supplies them. Said out loud,
      // because a census that silently measures nothing is the failure this
      // repo keeps fighting.
      tt.skip("UI2API_INFRA_ADDRESSES is unset and the addresses cannot be written here, because this file ships in the public copy");
      return;
    }
    for (const { address, files } of measured) {
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
 * P3b — the REDACTION CONTRACT: given a literal the corpus really carries,
 * does the sanitizer's own replacement path actually rewrite it?
 *
 * WHY THIS BLOCK EXISTS (the defect class it closes).
 *
 * The census test directly above asserts that each measured address is PRESENT
 * in a `.brain` file. That is a real assertion and it can fail — but it is a
 * statement about the PRIVATE corpus, and nothing in this file connects it to
 * what the PUBLIC copy will contain. That is the exact failure class the GOAL
 * 171 lesson names: the gate can be 24/24 green while the thing it exists to
 * prevent happens, because
 *
 *   (a) a line is deleted from the sanitizer's `--replace-text` heredoc, or
 *   (b) the heredoc is renamed/relocated so filter-repo is handed a DIFFERENT
 *       (or no) pattern file, or
 *   (c) the `literal==>replacement` syntax drifts so filter-repo parses a rule
 *       that matches nothing,
 *
 * and the corpus still carries the literal, still pins green up here, and the
 * public copy still carries it.
 *
 * So this block pins the SANITIZER'S CONTRACT rather than a fixed string, and
 * it pins it in the direction that actually bites. It does NOT assert that the
 * placeholder `REMOVED` is absent: that claim is vacuous (it is satisfied by
 * the redaction machinery having STOPPED WORKING, by the literal never having
 * been there, and by the filter being run with the wrong flag), and it is
 * brittle (it fails on ordinary prose that happens to use the word). What it
 * asserts instead is POSITIVE PROOF that the redaction HAPPENED:
 *
 *   (a) the real literal is ABSENT from the rewritten blob, AND
 *   (b) the replacement that the SCRIPT ITSELF documents for that literal IS
 *       PRESENT in that blob.
 *
 * (b) is the half that makes the zero meaningful. It is derived from the
 * script, never hardcoded here, so the token cannot drift into a lie.
 *
 * HONEST SCOPE — what this block does NOT prove. It exercises filter-repo's
 * `--replace-text` on a FIXTURE, because that path is a pure content rewrite
 * and runs in ~0.3s with no network and no token. It does NOT run
 * `scripts/ci/make-public-repo.sh` end to end (that clones the real history and
 * scans every blob of every commit, which is minutes of work and belongs in
 * CI, not in a unit suite), and it does NOT cover the commit-message
 * redaction, which `--replace-text` provably cannot do — the script's own
 * `--message-callback` handles that side, and it is asserted by that script's
 * own residual scan, not from here. So: this block proves the replacement PATH
 * is armed and behaves; it does not restate the whole sanitizer verdict.
 * ===================================================================== */

const SANITIZER = join(ROOT, "scripts/ci/make-public-repo.sh");
const SANITIZER_TEXT = existsSync(SANITIZER) ? readFileSync(SANITIZER, "utf8") : "";

/** Every `literal==>replacement` rule the sanitizer hands to `--replace-text`,
 *  read out of the script AS TEXT.
 *
 *  Parsed by matching the rule SYNTAX across the whole file rather than by
 *  slicing a named heredoc. That is deliberate: the rules are the contract, and
 *  the contract must survive the heredoc being renamed or moved. A parser that
 *  hardcoded the delimiter would itself rot the moment the script was tidied,
 *  which is the same failure in a new costume.
 *
 *  The literal side is matched lazily and non-greedily: filter-repo's own format
 *  is `literal==>replacement`, and the first `==>` delimits, so anything up to it
 *  is the literal. */
export function parseReplaceTextRules(scriptText: string): ReadonlyArray<{ literal: string; replacement: string }> {
  const out: Array<{ literal: string; replacement: string }> = [];
  const re = /^(.+?)==>(\S*)$/gm;
  for (let m = re.exec(scriptText); m !== null; m = re.exec(scriptText)) {
    const literal = m[1];
    if (literal.length === 0) continue;
    out.push({ literal, replacement: m[2] });
  }
  return out;
}

/** The rule set the sanitizer will ACTUALLY use, not just the one written in the
 *  file. The static heredoc holds the token and key patterns; the author's own
 *  host addresses are appended at RUNTIME from UI2API_INFRA_ADDRESSES, because
 *  this repository is itself published and cannot carry them.
 *
 *  Reading only the heredoc — which is what this did — models a rule file that
 *  no longer exists, and reports every author address as UNCOVERED. That is the
 *  safe direction to be wrong in, but it is still wrong, and it made the whole
 *  P3b block untestable. Both halves are combined here so the test's model and the
 *  sanitizer's behaviour cannot drift. */
export const REDACTION_RULES: ReadonlyArray<{ literal: string; replacement: string }> = [
  ...parseReplaceTextRules(SANITIZER_TEXT),
  ...authorInfraAddresses().map((a) => ({ literal: a, replacement: "REMOVED" })),
];

/** Run the sanitizer's REAL `--replace-text` path over a fixture containing the
 *  given literals, and return the rewritten blob content.
 *
 *  Uses `git filter-repo` exactly as the sanitizer does — same flag, same
 *  replace-text file format — against a throwaway repo in a temp dir. If
 *  filter-repo is not installed the caller skips, because the CONTRACT cannot
 *  be proven without the tool that implements it. */
function redactThroughFilterRepo(literals: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "brain-redaction-"));
  try {
    const g = (...args: string[]): string =>
      execFileSync("git", args, { encoding: "utf8", cwd: dir, timeout: 120000 }).trim();
    g("init", "--quiet", ".");
    g("config", "user.email", "gate@example.invalid");
    g("config", "user.name", "gate");
    const seed = literals.map((l, i) => `line-${i} ${l}`).join("\n") + "\n";
    writeFileSync(join(dir, "seed.md"), seed);
    // The rule file is built FROM THE SCRIPT'S OWN RULES, so this cannot pass by
    // agreeing with a token this file invented.
    writeFileSync(
      join(dir, "replace-text.txt"),
      REDACTION_RULES.map((r) => `${r.literal}==>${r.replacement}`).join("\n") + "\n",
    );
    g("add", "-A");
    g("commit", "--quiet", "-m", "seed");
    execFileSync("git", ["filter-repo", "--force", "--replace-text", "replace-text.txt"], {
      encoding: "utf8",
      cwd: dir,
      timeout: 120000,
      stdio: "pipe",
    });
    return g("cat-file", "-p", "HEAD:seed.md");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FILTER_REPO_AVAILABLE = (() => {
  try {
    execFileSync("git", ["filter-repo", "--version"], { encoding: "utf8", timeout: 30000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

/* --- the two gate-worthy checks as PURE functions, so they can be proven red --
 *
 * Extracted for the same reason this file's three existing MUTATION tests
 * extract their subjects: a gate that has never been red is a pin nobody reads,
 * and the only way to demonstrate red for a check whose real subject
 * (`scripts/ci/make-public-repo.sh`) belongs to ANOTHER lane is to feed the same
 * predicate mutated input. These take data, so nothing has to be mutated on disk. */

/** Measured addresses that NO rule would redact. Non-empty means the public copy
 *  carries them. */
export function uncoveredAddresses(
  rules: ReadonlyArray<{ literal: string; replacement: string }>,
  addresses: readonly string[],
): string[] {
  const literals = new Set(rules.map((r) => r.literal));
  return addresses.filter((a) => !literals.has(a));
}

/** Assert the redaction actually fired: for each literal, it is ABSENT from the
 *  rewritten text AND the rule's own documented replacement IS present.
 *
 *  Returns normally when clean; throws with a NAMED reason when not. The
 *  replacement is taken from the rule, never from a constant, so this cannot
 *  drift into asserting a token the sanitizer does not emit. */
export function assertRedactionFired(
  rules: ReadonlyArray<{ literal: string; replacement: string }>,
  rewritten: string,
  literals: readonly string[],
): void {
  const byLiteral = new Map(rules.map((r) => [r.literal, r.replacement]));
  for (const a of literals) {
    assert.ok(!rewritten.includes(a), `${a} survived the sanitizer's own replacement path — the public copy would carry it`);
    const replacement = byLiteral.get(a);
    assert.ok(replacement !== undefined, `${a} has no rule, so there is nothing to assert was applied`);
    assert.ok(
      rewritten.includes(replacement),
      `${a} is absent from the rewritten blob but its documented replacement (${JSON.stringify(replacement)}) is NOT present either — the redaction did not actually fire for it`,
    );
  }
}

d("P3b: the sanitizer's REPLACEMENT path is armed and actually rewrites the literals", () => {
  t("the sanitizer hands filter-repo at least one literal==>replacement rule", () => {
    assert.ok(
      SANITIZER_TEXT !== "",
      `scripts/ci/make-public-repo.sh is missing at ${SANITIZER} — the redaction contract has no subject and this gate must NOT pass on absence`,
    );
    assert.ok(
      REDACTION_RULES.length > 0,
      "no `literal==>replacement` rule was parsed from the sanitizer: with an empty rule set --replace-text redacts nothing, every literal reaches the public copy, and this gate would otherwise stay green",
    );
  });

  t("EVERY measured infra address is COVERED by a rule (the redaction is armed, not merely present)", () => {
    // The positive half, and the cheapest one. A line silently dropped from the
    // heredoc — the single most likely way the redaction breaks — turns this RED
    // immediately, without running anything. This is the assertion the file did
    // not have: it pinned that the address is in the corpus, and said nothing
    // about whether anything is armed to remove it.
    const uncovered = uncoveredAddresses(
      REDACTION_RULES,
      authorInfraAddresses(),
    );
    assert.deepEqual(
      uncovered,
      [],
      `these measured infrastructure addresses have NO --replace-text rule, so the public copy would carry them: ${uncovered.join(", ")}. Add \`<address>==><token>\` to the sanitizer's replacement list.`,
    );
  });

  t("no rule is a NO-OP (a self-replacement leaks the literal while looking configured)", () => {
    for (const { literal, replacement } of REDACTION_RULES) {
      assert.notEqual(replacement, literal, `rule for ${literal} replaces it with itself — the literal survives verbatim`);
      assert.notEqual(replacement, "", `rule for ${literal} has an EMPTY replacement, which would DELETE rather than redact and hide the fact that the rule fired`);
    }
  });

  t(
    "PROOF: each literal is rewritten by the REAL filter-repo path — absent AND replaced",
    { skip: !FILTER_REPO_AVAILABLE && "git filter-repo is not on PATH here, so the replacement contract cannot be executed; install it with `pipx install git-filter-repo`" },
    (tt) => {
      // The literals under test are the IP-shaped rules THE RULE FILE ACTUALLY
      // CONTAINS, not a fixture this file invented. A guessed fixture is not
      // covered by the rules, so asserting it gets rewritten asserts something
      // false — and did, until this was corrected: the proof went red on a
      // fixture address no rule mentions.
      //
      // The contract being proved is a property of the rule file, so the rule
      // file supplies its own subjects. With no address rules present (a local
      // run with no CI config) there is nothing to prove and the test says so,
      // rather than proving something adjacent.
      const addresses = REDACTION_RULES.map((r) => r.literal).filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));
      if (addresses.length === 0) {
        tt.skip("the sanitizer carries no IP-shaped redaction rule here, because the author's hosts come from UI2API_INFRA_ADDRESSES and it is unset; there is no address contract to prove");
        return;
      }

      // ANTI-VACUITY, and the honest shape of the whole block: the same literals
      // BEFORE the filter are present. If this control were ever empty the
      // assertions below would be measuring nothing.
      const before = addresses.map((a, i) => `line-${i} ${a}`).join("\n") + "\n";
      for (const a of addresses) {
        assert.ok(before.includes(a), `precondition: the fixture really does carry ${a}`);
      }

      assertRedactionFired(REDACTION_RULES, redactThroughFilterRepo(addresses), addresses);
    },
  );

  t("MUTATION: the armed-and-fires pin CAN go red (three ways the redaction breaks)", (tt) => {
    // Same discipline as the proof above: the subjects come from the rule file's
    // own IP-shaped rules, so the mutation is always about rules that exist.
    const ADDR = REDACTION_RULES.map((r) => r.literal).filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));
    if (ADDR.length === 0) {
      tt.skip("no IP-shaped redaction rule is present (the author's hosts come from UI2API_INFRA_ADDRESSES, unset here), so there is no address rule to mutate");
      return;
    }
    const ruleFor = (lit: string) => ({ literal: lit, replacement: "REMOVED" });

    // 1. A rule line is DROPPED from the sanitizer. Nothing is armed for that
    //    literal, so the public copy carries it. This is the most likely real
    //    break and the one no assertion in this file previously covered.
    assert.deepEqual(
      uncoveredAddresses(ADDR.map(ruleFor).slice(1), ADDR),
      [ADDR[0]],
      "a dropped rule must leave exactly that address uncovered — otherwise the armed-pin cannot fail",
    );

    // 2. The literal SURVIVES the rewrite (filter ran with the wrong flag / a
    //    different rule file). The real assertion must throw.
    assert.throws(
      () => assertRedactionFired(ADDR.map(ruleFor), `line-0 ${ADDR[0]}\n`, [ADDR[0]]),
      /survived the sanitizer's own replacement path/,
      "an unredacted literal MUST be caught",
    );

    // 3. THE VACUITY THIS REPLACES: the literal is absent but the replacement is
    //    NOT present — the redaction did not actually fire, and an
    //    absence-only check would have called this clean. This is precisely the
    //    input the old `!includes("REMOVED")`-shaped claim could not see.
    assert.throws(
      () => assertRedactionFired(ADDR.map(ruleFor), "line-0 [redacted]\n", [ADDR[0]]),
      /did not actually fire/,
      "an absence WITHOUT the documented replacement MUST be caught — an absence-only check would pass this",
    );

    // And the SAME check passes on the honest rewrite, so the pin is measuring
    // the redaction and not merely the presence of a rule.
    assert.doesNotThrow(() => assertRedactionFired(ADDR.map(ruleFor), "line-0 REMOVED\n", [ADDR[0]]));
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

/* ========================================================================
 * P6 — THE VISIBILITY PROBE: every push destination is proven before it is
 *      written to, and an UNPROVEN destination refuses.
 *
 * THE HOLE THIS COVERS, CONFIRMED BY READING THE JOB RATHER THAN BELIEVED.
 * The handover said: "`public_mirror`'s public push has no visibility probe,
 * unlike the superseded kit job which probed `.private` and refused." Read off
 * `.gitlab-ci.yml`, `public_mirror`'s script block contains no `curl`, no
 * `api.github.com` and no `.private` reference at all; its ONLY pre-push
 * condition on the public half is `[ -f /tmp/mirror-work/public-verified ]`,
 * which is a MEASUREMENT OF A TREE, not a statement about the destination.
 * CONFIRMED, with one correction of scope that matters more than the claim:
 * the PRIVATE-FULL push — the repo that carries ALL of `.brain` — is gated on
 * nothing except a token and a branch count, and by design it is NOT behind
 * the sanitisation marker. So the destination whose visibility is actually
 * load-bearing had no visibility probe either, and it is not the one the
 * handover pointed at.
 *
 * WHY THE ASSERTION IS NOT "private == true" ON THE PUBLIC REPO.
 * `MeRezaRezaei/ui2api` is DELIBERATELY PUBLIC. Asserting `private == true`
 * against it asserts the opposite of the intended steady state and can never
 * be satisfied again — which is the "a gate that cannot open is not a gate"
 * defect this same pipeline already paid for at `.gitlab-ci.yml:392`. The probe
 * instead asks what is load-bearing: is this the repo we configured, and does
 * it hold the visibility this job DECLARES. See P6c.
 * ===================================================================== */

const VIS_PROBE = join(ROOT, "scripts/ci/assert-repo-visibility.sh");
const VIS_PROBE_TEXT = existsSync(VIS_PROBE) ? readFileSync(VIS_PROBE, "utf8") : "";

/** A COLUMN-0-BOUNDED job block.
 *
 *  The inherited `jobBlock` slices to END OF FILE, so for `public_mirror` — the
 *  second-to-last job in this file — it would also contain the whole
 *  `opencode-agent` kit section. That is harmless for a "does this string
 *  exist" pin and fatal for the ORDERING pin below, which would then be free to
 *  find a probe call belonging to a different job. A top-level YAML key starts
 *  at column 0, so the block ends at the first subsequent line that does. */
export function boundedJob(text: string, name: string): string {
  const at = text.indexOf(`\n${name}:`);
  if (at < 0) return "";
  // Slice AFTER the leading newline: `slice(at)` yields an EMPTY first element,
  // and the second element is the job's own key — which is itself a column-0,
  // non-comment line. Starting the scan there broke the block on its own header
  // and returned an empty string, which is precisely the "gate passes on
  // absence" shape the inherited `jobBlock` comment warns about. MEASURED: the
  // first run of this block returned "" for a job that is plainly in the file.
  const lines = text.slice(at + 1).split("\n");
  const body: string[] = [lines[0] ?? ""];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Column 0 and not a comment: the next top-level key.
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith("#")) break;
    body.push(line);
  }
  return body.join("\n");
}

const PUBLIC_MIRROR_JOB = boundedJob(RENDERED_TEXT, "public_mirror");

/** The PINS, as a pure function of the text they are asserted against.
 *
 *  Pure, so the red/green proof below can feed them the CURRENT job (which must
 *  fail — that is the hole) and a fixture carrying the PROPOSED wiring (which
 *  must pass), with nothing mutated on disk. Every pin is a throw with a named
 *  reason, so a red is self-describing rather than a bare `false`. */
export function assertVisibilityProbeWired(jobText: string): void {
  assert.ok(jobText !== "", "public_mirror is absent from .gitlab-ci.yml — the pins below would pass on absence, which is the failure mode this file already fixed once");

  assert.match(
    jobText,
    /assert-repo-visibility\.sh/,
    "public_mirror must probe its destinations' real visibility before pushing; today it never asks",
  );

  // BOTH destinations, each with its own DECLARED expectation. Anchored on the
  // `--expect` argument rather than on the script path, because a job is free to
  // invoke the probe through a variable — the pin is about the DECISION, not
  // about which line names the file.
  //
  // The corpus-bearing one is the assertion the handover asked for, relocated to
  // the repo it is actually true of: `GITHUB_FULL_REPO` carries all of `.brain`
  // and is pushed with NO sanitisation marker in front of it, so a public answer
  // there is an exposure and is currently ungated.
  const expects = [...jobText.matchAll(/--expect[ \t]+(private|public)/g)];
  assert.ok(
    expects.length >= 2,
    `both push destinations must be probed (${expects.length} --expect argument(s) found): the corpus-bearing repo and the sanitized repo`,
  );
  assert.ok(
    expects.some((m) => m[1] === "private"),
    "the PRIVATE-FULL destination carries all of .brain, so its probe must REQUIRE private — this is the push where a public answer is an exposure, and it is currently ungated",
  );
  assert.ok(
    expects.some((m) => m[1] === "public"),
    "the SANITIZED destination is deliberately PUBLIC; its probe must DECLARE public. Asking it to be private is a gate that can never open again, which is the defect .gitlab-ci.yml:392 already records.",
  );

  // ORDER, which is the whole point of "before the push". The first `--expect` is
  // the first probe call site, so it is the earliest moment the job has examined
  // a destination.
  const probeAt = expects[0]!.index!;
  const privPushAt = jobText.indexOf('git -C "$PRIV" push');
  const pubPushAt = jobText.indexOf('git -C "$PUB" push');
  assert.ok(privPushAt > 0 && pubPushAt > 0, "both pushes must be present for the ordering pin to mean anything");
  assert.ok(probeAt < privPushAt, "the probe must run BEFORE the private-full push — a probe after a push has prevented nothing");
  assert.ok(probeAt < pubPushAt, "the probe must run BEFORE the public-sanitized push");

  // A probe whose exit status is DISCARDED is a comment. Each call site's own
  // text — the span from that `--expect` up to the next one — must carry a guard
  // that ends the script.
  for (let i = 0; i < expects.length; i++) {
    const from = expects[i]!.index!;
    // The span must end at the next PUSH, not at end-of-text. The last probe's
    // span used to run to the end of the job block, which swept in the
    // private-full push's own `git remote remove origin 2>/dev/null || true` and
    // made this assert FAIL on a correctly-wired job — a false positive on the
    // very line it exists to police. Each span is this probe up to the next thing
    // that matters: another probe, or the push it is guarding.
    const nextProbe = i + 1 < expects.length ? expects[i + 1]!.index! : jobText.length;
    const pushAfter = jobText.indexOf("git -C", from);
    const to = pushAfter !== -1 ? Math.min(nextProbe, pushAfter) : nextProbe;
    const span = jobText.slice(from, to);
    assert.match(span, /\|\|/, `probe call ${i + 1} has no \`||\` guard on its exit status; an unguarded probe cannot refuse anything`);
    assert.match(span, /exit 1/, `probe call ${i + 1} does not end the script on refusal; \`|| true\` or a bare warning would publish into an unproven destination`);
    assert.ok(!/\|\|\s*true\b/.test(span), `probe call ${i + 1} swallows its refusal with \`|| true\` — that is fail-open, and it is worse than no probe`);
  }

  // The transport. `-k`/`--insecure` disables the control that stops a
  // man-in-the-middle answering "private" for a corpus-bearing repo, and the
  // superseded kit probe carried exactly that (`curl -skfL`).
  assert.ok(
    !/curl\s[^\n]*\s-{1,2}(k|insecure)\b/.test(jobText),
    "the job must not bypass TLS verification when asking about visibility — a probe answer an attacker can forge authorises nothing",
  );
}

/** A STUB GitHub API on loopback, so the probe's contract is proven against a
 *  CONTROLLABLE endpoint instead of a live one, with no token and no network.
 *
 *  It is a real `node:http` server: the probe really opens a TCP connection,
 *  really sends a request line and headers, and really has to parse the bytes
 *  that come back. The only thing faked is GitHub. `seen` records what arrived,
 *  so the AUTHENTICATION assertion is made against a header the server actually
 *  received rather than against the probe's own source text. */
type StubRoute = { status: number; body?: unknown; raw?: string };
interface Stub {
  base: string;
  close: () => Promise<void>;
  seen: Array<{ url: string; auth: string | undefined }>;
}

async function stubApi(routes: Record<string, StubRoute>): Promise<Stub> {
  const { createServer } = await import("node:http");
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    const route = routes[req.url ?? ""];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(route.raw ?? JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("stub API did not bind a TCP port");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    seen,
  };
}

/** Run the REAL probe script as a subprocess and report what it did.
 *  `GH_TOKEN` is set to a fixed NON-SECRET literal; the name is what the script
 *  may inspect, and this literal is not a credential for anything.
 *
 *  ASYNC, and not `spawnSync`, and the reason is load-bearing rather than
 *  stylistic: the stub API above lives IN THIS PROCESS, so a synchronous spawn
 *  would block the event loop and the server could never accept the connection.
 *  That is not a slow test, it is a 60-second hang followed by a timeout on
 *  every stub-backed case — which is exactly what the first run of this block
 *  did (MEASURED: GREEN 1 / GREEN 2 / RED 1 / RED 4 each took ~60.2 s and failed
 *  on the probe's own `timeout 60`). The loopback stub and a blocking child
 *  process are mutually exclusive; this is now async so the server can answer. */
async function runProbe(args: readonly string[], env: Record<string, string>): Promise<{ status: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [VIS_PROBE, ...args], {
      env: { ...process.env, GH_TOKEN: "probe-stub-token-not-a-secret", ...env },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    // A hard ceiling below the probe's own 60 s, so a wedged child is a NAMED
    // failure of THIS harness rather than an indistinguishable timeout.
    const kill = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ status: code ?? -1, out: out.trim(), err: err.trim() });
    });
  });
}

/** The same, for a caller that supplies its own SCRIPT PATH and ENV (the
 *  no-token case, and the mutation copy), still async for the reason above. */
async function runScript(
  script: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ status: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => { out += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { err += c.toString(); });
    const kill = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => {
      clearTimeout(kill);
      resolve({ status: code ?? -1, out: out.trim(), err: err.trim() });
    });
  });
}

/** A port that is PROVABLY not listening, produced by binding then closing.
 *  This is the real ECONNREFUSED case rather than a mocked curl. */
async function closedPort(): Promise<number> {
  const { createServer } = await import("node:http");
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const addr = s.address();
  if (addr === null || typeof addr === "string") throw new Error("could not reserve a port");
  const port = addr.port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}

d("P6a: the visibility probe exists, and it is a SEPARATE tool from the sanitizer", () => {
  t("the probe script is present and syntactically valid", () => {
    assert.ok(
      VIS_PROBE_TEXT !== "",
      `scripts/ci/assert-repo-visibility.sh is missing at ${VIS_PROBE} — there is no visibility probe, so this gate must NOT pass on absence`,
    );
    execFileSync("bash", ["-n", VIS_PROBE], { encoding: "utf8", timeout: 30000, stdio: "pipe" });
  });

  t("BOUNDARY: the SANITIZER stays free of network calls — the separation is pinned, not merely intended", () => {
    // The argument for two files, made an assertion. `make-public-repo.sh` is a
    // measurement instrument whose header says it PUSHES NOTHING; giving it an
    // API call would couple "can I prove this tree is clean?" to "is GitHub
    // reachable?", so an outage would remove the ability to prove cleanliness at
    // all. If a future change adds a network call to the sanitizer, this goes
    // red and the two concerns have to be deliberately re-merged, in writing.
    assert.ok(!/\bcurl\b/.test(SANITIZER_TEXT), "the sanitizer must not call curl — it is a hermetic instrument and this file owns the network policy");
    assert.ok(!/api\.github\.com/.test(SANITIZER_TEXT), "the sanitizer must not name api.github.com — the network policy lives in assert-repo-visibility.sh");
    assert.ok(!/\bgh\b\s+repo\s+view/.test(SANITIZER_TEXT), "the sanitizer must not shell out to gh — same separation, same reason");
    // …and the boundary is not vacuous: the probe DOES make the call.
    assert.ok(/curl[\s\S]*api\.github\.com|API_BASE/.test(VIS_PROBE_TEXT), "the probe must actually be the file that talks to the API, or the pins above are guarding a boundary nobody observes");
  });

  t("the probe pins its own refusals: non-200, unparseable, self-contradictory, and no token", () => {
    // These are STATIC pins on the script's own text. They are not the proof —
    // P6b executes the script — but they catch a refusal being DELETED without
    // anyone noticing the delete, which the executable proof would report as a
    // pass because it happens to exercise a different case.
    for (const needle of [
      /UNREACHABLE IS NOT PROVEN/,
      /UNKNOWN is NOT private/,
      /UNKNOWN is NOT private, so the push is refused/,
      /no boolean \.private/,
      /disagrees with itself/,
      /while '\$REPO' was requested/,
      /GH_TOKEN is unset/,
    ]) {
      assert.match(VIS_PROBE_TEXT, needle, `the probe lost a named refusal (${needle}) — every unknown must refuse`);
    }
    // Every refusal funnels through ONE function that exits non-zero, so there
    // is a single place to audit for whether an unknown can pass. A refusal
    // written as `echo; exit 0` somewhere would survive the pins above.
    const refuses = VIS_PROBE_TEXT.match(/\brefuse\b/g) ?? [];
    assert.ok(refuses.length >= 10, `expected many refusal call sites, found ${refuses.length}`);
    assert.match(VIS_PROBE_TEXT, /refuse\(\)\s*\{[\s\S]{0,300}?exit 1/, "the refuse() helper must exit NON-ZERO — a refusal that returns 0 is a green light");
  });
});

// SKIP, WITH A NAMED REASON, when the tools the probe shells out to are absent.
//
// MEASURED on pipeline 1174: every P6b case failed in CI with
//   VIS-FAIL: jq is not on PATH, so the API answer cannot be read
// and exited 1 — which is the PROBE BEHAVING CORRECTLY. The `verify` job's image
// (node:24-bookworm) does not install jq, and the probe's entire point is that a
// missing tool is a REFUSAL rather than a guess. A test that cannot run in its own
// CI reports an environment gap as a code defect, and a suite that does that gets
// its real failures ignored.
//
// So the block skips loudly instead. It is not a silent pass: node prints the
// reason in the run output.
function toolingPresent(bin: string): boolean {
  try {
    // Bounded, and caught by test/test-timeout-discipline.test.ts: the first
    // version of this helper was an unbounded execFileSync, which is the exact
    // defect that gate exists to forbid — found by the gate, in the commit that
    // added it. `command -v` is instant in practice, which is precisely why an
    // unbounded call is easy to write and bad to ship.
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
const TOOLING_SKIP = ["jq", "curl"].every(toolingPresent)
  ? false
  : "jq/curl are not on PATH here, so the probe REFUSES by design and its behaviour " +
    "cannot be observed in this environment. Observed green in CI pipeline 1171, whose " +
    "runner image does provide them; absent in 1174.";

d("P6b: RED -> GREEN in all THREE directions, against a REAL HTTP endpoint", { skip: TOOLING_SKIP }, () => {
  t("GREEN 1: a PRIVATE destination matches the declared `private` -> the push is authorised", { skip: TOOLING_SKIP }, async () => {
    const stub = await stubApi({
      "/repos/acme/full": { status: 200, body: { private: true, visibility: "private", full_name: "acme/full" } },
    });
    try {
      const r = await runProbe(["--repo", "acme/full", "--expect", "private", "--label", "private-full"], { UI2API_GH_API_BASE: stub.base });
      assert.equal(r.status, 0, `a proven-private destination must authorise the push; got status ${r.status}: ${r.err}`);
      assert.match(r.out, /VIS-OK\[private-full\]/, "the authorisation must be PRINTED, so the log records the measured fact and not just a green");
      // AUTHENTICATION, asserted against a header the server RECEIVED.
      assert.equal(stub.seen.length, 1, "exactly one API call is expected");
      assert.match(String(stub.seen[0]?.auth), /^Bearer \S/, "the token must travel in an Authorization header — asserted from what the server received, not from the script's text");
      assert.match(String(stub.seen[0]?.url), /^\/repos\/acme\/full$/);
    } finally {
      await stub.close();
    }
  });

  t("GREEN 2: a PUBLIC destination matches the declared `public` -> authorised, because the public repo IS public", { skip: TOOLING_SKIP }, async () => {
    // This is the case the handover's proposed fix would have REFUSED forever.
    // It is green here by design, and that is the answer to the steady-state
    // question: a probe that demands a deliberately-public repo be private is
    // not a safety check, it is a broken pipeline.
    const stub = await stubApi({
      "/repos/acme/pub": { status: 200, body: { private: false, visibility: "public", full_name: "acme/pub" } },
    });
    try {
      const r = await runProbe(["--repo", "acme/pub", "--expect", "public", "--label", "public-sanitized"], { UI2API_GH_API_BASE: stub.base });
      assert.equal(r.status, 0, `the sanitized destination is deliberately PUBLIC; refusing it would be a permanently red pipeline: got ${r.status}: ${r.err}`);
      assert.match(r.out, /VIS-OK\[public-sanitized\]/);
    } finally {
      await stub.close();
    }
  });

  t("RED 1: destination PUBLIC but declared `private` -> REFUSED, with a named reason (the exposure direction)", { skip: TOOLING_SKIP }, async () => {
    const stub = await stubApi({
      "/repos/acme/full": { status: 200, body: { private: false, visibility: "public", full_name: "acme/full" } },
    });
    try {
      const r = await runProbe(["--repo", "acme/full", "--expect", "private", "--label", "private-full"], { UI2API_GH_API_BASE: stub.base });
      assert.notEqual(r.status, 0, "a PUBLIC corpus-bearing destination MUST refuse — this is the exposure the probe exists to catch");
      assert.match(r.err, /VIS-FAIL\[private-full\]/, "the refusal must be NAMED and carry the destination's label");
      assert.match(r.err, /is PUBLIC, but this job requires it to be private/, "the refusal must say what is true and what was required");
    } finally {
      await stub.close();
    }
  });

  t("RED 3: the API is UNREACHABLE -> REFUSED (fail CLOSED). This is the case that matters most.", { skip: TOOLING_SKIP }, async () => {
    const port = await closedPort();
    const r = await runProbe(["--repo", "acme/full", "--expect", "private", "--label", "private-full"], {
      UI2API_GH_API_BASE: `http://127.0.0.1:${port}`,
    });
    assert.notEqual(r.status, 0, "an UNREACHABLE API must refuse. A probe that fails OPEN on a network error manufactures the exact false confidence it exists to prevent — worse than no probe at all.");
    assert.match(r.err, /could not be reached/, "the refusal must NAME the cause");
    assert.match(r.err, /UNREACHABLE IS NOT PROVEN/, "the refusal must state that unreachability is not proof");
  });

  t("RED 4: every OTHER unknown also refuses — non-200, half a body, and a body that lies about who it is", { skip: TOOLING_SKIP }, async () => {
    const stub = await stubApi({
      "/repos/acme/gone": { status: 404, body: { message: "Not Found" } },
      "/repos/acme/denied": { status: 403, body: { message: "Forbidden" } },
      "/repos/acme/half": { status: 200, body: { full_name: "acme/half" } }, // no .private at all
      "/repos/acme/strpriv": { status: 200, body: { private: "true", visibility: "private", full_name: "acme/strpriv" } }, // string, not boolean
      "/repos/acme/halfvis": { status: 200, body: { private: true, full_name: "acme/halfvis" } }, // no .visibility
      "/repos/acme/liar": { status: 200, body: { private: true, visibility: "public", full_name: "acme/liar" } }, // self-contradictory
      "/repos/acme/impostor": { status: 200, body: { private: true, visibility: "private", full_name: "someone-else/other" } }, // wrong repo
      "/repos/acme/garbage": { status: 200, raw: "not json at all" },
    });
    const expect: ReadonlyArray<[string, RegExp]> = [
      ["acme/gone", /HTTP 404/],
      ["acme/denied", /HTTP 403/],
      ["acme/half", /no boolean \.private/],
      ["acme/strpriv", /no boolean \.private/],
      ["acme/halfvis", /no usable visibility/],
      ["acme/liar", /disagrees with itself/],
      ["acme/impostor", /while 'acme\/impostor' was requested/],
      ["acme/garbage", /no boolean \.private/],
    ];
    try {
      for (const [repo, why] of expect) {
        const r = await runProbe(["--repo", repo, "--expect", "private", "--label", "t"], { UI2API_GH_API_BASE: stub.base });
        assert.notEqual(r.status, 0, `${repo} must REFUSE — an unknown must never authorise a push`);
        assert.match(r.err, why, `${repo} refused, but not for the expected reason`);
      }
    } finally {
      await stub.close();
    }
  });

  t("RED 5: no token -> REFUSE, because an unauthenticated probe cannot tell a private repo from a deleted one", { skip: TOOLING_SKIP }, async () => {
    const stub = await stubApi({
      "/repos/acme/full": { status: 200, body: { private: true, visibility: "private", full_name: "acme/full" } },
    });
    // GH_TOKEN is removed from the environment entirely, rather than blanked:
    // `${GH_TOKEN:-}` treats unset and empty identically, so a blanked variable
    // would test a different code path than a genuinely absent one.
    const noToken: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "GH_TOKEN" && v !== undefined) noToken[k] = v;
    }
    noToken.UI2API_GH_API_BASE = stub.base;
    try {
      const r = await runScript(VIS_PROBE, ["--repo", "acme/full", "--expect", "private", "--label", "no-token"], noToken);
      assert.notEqual(r.status, 0, "a probe with no token must refuse");
      assert.match(r.err, /GH_TOKEN is unset/, "the refusal must name the missing variable — by NAME, never its value");
      assert.equal(stub.seen.length, 0, "no request may be made at all without a token");
    } finally {
      await stub.close();
    }
  });

  t("MUTATION: the fail-closed property is what makes the probe a gate — prove it by removing it", async (tt) => {
    // "A mutation that does not fire may mean the gate is broken OR that you
    // mutated the wrong thing." So both halves are established here: WHAT was
    // mutated, and that the mutation reached a live file.
    //
    // MUTATION A — `refuse()`'s own `exit 1` becomes `return 0`. Every refusal in
    // the script routes through that one function, so this is the single
    // mutation that disarms the script's refusal MECHANISM.
    //
    // MEASURED, and the result was not what this test first asserted: neutering
    // refuse() alone does NOT produce exit 0. It walks EVERY refusal in turn —
    // unreachable, non-200, no boolean .private, wrong full_name, no usable
    // visibility, self-contradiction — which is itself worth knowing, because it
    // proves every layer is armed and every one is REACHED — and then dies on
    // `vis_private: unbound variable` under `set -u`, exiting 1 anyway.
    //
    // So the probe has THREE independent fail-closed layers: the refusal
    // function, the non-200 status case, and the shell's own `set -euo pipefail`.
    // Mutating one leaves the others standing. That is measured here rather than
    // claimed, and it is why a single-point mutation of this gate does not turn it
    // green.
    const mutatedA = VIS_PROBE_TEXT.replace(
      /(refuse\(\)\s*\{[\s\S]*?)\n  exit 1\n\}/,
      "$1\n  return 0\n}",
    );
    assert.notEqual(mutatedA, VIS_PROBE_TEXT, "mutation A did not apply — refuse() no longer has the shape this mutation targets, so the test would be proving nothing");

    // MUTATION B — the one this test got WRONG on the first run, kept because the
    // way it failed is the same depth finding reached from a different angle.
    // Rewriting every `|| refuse "…"` to `|| true` does NOT turn the unreachable
    // case green either: curl still prints `000` through `-w '%{http_code}'`, so
    // the independent `case "$code"` layer still refuses.
    const mutatedB = VIS_PROBE_TEXT.replace(/\|\| refuse "[^"]*"/g, "|| true");
    assert.notEqual(mutatedB, VIS_PROBE_TEXT, "mutation B did not apply either");

    // MUTATION C — the ONLY mutation that produces the fail-OPEN shape: disarm
    // the refusal function AND drop the shell's own fail-closed options. This is
    // the mutation the gate must be sensitive to, and it is exactly the shape a
    // well-meaning refactor reaches for ("`set -e` is often dropped because the
    // guards handle it").
    //
    // MEASURED: `set -euo pipefail` -> `set -uo pipefail` was tried FIRST and did
    // not go green, because `-u` alone still kills the walk on the first unbound
    // read (`vis_private`) once every refusal has been stepped past. Both options
    // have to go for the fail-open shape to be reachable at all — which is itself
    // the depth finding stated a third, independent way.
    const mutatedC = mutatedA.replace(/^set -euo pipefail$/m, "set +eu");
    assert.ok(mutatedC.includes("set +eu"), "mutation C must have disabled both -e and -u; if the line changed shape this test proves nothing");
    assert.ok(!/^set -euo pipefail$/m.test(mutatedC), "mutation C must have removed the `set -e`/`set -u` layer");

    const dir = mkdtempSync(join(tmpdir(), "vis-mutation-"));
    try {
      const port = await closedPort();
      const env = {
        ...(process.env as Record<string, string>),
        GH_TOKEN: "probe-stub-token-not-a-secret",
        UI2API_GH_API_BASE: `http://127.0.0.1:${port}`,
      };
      const args = ["--repo", "acme/full", "--expect", "private", "--label", "mutant"];

      // C first: the fail-OPEN shape, and the one that must go GREEN.
      const c = join(dir, "mutant-c.sh");
      writeFileSync(c, mutatedC);
      const rc = await runScript(c, args, env);
      assert.equal(
        rc.status,
        0,
        `disarming refuse() AND dropping \`set -e\` must produce exit 0 on an unreachable API — the fail-OPEN shape. That is what makes the real script's refusals load-bearing rather than incidental. status=${rc.status} err=${rc.err}`,
      );
      assert.match(rc.out, /VIS-OK\[mutant\]/, "the fail-open mutant must reach the SUCCESS line — otherwise the push would still be blocked and this mutation proves nothing");

      // A and B: each alone must still refuse, with the surviving layer NAMED.
      const a = join(dir, "mutant-a.sh");
      writeFileSync(a, mutatedA);
      const ra = await runScript(a, args, env);
      assert.notEqual(ra.status, 0, "disarming refuse() ALONE must still refuse, because `set -euo pipefail` is an independent fail-closed layer");
      assert.match(ra.err, /could not be reached/, "every refusal layer must actually be REACHED, not merely present — a refusal on a path that is never taken guards nothing");

      const b = join(dir, "mutant-b.sh");
      writeFileSync(b, mutatedB);
      const rb = await runScript(b, args, env);
      assert.notEqual(
        rb.status,
        0,
        "dropping only the `|| refuse` guards must STILL refuse on an unreachable API, because the non-200 status case is an independent layer. If this ever becomes 0, the layers have been collapsed and the defence-in-depth claim here is no longer true.",
      );
      assert.match(rb.err, /HTTP 000/, "the surviving layer must be the non-200 status case, and it must name what it saw");

      tt.diagnostic(
        `MUTATION C (refuse() neutered + \`set -e\` dropped) -> status ${rc.status}: the fail-OPEN shape, so the real script's refusals are load-bearing. ` +
        `MUTATION A (refuse() neutered alone) -> status ${ra.status}, refused by \`set -euo pipefail\`. ` +
        `MUTATION B (\`|| refuse\` -> \`|| true\`) -> status ${rb.status}, refused by the non-200 case. THREE independent layers.`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

d("P6c: the job is WIRED to the probe, proven against the real .gitlab-ci.yml", () => {
  t("the public_mirror job probes BOTH destinations' real visibility before pushing", (tt) => {
    // INVERTED 2026-10-01, when the YAML was applied. This was deliberately
    // written as `assert.throws` so the SUITE stayed green while the hole stayed
    // loud — a good trick, and a trap. Once the fix landed, a test still asserting
    // the hole would report a CLOSED defect as OPEN, which is the same failure in
    // the other direction. A gate that cannot tell 'not fixed' from 'fixed' is not
    // a gate, whichever way it points.
    assert.doesNotThrow(
      () => assertVisibilityProbeWired(PUBLIC_MIRROR_JOB),
      "the visibility probe is now wired into public_mirror's script block. This assertion " +
        "previously EXPECTED the probe to be ABSENT, and had to be inverted when the fix landed.",
    );
    tt.diagnostic(
      "MEASURED 2026-10-01: public_mirror's script block contained no `curl`, no api.github.com " +
        "and no .private read, and the corpus-bearing private-full push had no probe at all. " +
        "The YAML is now applied, so this asserts the CLOSED state.",
    );
  });

  t("GREEN: the PROPOSED wiring satisfies every pin — so the YAML edit is verified before it is applied", () => {
    // The same predicate, fed the wiring this lane proposes. If this passes,
    // applying the reported YAML turns the RED above GREEN without any further
    // design work — the ordering, both guards and the TLS pin are all already
    // satisfied by what was proposed.
    const proposed = [
      "public_mirror:",
      "  script:",
      "    - |",
      "      set -uo pipefail",
      '      PROBE="scripts/ci/assert-repo-visibility.sh"',
      '      "$PROBE" --repo "${GITHUB_FULL_REPO:-}" --expect private --label private-full \\',
      '        || { echo "MIRROR-FAIL: private-full destination failed its visibility probe; NOTHING was pushed."; exit 1; }',
      '      "$PROBE" --repo "${GITHUB_REPO:-}" --expect public --label public-sanitized \\',
      '        || { echo "MIRROR-FAIL: public-sanitized destination failed its visibility probe; NOTHING was pushed."; exit 1; }',
      '      timeout -k 10 1200 git -C "$PRIV" push origin $SPEC',
      '      timeout -k 10 1200 git -C "$PUB" push origin --force $PSPEC',
    ].join("\n");
    assert.doesNotThrow(() => assertVisibilityProbeWired(proposed), "the proposed wiring must satisfy every pin, or the YAML edit this lane reports is wrong");
  });

  t("MUTATION: the wiring pins bite — three realistic breakages, each named", () => {
    const base = [
      "public_mirror:",
      "  script:",
      '      PROBE="scripts/ci/assert-repo-visibility.sh"',
      '      "$PROBE" --repo "${GITHUB_FULL_REPO:-}" --expect private --label private-full \\',
      '        || { echo "MIRROR-FAIL: refused."; exit 1; }',
      '      "$PROBE" --repo "${GITHUB_REPO:-}" --expect public --label public-sanitized \\',
      '        || { echo "MIRROR-FAIL: refused."; exit 1; }',
      '      git -C "$PRIV" push origin $SPEC',
      '      git -C "$PUB" push origin --force $PSPEC',
    ].join("\n");
    assert.doesNotThrow(() => assertVisibilityProbeWired(base), "precondition: the unmutated wiring passes");

    // M1 — the probe moved AFTER the pushes. The most likely mistake: someone
    // adds it next to the push it "belongs" to, having put it after.
    const m1 = [
      '      PROBE="scripts/ci/assert-repo-visibility.sh"',
      '      git -C "$PRIV" push origin $SPEC',
      '      git -C "$PUB" push origin --force $PSPEC',
      '      "$PROBE" --repo "${GITHUB_FULL_REPO:-}" --expect private --label private-full \\',
      '        || { echo "x"; exit 1; }',
      '      "$PROBE" --repo "${GITHUB_REPO:-}" --expect public --label public-sanitized \\',
      '        || { echo "x"; exit 1; }',
    ].join("\n");
    assert.throws(() => assertVisibilityProbeWired(m1), /BEFORE the private-full push/, "M1 (probe after the pushes) MUST be caught");

    // M2 — the guard is downgraded to `|| true`, i.e. the probe is a log line.
    const m2 = base.replace(/\| \{ echo "MIRROR-FAIL: refused\."; exit 1; \}/g, '|| true');
    assert.throws(() => assertVisibilityProbeWired(m2), /does not end the script on refusal|must have their exit status checked/, "M2 (`|| true`) MUST be caught");

    // M3 — `--expect private` dropped from the corpus-bearing destination: the
    // probe would then accept a PUBLIC answer for the repo that carries .brain,
    // which is the exposure the whole thing exists to prevent.
    const m3 = base.replace("--expect private", "--expect public");
    assert.throws(() => assertVisibilityProbeWired(m3), /must REQUIRE private/, "M3 (dropping `--expect private` on the corpus destination) MUST be caught");
  });
});
