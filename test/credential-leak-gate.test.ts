import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * TWO GATES IN ONE FILE, because they are the two halves of one red line.
 *
 * 1. GOAL 98 — `data/` holds REAL session snapshots (cookies + localStorage: the
 *    kimi `access_token`, the deepseek `userToken`, the Tencent `hunyuan_token`)
 *    and AGENTS.md's red line is "never commit data/". Measured: that line rested
 *    on ONE line of .gitignore that ZERO tests read, so a `git add -f data/...`
 *    would commit real credentials with the suite fully GREEN. It inspects the
 *    GIT INDEX and .gitignore only — it never opens a snapshot, and it reports
 *    paths and SHAPES, never secret values.
 *
 *    THIS FILE IS THE OWNER of that property. `test/brain-publication-gate.test.ts`
 *    deliberately does not re-implement it and instead names this file as the
 *    authority in a one-line cross-check, so that a regression in EITHER file is
 *    visible. Do not delete or fork that cross-check; if this half moves, the
 *    owner named in that message must move with it.
 *
 * 2. GOAL 164/173 — corpus CONTAINMENT for the PUBLIC DESTINATION repo, under
 *    the operator's decided topology (public code repo produced by stripping the
 *    corpus from HISTORY; private full copy; dedicated private brain repo). Its
 *    live half replaces a rule that the decided design made UNSATISFIABLE, and
 *    the replacement is strictly STRONGER. The full argument, the three outcomes,
 *    and the env-overridable repo names are in the block further down headed
 *    "THE DECIDED TOPOLOGY".
 */

/** The repo root, resolved from THIS FILE's own location — never from `cwd`.
 *
 *  This whole gate is about the GIT INDEX, so every input must name the repo
 *  explicitly. It previously read `.gitignore` and ran `git ls-files` against
 *  the process cwd, which is a host dependency of exactly the class
 *  test/host-independence-gate.test.ts exists to kill: measured, running this
 *  file from any other directory dies at import with
 *  `ENOENT: no such file or directory, open '.gitignore'`. A test that only
 *  passes when the runner happens to cd into the repo root is not a test of
 *  this repo, it is a test of the shell that launched it. `npm run test:unit`
 *  always runs from the root, so this was latent — but latent is how the
 *  pipeline-199 class starts. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", cwd: ROOT, timeout: 120000 }).trim();
const GITIGNORE = readFileSync(join(ROOT, ".gitignore"), "utf8");
const TRACKED: string[] = git("ls-files").split("\n").filter(Boolean);

/** The REAL ignore seam: ask git, never guess from the text. `.env` is covered
 *  by a pattern, not a literal line, so substring matching was a wrong check. */
export const isIgnored = (p: string): boolean => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { cwd: ROOT, stdio: "ignore", timeout: 120000 });
    return true;
  } catch {
    return false;
  }
};

/** Secret-bearing paths AGENTS.md declares must never be committed.
 *
 *  These were DEAD until now: exported, never read, while the only test that
 *  cares re-typed the same list inline as a hand-written predicate. A list
 *  nobody reads is a comment, and a predicate that re-types its own list is a
 *  second place to forget an entry — so the table is now the single source and
 *  the predicate is derived from it. The glob form (the star segment in the
 *  table below) is expanded to a segment-wise matcher, which is why the
 *  hand-written inline regex is gone. */
export const FORBIDDEN_TRACKED_PREFIXES = ["data/", ".agents/", ".opencode/", "sites/*/server/"];

/** True when a tracked path is under one of the declared secret-bearing roots.
 *  A star segment matches exactly one path segment, so the sites entry matches
 *  `sites/foo/server/index.js` and does NOT match `sites/server/index.js`
 *  (one segment short) or `sites/a/b/server/x.js` (one too many) — which is
 *  exactly the seam GOAL 142 fixed in .gitignore, mirrored here. */
export const isForbiddenTracked = (f: string): boolean =>
  FORBIDDEN_TRACKED_PREFIXES.some((prefix) => {
    const want = prefix.split("/").filter(Boolean);
    const have = f.split("/");
    if (!prefix.endsWith("/") && want[want.length - 1] !== undefined) want.pop();
    if (have.length < want.length) return false;
    return want.every((seg, i) => seg === "*" || seg === have[i]);
  });

/** Paths whose ignore status the gate requires (exact dir prefixes, gitignore glob form). */
export const MUST_BE_IGNORED = ["data/sessions/x/state.json", ".agents/agent.md", ".opencode/x", "sites/x/server/index.js", ".env"];

/** Tracked-file SHAPES that indicate a session snapshot or credential file. */
export function credentialShaped(tracked: string[]): string[] {
  return tracked.filter(
    (f) =>
      f.includes(".session/") ||
      /(^|\/)state\.json$/.test(f) && f.includes("sessions") ||
      /(^|\/)accounts\.json$/.test(f) ||
      /\.env$/.test(f) ||
      /(^|\/)cookies?\.json$/.test(f) ||
      /\.session\b/.test(f),
  );
}

/* ========================================================================
 * GOAL 164/173 — THE DECIDED TOPOLOGY, and what this file asserts about it.
 *
 * THE RULE THIS FILE USED TO ASSERT, AND WHY IT HAD TO BE REPLACED.
 *   Its live half asserted, quoted from the retired text:
 *     "PUBLIC repo: .brain/ must never be tracked"
 *     "PUBLIC repo: .brain/ must be gitignored"
 *   That is the OLD topology, in which the code repo itself became public and
 *   therefore had to untrack the corpus. Under the DECIDED topology that rule is
 *   unsatisfiable, because the corpus is correctly tracked in exactly the repos
 *   the operator keeps PRIVATE. A gate that cannot be satisfied is worse than no
 *   gate: it teaches its readers to ignore red, and the next real breach arrives
 *   into a gate they have already learned to skip.
 *
 * THE DECIDED TOPOLOGY (operator's decision; `.brain/verbatim-goals.md` GOAL
 * 164/173, and the `public_mirror` job in `.gitlab-ci.yml`):
 *   - $GITHUB_REPO       PUBLIC.  the code. `.brain` is NOT in it. The public
 *                        copy is produced by `scripts/ci/make-public-repo.sh`,
 *                        which removes the corpus from HISTORY with
 *                        `git filter-repo --invert-paths` — NOT with .gitignore.
 *   - $GITHUB_FULL_REPO  PRIVATE. complete history, `.brain` TRACKED.
 *   - $GITHUB_BRAIN_REPO PRIVATE. the dedicated shared brain.
 *
 * SO THE REPLACEMENT PROPERTY IS *CONTAINMENT*, NOT *TRACKING-STATE*.
 *
 *   It is stronger than the rule it replaces, on three counts, and it is worth
 *   being exact about why, because "I changed the gate" reads as a loosening
 *   unless the strengthening is shown:
 *
 *   1. GRANULARITY. The old rule read the WORKING TREE of THIS repo, via
 *      `git ls-files`. The new property is measured over EVERY reachable commit
 *      (`git rev-list --all --objects`), which strictly implies the tip-level
 *      property. It also catches a shape the old rule could not see AT ALL: a
 *      destination that is clean at the tip and dirty 200 commits back. That is
 *      not a hypothetical — it is the exact signature of a `filter-repo` run
 *      whose `--invert-paths` flag is missing, which inverts the whole filter and
 *      keeps ONLY the corpus (MEASURED on pipeline 915; see the long comment at
 *      scripts/ci/make-public-repo.sh:199-210). A tip-only check reads that repo
 *      as fine.
 *   2. PATH SET. The old rule's probe was the name glob `.brain*`. The new probe
 *      is the corpus path list AS DATA, read from the very file fed to
 *      `git filter-repo --paths-from-file`. That list has THREE entries under
 *      paths that look innocent — `VERBATIM.md`, `raw/VERBATIM-RAW.md`, and two
 *      `docs/handoffs/2026-09-20-*` files that quote the operator verbatim. A
 *      `.brain*` glob would have shipped all four to the world, which is why
 *      public-repo-paths.txt says in so many words that it is derived from
 *      CONTENT, not from a name pattern.
 *   3. SUBJECT. The old rule asserted about THIS repo. The new one asserts about
 *      the DESTINATION, which is the only repo whose visibility can leak
 *      anything. Asserting the property about the repo the corpus is correctly
 *      tracked in was never a privacy control; it was a category error.
 *
 * AND WHAT WAS NOT WEAKENED: nothing. The offline half below still fails the
 * suite if a `data/` vault path is tracked, and it still pins the corpus census.
 * The `brain-publication-gate.test.ts` cross-check that names this file as the
 * owner of the `data/` property is untouched and still resolves.
 * ===================================================================== */

/** The three repos of the decided topology.
 *
 *  ENV-OVERRIDABLE, and the CI variable name is tried FIRST. These three values
 *  are GitLab CI variables on the `public_mirror` job; a second hardcoded copy of
 *  a CI variable is a value that drifts silently, which is the same "one
 *  predicate, two lists" rot that the `isForbiddenTracked` rewrite in this file
 *  already removed once. Reading the CI name first means that inside the pipeline
 *  this gate reads the SAME value the job pushes to. */
export const PUBLIC_DEST_REPO = process.env.GITHUB_REPO ?? process.env.UI2API_PUBLIC_DEST_REPO ?? "MeRezaRezaei/ui2api";
export const PRIVATE_FULL_REPO = process.env.GITHUB_FULL_REPO ?? process.env.UI2API_PRIVATE_FULL_REPO ?? "MeRezaRezaei/ui2api-full";
export const BRAIN_REPO = process.env.GITHUB_BRAIN_REPO ?? process.env.UI2API_BRAIN_REPO ?? "MeRezaRezaei/operator-brain";

/** The corpus path list, READ AS DATA rather than re-typed.
 *
 *  `scripts/ci/public-repo-paths.txt` is the file actually handed to
 *  `git filter-repo --paths-from-file`, so it IS the whole of the path-based
 *  filter. Re-typing its entries into a test would create a second list that can
 *  disagree with the one that strips history — and a test that agrees with a
 *  stale copy of the list would go green while the corpus shipped. */
export const CORPUS_PATHS_FILE = join(ROOT, "scripts/ci/public-repo-paths.txt");

/** Strip the file's own comment/blank lines, exactly as the sanitiser does.
 *  make-public-repo.sh:82 runs the list through the identical filter, so the test
 *  and the filter see the same entries. */
export function parseCorpusPaths(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export const CORPUS_PATHS: readonly string[] = parseCorpusPaths(readFileSync(CORPUS_PATHS_FILE, "utf8"));

/** True when `p` is one of the corpus paths.
 *
 *  The matcher's semantics are the ones public-repo-paths.txt documents for
 *  itself in its FORMAT block (lines 100-106): "A trailing `/` means this
 *  directory and everything under it. Listing a DIRECTORY removes it
 *  recursively." So `.brain/` is a recursive prefix and `VERBATIM.md` is exact.
 *  That distinction is load-bearing in the other direction too: `docs/handoffs/`
 *  is deliberately NOT on the list, because only two specific files under it are
 *  corpus. A matcher that treated every list entry as a directory would flag
 *  every handoff, and one that treated them all as exact would miss all 35 files
 *  under `.brain/`. */
export function isCorpusPath(p: string, entries: readonly string[] = CORPUS_PATHS): boolean {
  return entries.some((e) => (e.endsWith("/") ? p.startsWith(e) : p === e));
}

/** `git` against an ARBITRARY repo directory, not just ROOT — containment is a
 *  property of the destination's history, and the destination is not this tree. */
const gitIn = (repoDir: string, ...args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", cwd: repoDir, timeout: 120000 });

/** Every distinct path ever present in ANY reachable commit.
 *
 *  `rev-list --all --objects` is what makes this TOTAL rather than tip-level: it
 *  walks every commit reachable from every ref and prints each object with its
 *  path. This is the same enumeration the sanitiser's own verification uses
 *  (make-public-repo.sh:273-276), so the gate and the publisher are looking at
 *  the same set of paths by construction. */
export function allCommitPaths(repoDir: string): string[] {
  const seen = new Set<string>();
  for (const line of gitIn(repoDir, "rev-list", "--all", "--objects").split("\n")) {
    // Lines are "<sha> <path>" for path-bearing objects and bare "<sha>" for
    // commits/trees. Only the former carries a path we can classify.
    const m = /^[0-9a-f]+\s+(.+)$/.exec(line);
    if (m?.[1] !== undefined) seen.add(m[1]);
  }
  return [...seen].sort();
}

/** Corpus containment over a repo's WHOLE history, with the offending commits.
 *
 *  The commit list is what turns "this is dirty" into "this is dirty BECAUSE OF
 *  8c7c41d" — a path-level `rev-list` yields only BLOB hashes, so naming a
 *  commit needs a path-limited log. `git log --all -- <paths>` is the same
 *  measurement public-repo-paths.txt documents having taken per entry. */
export function corpusContainment(repoDir: string): { paths: string[]; commits: string[] } {
  const paths = allCommitPaths(repoDir).filter((p) => isCorpusPath(p));
  if (paths.length === 0) return { paths, commits: [] };
  const commits = gitIn(repoDir, "log", "--all", "--format=%H", "--", ...paths)
    .split("\n")
    .filter(Boolean);
  return { paths, commits };
}

/** True when a .gitignore carries a rule that ignores the corpus directory.
 *  Accepts `.brain/` and the bare `.brain`; both are the same rule to git, and a
 *  gate that rejected a correct spelling would be a gate people work around. */
export const brainIgnoreRule = (gitignoreText: string): boolean =>
  gitignoreText.split("\n").some((l) => {
    const t = l.trim();
    return t === ".brain/" || t === ".brain";
  });

/* ========================================================================
 * THE THREE OUTCOMES, as a pure function over already-MEASURED facts.
 *
 * Pure, so every branch — including the failing one — is reachable without a
 * network and without a fixture pretending to be a repo. The facts are supplied
 * by a caller that has actually measured them: `measureDestination` below for
 * the live path, and real throwaway git repos for the hermetic proof.
 * ===================================================================== */

export type CorpusExposure =
  | { state: "private"; destination: string; corpusPathCount: number; corpusCommitCount: number; reason: string }
  | {
      state: "public-and-clean";
      destination: string;
      corpusPathCount: 0;
      corpusCommitCount: 0;
      /** The retained additional defence. Reported, never assumed — see below. */
      destinationBrainIgnored: boolean;
      granularity: Granularity;
      reason: string;
    }
  | {
      state: "public-and-dirty";
      destination: string;
      corpusPathCount: number;
      corpusCommitCount: number;
      firstOffendingCommit: string | null;
      reason: string;
    };

/** How total the containment measurement actually was.
 *
 *  Named rather than hidden, because "clean" means something different when it
 *  was measured over 604 commits than when it was measured over one tree — and a
 *  gate that does not distinguish them is a gate whose green is uninterpretable. */
export type Granularity = "every-commit" | "tip";

export interface DestinationFacts {
  destinationIsPrivate: boolean;
  corpusPaths: readonly string[];
  corpusCommits: readonly string[];
  destinationBrainIgnored: boolean;
  granularity: Granularity;
}

export function classifyCorpusExposure(destination: string, facts: DestinationFacts): CorpusExposure {
  const pathCount = facts.corpusPaths.length;
  const commitCount = facts.corpusCommits.length;
  if (facts.destinationIsPrivate) {
    // The corpus may travel. This is the only outcome in which tracking `.brain`
    // is CORRECT rather than a violation, which is exactly why the retired rule
    // — which read the public branch as the load-bearing one — had to go.
    return {
      state: "private",
      destination,
      corpusPathCount: pathCount,
      corpusCommitCount: commitCount,
      reason: `${destination} is PRIVATE: the corpus may travel; containment is not the applicable property`,
    };
  }
  if (pathCount === 0) {
    return {
      state: "public-and-clean",
      destination,
      corpusPathCount: 0,
      corpusCommitCount: 0,
      destinationBrainIgnored: facts.destinationBrainIgnored,
      granularity: facts.granularity,
      reason:
        `${destination} is PUBLIC and carries ${pathCount} corpus paths at ` +
        `${facts.granularity} granularity` +
        (facts.granularity === "every-commit" ? "" : " — WEAKER than the every-commit property; see the live half's honesty note"),
    };
  }
  const first = facts.corpusCommits[0] ?? null;
  return {
    state: "public-and-dirty",
    destination,
    corpusPathCount: pathCount,
    corpusCommitCount: commitCount,
    firstOffendingCommit: first,
    reason:
      `${destination} is PUBLIC and ${pathCount} corpus path(s) are reachable across ` +
      `${commitCount} commit(s); first offending commit ${first ?? "(none identifiable)"}`,
  };
}

/** The enforcing half. THROWS on the one outcome that must never ship.
 *
 *  A classifier that returns a verdict nobody checks is a report, not a gate, so
 *  the assertion is a separate exported function and the live half and the
 *  hermetic proof both go through it. The failure message carries the COUNT and
 *  the OFFENDING COMMIT, because "the public repo is dirty" without those two
 *  numbers is not actionable. */
export function assertDestinationNotExposed(e: CorpusExposure): void {
  if (e.state === "public-and-dirty") {
    throw new Error(
      `CORPUS EXPOSURE: ${e.reason}. ` +
        `Refusing: a public destination must not carry the operator's corpus in ANY commit. ` +
        `The public copy is produced by scripts/ci/make-public-repo.sh, which removes these paths from ` +
        `HISTORY (git filter-repo --invert-paths --paths-from-file scripts/ci/public-repo-paths.txt).`,
    );
  }
}

/** A one-line summary with the count in it, for every accepted class.
 *
 *  "A class you accept must be printed with its count" — a privacy class that is
 *  accepted silently is a class nobody re-checks, which is the specific failure
 *  GOAL 173 recorded when 102 "brain markers" turned out to be path pointers. */
export const describeExposure = (e: CorpusExposure): string =>
  e.state === "public-and-clean"
    ? `${e.state} [granularity=${e.granularity} corpusPaths=${e.corpusPathCount} brainIgnoredInDestination=${e.destinationBrainIgnored}]`
    : `${e.state} [corpusPaths=${e.corpusPathCount} corpusCommits=${e.corpusCommitCount}]`;

/* --- the live facts: the ONLY part of this contract that needs the network --- */

/** Real GitHub visibility. A real network + auth call, and it is the one fact
 *  that genuinely cannot be derived from this repository. Returns `null` rather
 *  than a guess when the API cannot be reached — an unknown visibility is not a
 *  private one, and treating it as private is how a corpus gets published. */
export function ghRepoIsPrivate(repo: string): boolean | null {
  // `gh` colourises its JSON when it believes it is on a terminal, so the raw
  // stdout is NOT valid JSON (measured: `[\1;37m{[\0m...`). Strip the ANSI.
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001B\[[0-9;]*m/g;
  try {
    const raw = execFileSync("gh", ["repo", "view", repo, "--json", "isPrivate"], {
      encoding: "utf8",
      timeout: 120000,
    });
    return (JSON.parse(raw.replace(ANSI, "")) as { isPrivate: boolean }).isPrivate === true;
  } catch {
    return null;
  }
}

/** The destination's TIP tree, as a real path list, from the real API.
 *  This is the network's ceiling: the GitHub trees API answers for one ref, so
 *  it cannot deliver the every-commit property. The granularity label is what
 *  keeps that honest. */
export function ghRepoTipPaths(repo: string): string[] | null {
  try {
    const raw = execFileSync("gh", ["api", `repos/${repo}/git/trees/HEAD?recursive=1`], {
      encoding: "utf8",
      timeout: 120000,
    });
    // eslint-disable-next-line no-control-regex
    const doc = JSON.parse(raw.replace(/\u001B\[[0-9;]*m/g, "")) as { tree?: Array<{ path?: string }> };
    return (doc.tree ?? []).map((n) => n.path).filter((p): p is string => typeof p === "string");
  } catch {
    return null;
  }
}

/** A LOCAL sanitized copy of the destination, when one is available.
 *
 *  This is how the live half can measure the every-commit property FOR REAL: the
 *  full-history sanitised clone the pipeline already builds and then publishes
 *  from. Point `UI2API_PUBLIC_MIRROR_DIR` at it and the live half stops
 *  approximating and starts measuring. Absent, the live half says so by name
 *  rather than reporting tip-clean as if it were total. */
export const PUBLIC_MIRROR_DIR = process.env.UI2API_PUBLIC_MIRROR_DIR ?? "";

/** The private-full copy, same idea: it is the repo where a NON-ZERO corpus count
 *  is the CORRECT answer, and pinning that is how we prove the scanner can see
 *  what it is looking at rather than reporting zeros by blindness. */
export const PRIVATE_FULL_DIR = process.env.UI2API_PRIVATE_FULL_DIR ?? "";

d("GOAL 98: the credential red line is machine-verified", () => {
  t("every declared secret-bearing path is ignored AND untracked", () => {
    for (const p of MUST_BE_IGNORED) {
      assert.ok(isIgnored(p), `.gitignore must ignore ${p} (measured with git check-ignore)`);
    }
    // a real captured-credential path must also be covered
    assert.ok(isIgnored("sites/gemini/.session/state.json"), "captured .session/ must be ignored");
    // Derived from FORBIDDEN_TRACKED_PREFIXES, not re-typed. The old inline
    // predicate was a second copy of the table: adding a prefix to the table
    // silently changed nothing, which is precisely how a red line rots.
    const leaked = TRACKED.filter(isForbiddenTracked);
    assert.deepEqual(leaked, [], `these secret-bearing files are TRACKED and would ship real credentials: ${leaked.join(" ")}`);
  });

  t("no tracked file has a session-snapshot/credential shape", () => {
    const shaped = credentialShaped(TRACKED);
    // .brain/verbatim/state.json is brain STATE, not a session snapshot — it is
    // legitimately tracked in a private repo, so it is explicitly allowed.
    const real = shaped.filter((f) => f !== ".brain/verbatim/state.json");
    assert.deepEqual(real, [], `these tracked files look like session snapshots/credentials: ${real.join(" ")}`);
  });

  // The network half of the privacy gate, under the DECIDED contract.
  //
  // It asks ONE question, about the DESTINATION — the only repo whose visibility
  // can leak anything: is the corpus contained in it? The retired version asked
  // the wrong question of the wrong repo ("does THIS repo gitignore .brain?"),
  // which under the decided topology is both unsatisfiable and irrelevant.
  //
  // It stays opt-in, gated EXACTLY the way test/install.test.ts:141 gates its
  // live-registry test (`{ skip: process.env.X !== "1" }`) — the sibling idiom,
  // not a new one — because `gh` is a NETWORK + CLI + AUTH dependency that ran
  // inside `test:unit` on every runner. The deterministic half below runs
  // unconditionally, so nothing is lost by that.
  t("destination exposure (live half): the PUBLIC DESTINATION's real visibility and real corpus containment, opt-in via UI2API_GH_LIVE=1", { skip: process.env.UI2API_GH_LIVE !== "1" }, (tt) => {
    // What is measured, and at what cost, is stated before it is asserted —
    // because a live gate that silently degrades from "every commit" to "one
    // tree" is how a green gets believed when it should not be.
    tt.diagnostic(
      `destination=${PUBLIC_DEST_REPO}  private-full=${PRIVATE_FULL_REPO}  brain=${BRAIN_REPO}  ` +
        `every-commit source=${PUBLIC_MIRROR_DIR !== "" ? PUBLIC_MIRROR_DIR : "(none — will fall back to the tip tree via the GitHub API)"}`,
    );

    const probe = resolveVisibilityProbe(ghRepoIsPrivate(PUBLIC_DEST_REPO));
    if (!probe.proven) {
      // Opted IN and the verdict still cannot be obtained. Do NOT fabricate one,
      // and specifically do not fall through to a "private ⇒ fine" verdict: an
      // unknown is not a yes, and "private" is the branch that lets the corpus
      // travel. Skip with the named reason; the deterministic half holds the line.
      tt.skip(`${probe.reason} (${PUBLIC_DEST_REPO})`);
      return;
    }
    const isPrivate = probe.isPrivate;
    // The other two repos of the decided topology, measured for real and printed
    // rather than asserted: the whole design rests on BOTH of them staying
    // private, so a flip in either is something a reader must see immediately.
    tt.diagnostic(
      `measured visibility: dest ${PUBLIC_DEST_REPO}=${isPrivate ? "private" : "PUBLIC"}, ` +
        `full ${PRIVATE_FULL_REPO}=${ghRepoIsPrivate(PRIVATE_FULL_REPO) ? "private" : "PUBLIC/unproven"}, ` +
        `brain ${BRAIN_REPO}=${ghRepoIsPrivate(BRAIN_REPO) ? "private" : "PUBLIC/unproven"}`,
    );

    // --- measure containment, preferring the TOTAL measurement ---------------
    let corpusPaths: string[];
    let corpusCommits: string[];
    let granularity: Granularity;
    if (PUBLIC_MIRROR_DIR !== "" && existsSync(PUBLIC_MIRROR_DIR)) {
      // The real, total measurement: every reachable commit of a real clone.
      const c = corpusContainment(PUBLIC_MIRROR_DIR);
      corpusPaths = c.paths;
      corpusCommits = c.commits;
      granularity = "every-commit";
    } else {
      // The network's honest ceiling. The GitHub trees API answers for ONE ref,
      // so this CANNOT deliver the every-commit property, and the granularity
      // label is what stops a tip-clean result from reading as a total one.
      const tip = ghRepoTipPaths(PUBLIC_DEST_REPO);
      if (tip === null) {
        tt.skip(`neither a local sanitized copy nor the tip-tree API could be read for ${PUBLIC_DEST_REPO}; no verdict is fabricated`);
        return;
      }
      corpusPaths = tip.filter((p) => isCorpusPath(p));
      // At tip granularity there is no per-path history to walk, so no commit is
      // named. The classifier carries `firstOffendingCommit: null` and says so,
      // rather than inventing a hash.
      corpusCommits = [];
      granularity = "tip";
    }

    // The retained gitignore defence, read from the destination when it is
    // public. Reported with its measured value in every outcome (see
    // `describeExposure`), never assumed.
    const destinationBrainIgnored = brainIgnoreRule(
      PUBLIC_MIRROR_DIR !== "" && existsSync(join(PUBLIC_MIRROR_DIR, ".gitignore"))
        ? readFileSync(join(PUBLIC_MIRROR_DIR, ".gitignore"), "utf8")
        : "",
    );

    const exposure = classifyCorpusExposure(PUBLIC_DEST_REPO, {
      destinationIsPrivate: isPrivate,
      corpusPaths,
      corpusCommits,
      destinationBrainIgnored,
      granularity,
    });
    // Printed on EVERY run, with the count in it — including the accepted ones.
    tt.diagnostic(`destination exposure: ${describeExposure(exposure)}`);
    if (exposure.state === "private") {
      tt.diagnostic(
        `PRIVATE: ${PUBLIC_DEST_REPO} carries ${exposure.corpusPathCount} corpus path(s) across ` +
          `${exposure.corpusCommitCount} commit(s), which is CORRECT here — the corpus belongs in the private repos.`,
      );
    }
    if (granularity === "tip" && !isPrivate) {
      tt.diagnostic(
        `HONESTY: containment was measured at TIP granularity only. A destination clean at the tip and dirty in ` +
          `older history is exactly the --invert-paths-missing signature, and a tip measurement cannot see it. ` +
          `Set UI2API_PUBLIC_MIRROR_DIR to a local sanitized clone to measure the total property.`,
      );
    }

    // The one assertion: a PUBLIC destination must not carry the corpus. This
    // THROWS on public-and-dirty, with the count and the offending commit.
    assertDestinationNotExposed(exposure);
  });

  // THE OFFLINE HALF, and the SCOPING this file now has to make explicit,
  // because the two rules below are exact opposites and used to be stated as
  // one:
  //
  //   THIS repo        -> `.brain` is TRACKED and NOT gitignored.  Correct.
  //   PUBLIC DEST      -> `.brain` is NOT tracked, and (additional defence)
  //                       the destination's own .gitignore ignores it.
  //
  // The retired live half asserted the DESTINATION rule about THIS repo. That
  // single category error is why the old gate could never be satisfied: under
  // the decided topology the two rules are assigned to two DIFFERENT repos, and
  // applying either one here is wrong. The offline half keeps the working-repo
  // half, which is the CONSERVATIVE direction — if nothing can be proven about
  // any destination, the corpus stays tracked and versioned, which is the state
  // that cannot leak by accident.
  //
  // It is pinned unconditionally so a runner with no `gh` and no network still
  // enforces the red line.
  t("privacy gate (offline half, no network): in the WORKING repo .brain/ stays tracked and ungitignored — the destination rule is scoped elsewhere", () => {
    const brainTracked = TRACKED.some((f) => f.startsWith(".brain/"));
    const brainIgnored = GITIGNORE.split("\n").some((l) => l.trim() === ".brain/");
    assert.ok(brainTracked, "if repo visibility cannot be proven here, .brain/ must still be tracked (fail safe)");
    assert.ok(!brainIgnored, ".brain/ must not be gitignored while it is tracked — that would silently untrack the brain");
  });

  t("negative: a credential-shaped path in the file list is reported (the gate CAN fail)", () => {
    const scratch = [...TRACKED, "data/sessions/kimi.ai/default/state.json"];
    const shaped = credentialShaped(scratch).filter((f) => f !== ".brain/verbatim/state.json");
    assert.ok(shaped.includes("data/sessions/kimi.ai/default/state.json"), "a tracked session snapshot must be reported");
    // and a leaked data/ path must be caught by the tracked-prefix rule too
    const leaked = scratch.filter((f) => f.startsWith("data/"));
    assert.deepEqual(leaked, ["data/sessions/kimi.ai/default/state.json"], "a tracked data/ path must be reported");
  });

  // The offline half is the one that must hold on a runner with no `gh`, so it
  // gets an explicit anti-vacuity pin. It is NOT vacuous today, and this is the
  // evidence rather than the claim: both its inputs are read at module load from
  // the REAL repo (an empty TRACKED makes `brainTracked` false, which FAILS
  // loudly rather than skipping). That property is easy to lose to a future
  // `if (!TRACKED.length) return`, so it is measured here.
  t("anti-vacuity: the offline privacy half is driven by REAL index state, so it fails loudly rather than passing on an empty input", () => {
    // The real inputs are non-empty — that is the precondition the half relies on.
    assert.ok(TRACKED.length > 0, "the git index must be readable; an empty TRACKED would make the offline half meaningless");
    assert.ok(GITIGNORE.length > 0, ".gitignore must be readable");
    // Feed the half's exact two predicates an EMPTY index: the fail-safe must
    // NOT hold, i.e. the test would go red. A half that passes here is vacuous.
    const brainTrackedOnEmpty = [].some((f: string) => f.startsWith(".brain/"));
    assert.equal(brainTrackedOnEmpty, false, "on an empty index the fail-safe assertion MUST fail — that is what makes the real run meaningful");
    // …and the real index satisfies the fail-safe, so the live run is the
    // substantive case rather than the accidental one.
    assert.ok(
      TRACKED.some((f) => f.startsWith(".brain/")),
      "the real index tracks .brain/ — the offline half is asserting a real fact about this repo",
    );
  });

  // The derived predicate replaced a hand-typed inline regex. Deriving is only
  // an improvement if it is not WEAKER, so the old expression is kept here as
  // the oracle and every case is asserted against both.
  t("the derived isForbiddenTracked is not weaker than the inline predicate it replaced", () => {
    const inline = (f: string): boolean =>
      f.startsWith("data/") || f.startsWith(".agents/") || f.startsWith(".opencode/") || /^sites\/[^/]+\/server\//.test(f);
    // The cases the old inline expression was written to catch.
    for (const f of [
      "data/sessions/kimi.ai/default/state.json",
      ".agents/agent.md",
      ".opencode/x",
      "sites/foo/server/index.js",
    ]) {
      assert.equal(isForbiddenTracked(f), true, `must catch ${f}`);
      assert.equal(inline(f), true, `oracle agrees on ${f}`);
    }
    // The near-misses: a real path that must NOT be flagged. `sites/server/` is
    // the GOAL 142 shape (a run targeting sites/ directly) and must not match a
    // one-star pattern — this is asserted so a future "fix" cannot silently widen it.
    for (const f of [
      "sites/foo/src/index.js",
      "src/runtime/session-store.ts",
      "test/credential-leak-gate.test.ts",
      "docs/VISION.md",
      "sites/server/index.js",
      "sites/a/b/server/x.js",
    ]) {
      assert.equal(isForbiddenTracked(f), false, `must NOT catch ${f}`);
    }
    // And the live corpus really is clean under the derived predicate — the same
    // claim the real test makes, re-derived from the table rather than inlined.
    assert.deepEqual(TRACKED.filter(isForbiddenTracked), [], "the real index has no secret-bearing tracked path");
  });
});

/* ========================================================================
 * THE DECIDED CONTRACT, pinned hermetically. No network, no `gh`, no fixture
 * pretending to be a repository: the red/green proof below builds REAL git
 * repositories and measures them with the SAME functions the live half uses.
 * ===================================================================== */

/** The visibility probe's own tri-state, resolved as data.
 *
 *  Extracted from the live half so that the honesty property is TESTABLE rather
 *  than merely intended: an unreachable API must never be resolved into
 *  "private", because "private" is the branch that permits the corpus to travel.
 *  Collapsing `null` into `false` would invert the safe direction and is the
 *  exact class of bug this file has already caught once (a try/catch that made
 *  its `isPrivate` branch unreachable). */
export type VisibilityProbe = { proven: true; isPrivate: boolean } | { proven: false; reason: string };

export function resolveVisibilityProbe(isPrivate: boolean | null): VisibilityProbe {
  if (isPrivate === null) {
    return {
      proven: false,
      reason: "visibility could not be established: an unknown is NOT a private repo, so no exposure verdict is derived",
    };
  }
  return { proven: true, isPrivate };
}

/** Build a REAL throwaway git repository, one commit per entry.
 *  A `body` of `null` DELETES the path in its own commit — which is how the
 *  tip-clean-but-history-dirty shape is constructed, and that shape is the whole
 *  point of the new contract. */
function scratchRepo(entries: Array<{ path: string; body: string | null }>): string {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-corpus-gate-"));
  const g = (...args: string[]): string =>
    execFileSync("git", args, { encoding: "utf8", cwd: dir, timeout: 120000 });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "gate@example.invalid");
  g("config", "user.name", "corpus gate");
  for (const e of entries) {
    if (e.body === null) {
      g("rm", "-q", "--", e.path);
    } else {
      const full = join(dir, e.path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, e.body);
      g("add", "-A", "--", e.path);
    }
    g("commit", "-q", "-m", e.body === null ? `remove ${e.path}` : `add ${e.path}`);
  }
  return dir;
}

/** The retired rule's view of a repo: the paths present at HEAD only.
 *  Kept as a named function, not as a claim, because the red/green proof below
 *  CONTRASTS it against every-commit containment and the contrast is the
 *  evidence that the new property is stronger. */
const tipPaths = (repoDir: string): string[] =>
  gitIn(repoDir, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);

d("GOAL 164/173: corpus containment for the PUBLIC DESTINATION, under the decided topology", () => {
  t("the corpus path list is READ AS DATA from the file filter-repo is actually fed", () => {
    assert.ok(CORPUS_PATHS.length > 0, "scripts/ci/public-repo-paths.txt must yield at least one path");
    // The list must include the three entries whose PATHS look innocent. These
    // are the reason a `.brain*` name glob is a weaker probe, and they are
    // pinned by name so deleting one from the list is a deliberate, visible act.
    for (const p of [".brain/", "VERBATIM.md", "raw/VERBATIM-RAW.md", "docs/handoffs/2026-09-20-crash-checkpoint.md", "docs/handoffs/2026-09-20-14-10-crash-handoff.md"]) {
      assert.ok(CORPUS_PATHS.includes(p), `${p} must stay on the corpus path list — it is corpus under an innocent path`);
    }
    // …and must NOT be reducible to a `.brain*` glob. If every entry started
    // with `.brain/`, the list would have silently become the weaker probe.
    const outsideBrain = CORPUS_PATHS.filter((e) => !e.startsWith(".brain/"));
    assert.ok(outsideBrain.length > 0, "the list must reach corpus material OUTSIDE .brain/ — otherwise it is just a name glob");
  });

  t("the matcher honours the list file's own documented FORMAT semantics", () => {
    // A trailing slash is a RECURSIVE directory; anything else is exact. Both
    // directions are load-bearing, and public-repo-paths.txt:100-106 documents
    // exactly this, so the test and the filter cannot disagree.
    assert.equal(isCorpusPath(".brain/verbatim.md"), true, "a trailing-slash entry is recursive");
    assert.equal(isCorpusPath(".brain/parked-gates/x.md"), true, "recursion reaches nested corpus");
    assert.equal(isCorpusPath("VERBATIM.md"), true, "an exact entry matches itself");
    assert.equal(isCorpusPath("src/index.ts"), false, "ordinary project paths are not corpus");
    // `docs/handoffs/` is deliberately NOT a list entry: only two specific files
    // under it are corpus. A matcher that treated every entry as a directory
    // would flag every handoff, and this asserts it does not.
    assert.equal(isCorpusPath("docs/handoffs/2026-09-20-crash-recovery.md"), false, "an EXCLUDED sibling handoff must not be swept in by prefix matching");
    assert.equal(isCorpusPath("docs/verbatim/ledger.md"), true, "the historical docs/ corpus location is covered too");
  });

  t("anti-vacuity: the every-commit enumeration really is TOTAL — it measures THIS repo as dirty, with a count", (tt) => {
    // The scanner must fire on a repo that provably carries the corpus. If this
    // ever reads zero, every "clean" verdict this gate produces is blind, and a
    // blind scanner is worse than no scanner because it reports success.
    const { paths, commits } = corpusContainment(ROOT);
    assert.ok(paths.length > 0, `the corpus enumeration found 0 paths in a repo that tracks .brain/ — the scanner is BLIND, not clean`);
    assert.ok(commits.length > 0, "the offending COMMITS must be nameable, not just the paths — a count without a commit is not actionable");
    tt.diagnostic(`every-commit corpus containment over this repo: ${paths.length} paths, ${commits.length} commits`);
    // Disclosed with a FLOOR and a CEILING, both taken from the path list's own
    // documentation rather than invented here.
    //
    // MEASURED 2026-10-01, 49 distinct corpus paths, broken down as 34 under
    // `.brain/`, 13 under `docs/`, plus `VERBATIM.md` and `raw/VERBATIM-RAW.md`.
    //
    // public-repo-paths.txt:17 says "55 distinct paths", and the two numbers are
    // both correct: 55 is the count its name-grep turned up BEFORE classification,
    // and that same comment block says each of the 55 "was then read and
    // classified by CONTENT into INCLUDE / EXCLUDE". Six were excluded as
    // boundary cases (a status report, a design doc, and the two gates that
    // mention the corpus), leaving 49 on the list. Pinning 55 as the expected
    // count would have been wrong, and the ONLY reason this is known is that the
    // gate measures the repo rather than re-typing the list file's prose.
    //
    // The floor catches the failure that matters — a corpus that has collapsed,
    // or an enumeration that has stopped reaching history. The ceiling catches
    // the opposite and quieter one: brain material that the list no longer
    // strips, which would show up as a count ABOVE the candidate pool the list
    // was derived from. An exact `===` is deliberately not used: the corpus grows
    // every fold, and a pin that must be bumped on every landing is a pin people
    // learn to bump without reading.
    assert.ok(
      paths.length >= 49,
      `expected at least the 49 corpus paths MEASURED 2026-10-01, found ${paths.length} — the corpus collapsed or the enumeration stopped reaching history`,
    );
    assert.ok(
      paths.length <= 55,
      `found ${paths.length} corpus paths but the path list was derived from a 55-path candidate pool (public-repo-paths.txt:17): something brain-shaped is no longer being stripped. Re-derive the list from CONTENT, not from a name glob.`,
    );
  });

  t("RED -> GREEN: a tip-clean but history-dirty destination is CAUGHT by every-commit containment, and MISSED by the retired tip-level rule", (tt) => {
    // THE PROOF THAT THE NEW CONTRACT IS STRONGER, on a real repository.
    //
    // Built shape: commit the corpus, then DELETE it, then keep going. HEAD is
    // clean; history is not. That is precisely the signature of a `filter-repo`
    // run whose `--invert-paths` is missing (MEASURED on pipeline 915 — the
    // filter keeps ONLY the corpus and drops the code), and it is invisible to
    // any check that reads the tip.
    const repo = scratchRepo([
      { path: "docs/verbatim.md", body: "# the operator's own words\n" },
      { path: "docs/verbatim.md", body: null },
      { path: "src/index.ts", body: "export const ok = 1;\n" },
    ]);
    try {
      // --- the retired rule's measurement, on a real repo -------------------
      const atTip = tipPaths(repo).filter((p) => isCorpusPath(p));
      assert.deepEqual(atTip, [], "precondition: HEAD really is clean — that is the whole trap");
      tt.diagnostic(`retired tip-level rule would have reported this repo CLEAN (0 corpus paths at HEAD)`);

      // --- the new measurement, on the SAME repo ----------------------------
      const { paths, commits } = corpusContainment(repo);
      assert.deepEqual(paths, ["docs/verbatim.md"], "every-commit containment MUST see the deleted-but-still-reachable corpus path");
      assert.equal(commits.length, 2, "the commits that touched the corpus path must be counted and reported");

      // --- and it is classified as a FAILURE, with count and commit ---------
      const exposure = classifyCorpusExposure("example/public-dest", {
        destinationIsPrivate: false,
        corpusPaths: paths,
        corpusCommits: commits,
        destinationBrainIgnored: false,
        granularity: "every-commit",
      });
      assert.equal(exposure.state, "public-and-dirty", "a public destination carrying the corpus must classify as dirty");
      assert.equal(
        exposure.state === "public-and-dirty" ? exposure.corpusPathCount : -1,
        1,
        "the count must be carried on the verdict, not dropped",
      );
      const named = exposure.state === "public-and-dirty" ? exposure.firstOffendingCommit : null;
      assert.match(String(named), /^[0-9a-f]{40}$/, "the offending commit must be named as a real hash, so the finding is actionable");
      // The gate itself refuses, loudly, with both numbers in the message.
      assert.throws(
        () => assertDestinationNotExposed(exposure),
        /CORPUS EXPOSURE.*1 corpus path\(s\).*first offending commit [0-9a-f]{40}/s,
        "a dirty PUBLIC destination must be refused, with the count AND the offending commit in the message",
      );

      // --- GREEN: the same shape, sanitised, passes -------------------------
      const clean = scratchRepo([{ path: "src/index.ts", body: "export const ok = 1;\n" }]);
      try {
        const c = corpusContainment(clean);
        assert.deepEqual(c.paths, [], "a repo that never carried the corpus must measure clean");
        const ok = classifyCorpusExposure("example/public-dest", {
          destinationIsPrivate: false,
          corpusPaths: c.paths,
          corpusCommits: c.commits,
          destinationBrainIgnored: true,
          granularity: "every-commit",
        });
        assert.equal(ok.state, "public-and-clean", "a sanitised public destination must classify clean");
        assert.doesNotThrow(() => assertDestinationNotExposed(ok), "a clean public destination must NOT be refused");
        // The accepted class is printed WITH its count, never silently dropped.
        assert.match(describeExposure(ok), /corpusPaths=0/, "an accepted class must be printed with its count");
        assert.match(describeExposure(ok), /granularity=every-commit/, "the accepted class must name its granularity");
      } finally {
        rmSync(clean, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  t("EXHAUSTIVE: the classification is total, and an unproven visibility derives NO verdict", () => {
    // Every legitimate visibility/containment combination lands on exactly one
    // legal state, so no input can fall through into an undefined third thing.
    for (const isPrivate of [true, false]) {
      for (const n of [0, 1, 7]) {
        for (const granularity of ["every-commit", "tip"] as const) {
          const paths = n === 0 ? [] : Array.from({ length: n }, (_, i) => `.brain/f${i}.md`);
          const commits = n === 0 ? [] : Array.from({ length: n }, () => "a".repeat(40));
          const e = classifyCorpusExposure("r", {
            destinationIsPrivate: isPrivate,
            corpusPaths: paths,
            corpusCommits: commits,
            destinationBrainIgnored: false,
            granularity,
          });
          assert.ok(["private", "public-and-clean", "public-and-dirty"].includes(e.state), `unhandled state ${e.state}`);
          assert.ok(e.reason.length > 0, "every verdict carries a NAMED reason");
          if (isPrivate) assert.equal(e.state, "private", "a private destination permits the corpus to travel");
          else if (n === 0) assert.equal(e.state, "public-and-clean", "a public destination with zero corpus paths is clean");
          else assert.equal(e.state, "public-and-dirty", "a public destination carrying ANY corpus path is dirty");
        }
      }
    }
    // The honesty property, hermetically: an unproven probe is NOT a private
    // repo. Collapsing `null` into `false` would let an unreachable API resolve
    // to the one branch that permits the corpus to travel.
    const unknown = resolveVisibilityProbe(null);
    assert.equal(unknown.proven, false, "an unreachable visibility probe must be reported as UNPROVEN");
    assert.match(unknown.reason, /NOT a private repo/, "the refusal must say why an unknown is not a yes");
    assert.equal(resolveVisibilityProbe(true).proven, true, "a reachable probe must be PROVEN");
    assert.equal(resolveVisibilityProbe(false).proven, true, "a reachable probe must be PROVEN");
    // Narrow on the discriminant before reading the payload: `VisibilityProbe` is a
    // union, so `.isPrivate` does not exist on the unproven arm. Reading it through
    // `proven &&` both satisfies the type and asserts the thing that actually
    // matters — that the reachable arms are proven, not merely that they carry a
    // boolean. `tsc -p tsconfig.test.json` is the gate that caught this; the
    // default project does not compile the test tree.
    const provenPrivate = resolveVisibilityProbe(true);
    const provenPublic = resolveVisibilityProbe(false);
    assert.equal(provenPrivate.proven && provenPrivate.isPrivate, true, "a proven-private destination must report private");
    assert.equal(provenPublic.proven && provenPublic.isPrivate, false, "a proven-public destination must report NOT private");
  });

  t("the gitignore rule is KEPT, and scoped to the DESTINATION — asserted on both sides so neither half can drift", () => {
    // KEPT, on the grounds that it remains a genuine ADDITIONAL defence for the
    // public destination specifically: history filtering removes the corpus from
    // the PAST, and nothing prevents someone ADDING it back tomorrow. .gitignore
    // is what stops that, and it is a real control for the real threat.
    //
    // It is NOT asserted about this working repo, because that assertion was the
    // bug: here `.brain` is correctly tracked, and the same rule cannot be true of
    // both repos. Both sides are pinned so the scoping is explicit rather than
    // implied by whichever line a reader happens to read first.
    assert.equal(brainIgnoreRule(".brain/\n"), true, "the destination rule must fire on a `.brain/` line");
    assert.equal(brainIgnoreRule("node_modules\n.brain\n"), true, "the bare `.brain` spelling is the same rule to git and must be accepted");
    assert.equal(brainIgnoreRule(".brainstorm\ndata/\n"), false, "a merely similar path must not satisfy the rule");
    // This side: the working repo must NOT ignore the corpus, and that is correct.
    assert.equal(
      brainIgnoreRule(GITIGNORE),
      false,
      "the WORKING repo must NOT gitignore .brain/ — the corpus is tracked here on purpose, and the destination rule does not apply to it",
    );
    // …and the destination's rule is carried on the verdict, measured not assumed.
    const clean = classifyCorpusExposure("r", {
      destinationIsPrivate: false,
      corpusPaths: [],
      corpusCommits: [],
      destinationBrainIgnored: false,
      granularity: "every-commit",
    });
    assert.equal(clean.state, "public-and-clean");
    assert.match(
      describeExposure(clean),
      /brainIgnoredInDestination=false/,
      "the destination's missing gitignore defence must be PRINTED with its measured value, not silently dropped",
    );
  });
});


/**
 * ── THE RELEASE EXCLUSION LIST HAS ONE OWNER, AND EVERY READER DERIVES ──────
 *
 * A SECOND corpus-leak surface, in the same family as the history filter above
 * and gated in the same file for the same reason: the thing that must never
 * ship is the operator's private corpus, and the list that keeps it out of a
 * publicly downloadable artifact is a security control, not a style choice.
 *
 * WAS: the forbidden-path list had THREE owners across TWO files, and had
 * already drifted:
 *
 *   scripts/ci/package-release.sh         stage sweep      — MISSED `.brain/`
 *   scripts/ci/package-release.sh         tar-listing scan — HAD  `.brain/`
 *   scripts/ci/publish-github-release.sh  served-byte scan — MISSED `.brain/`
 *
 * Only the middle copy carried the entry, and it was the copy nothing else
 * agreed with. The consequence is concrete and was live: the third one is the
 * check on the bytes GitHub actually serves, so a release tarball carrying
 * `.brain/` printed `served asset exclusions re-checked: clean` and
 * `RELEASE-OK`. The stage sweep would not have stripped it either. The packer's
 * own tar-listing scan would still have caught it at build time — which is
 * exactly why the gap survived: the one gate that worked was also the one
 * nobody thought to check for agreement with the other two.
 *
 * THE OWNER is `scripts/ci/forbidden-release-paths.txt`, mirroring how
 * `public-repo-paths.txt` is owned above. Three readers, one list.
 *
 * THE PIN is deliberately NOT "the list contains .brain/". That assertion
 * passes just as happily if a fourth reader is added with its own literal, and
 * the defect was never the absence of an entry — it was the DISAGREEMENT
 * between copies. So the gates below are structural: every reader must name the
 * owner file, and no reader may contain a hand-typed list at all.
 */
/** Drops PROSE so a "no hand-typed list" pin cannot be tripped by a comment
 *  QUOTING the old list. This bit for real while writing the gate below: the
 *  explanatory comment recording the pre-fix sweep (`for bad in data
 *  node_modules wigolo ...`) is itself that exact string, so a naive scan
 *  reported the FIXED script as still carrying its own list. A comment is not a
 *  duplicate owner, and the duplicate owner is what the gate is for. */
function stripShellProse(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/#.*$/, ""))
    .join("\n");
}

d("RELEASE EXCLUSIONS: one owner, three deriving readers", () => {
  const OWNER = join(ROOT, "scripts/ci/forbidden-release-paths.txt");
  // Read the CODE, not the prose: these scripts document the pre-fix lists in
  // comments, and a scan that counts comments reports a fixed script as broken.
  const PACKER = stripShellProse(readFileSync(join(ROOT, "scripts/ci/package-release.sh"), "utf8"));
  const PUBLISHER = stripShellProse(readFileSync(join(ROOT, "scripts/ci/publish-github-release.sh"), "utf8"));
  const READERS: readonly [string, string][] = [
    ["scripts/ci/package-release.sh", PACKER],
    ["scripts/ci/publish-github-release.sh", PUBLISHER],
  ];

  t("the owner file exists and yields paths", () => {
    assert.ok(existsSync(OWNER), "scripts/ci/forbidden-release-paths.txt must exist — it is the single owner of the release exclusion list");
    const paths = parseCorpusPaths(readFileSync(OWNER, "utf8"));
    assert.ok(paths.length > 0, "the owner file must yield at least one forbidden path");
  });

  t("the owner's list still carries the two classes that must never ship", () => {
    // The entries that make this a SECURITY control rather than a tidy-up: the
    // real-credential vault, and the operator's raw transcripts.
    const paths = parseCorpusPaths(readFileSync(OWNER, "utf8"));
    assert.ok(paths.includes("data/"), "the session vault (real cookies + Bearer tokens) must stay excluded");
    assert.ok(paths.includes(".brain/"), "the operator's raw transcripts must stay excluded — this is the entry the other two copies had dropped");
  });

  for (const [file, src] of READERS) {
    t(`${file} READS the owner rather than carrying its own list`, () => {
      assert.match(src, /forbidden-release-paths\.txt/, `${file} must derive its forbidden-path list from the single owner`);
      assert.doesNotMatch(
        src,
        /FORBIDDEN_PREFIXES=\(data\//,
        `${file} still TYPES a forbidden-path list — that is the duplicate owner this closed`,
      );
    });
  }

  t("the SERVED-asset check USES the derived list, not a literal alternation", () => {
    // Added after the first version of this gate FAILED a mutation: restoring
    // the hard-coded `data|node_modules|...` alternation in the publisher left
    // every assertion above GREEN, because the script still *named* the owner
    // file (it still built FORBIDDEN_ALT) while no longer USING it. Asserting
    // "reads the owner" is not the property; the property is "the bytes GitHub
    // serves are checked against the owner's list". Naming without using is
    // exactly how a fix is faked, so the check is pinned at the grep itself.
    assert.match(
      PUBLISHER,
      /grep \-qE "\^\\\.\/\?\(\$\{FORBIDDEN_ALT\}\)\/"/,
      "the served-asset check must match against ${FORBIDDEN_ALT} — a literal alternation here is a second owner that can miss .brain/",
    );
    // …and no hard-coded alternation of forbidden paths survives anywhere.
    assert.doesNotMatch(
      PUBLISHER,
      /data\|node_modules\|wigolo/,
      "the publisher still TYPES its own alternation — the copy that had no .brain alternative",
    );
  });

  t("the packer's tar-listing check uses the loop variable, not an inline list", () => {
    assert.match(
      PACKER,
      /grep \-qE "\^\\\.\/\?\$\{bad\}"/,
      "the packer's exclusion scan must match the per-entry loop variable",
    );
  });

  t("the packer's STAGE sweep also derives — it is a third copy site, not a fourth owner", () => {
    // Two loops in one script is exactly the shape that hid the gap, so both
    // are counted here: the stage sweep reads the file into the same loop.
    const reads = PACKER.match(/FORBIDDEN_PATHS_FILE/g)?.length ?? 0;
    assert.ok(reads >= 2, `both the stage sweep and the tar-listing scan must read the owner file (saw ${reads} references)`);
    assert.doesNotMatch(
      PACKER,
      /for bad in data node_modules/,
      "the stage sweep still carries its own hand-written list — and that copy was the one missing .brain/",
    );
  });

  t("MUTATION: the derived served-asset regex actually catches .brain/ (executed, not asserted)", () => {
    // Structural pins above prove the wiring; this one proves the WIRING WORKS.
    // The published pattern is reproduced here exactly as the script builds it,
    // including the deslash-BEFORE-escape order — which was measured, not
    // assumed: escaping first (with `/` in the class) leaves a trailing backslash
    // on every entry, turning the separator into a literal `\|` and the whole
    // pattern into an invalid regex that matches NOTHING. A vacuous gate that
    // never matches is worse than no gate, because it reports clean.
    const paths = parseCorpusPaths(readFileSync(OWNER, "utf8"));
    const alt = paths
      .map((p) => p.replace(/\/$/, "").replace(/[.[\*^$\\]/g, (c) => `\\${c}`))
      .join("|");
    const re = new RegExp(`^\\./?(${alt})/`);
    // The case the three-copy drift lost.
    assert.ok(re.test("./.brain/verbatim-goals.md"), "the derived pattern MUST catch .brain/ — this is the regression the drift allowed");
    assert.ok(re.test("./data/sessions/kimi/state.json"), "and it must still catch the vault");
    // Prefix semantics: `data` must not swallow `database`, and `.git` must not
    // match `Xgit` (which is what the escaping is FOR).
    assert.ok(!re.test("./database/schema.sql"), "`data/` is a PREFIX — it must not match database/");
    assert.ok(!re.test("./Xgit/config"), "`.git` must be escaped — it must not match Xgit/");
  });
});
