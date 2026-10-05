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

/* ========================================================================
 * GOAL 183 — A BEHAVIOUR CHANGE MUST SHIP WITH ITS TEST.
 *
 * WHY THIS FILE, AND WHY THIS SECTION.
 *   This file's whole subject is a SHIPPED ARTIFACT THAT PASSES EVERY CHECK
 *   WHILE CARRYING THE DEFECT: a credential red line resting on one line of
 *   .gitignore that zero tests read; a release tarball that printed
 *   `exclusions re-checked: clean` over bytes carrying `.brain/`; a
 *   tip-clean destination whose history was dirty. GOAL 183 is the same shape
 *   one level up — a residue that compiled cleanly, passed every test that
 *   exists, and shipped a renamed copy of the very bug it existed to kill.
 *   The common root is not "a bad edit"; it is that NOTHING MEASURED THE
 *   COMBINATION. Every check this repo had was asking "is the code correct?"
 *   and none was asking "did the proof travel with the code?".
 *
 * THE MEASURED FAILURE (GOAL 183's own text).
 *   Four delegated lanes returned truncated results and three died at a
 *   HANDOFF. The worst wrote a credential-path behaviour change into
 *   src/runtime/session-store.ts and returned the literal string "Now the
 *   gate test file:". Its residue compiled cleanly and passed every test that
 *   existed. A reviewer read it by hand, found `tsc` clean and the covering
 *   tests green, and called it "coherent and correct". It was not.
 *
 * WHY A COMMIT-RANGE CHECK, AND NOT A WORKING-TREE CHECK.
 *   "Shipped together" is a fact about what LANDED, and the unit that landed is
 *   the commit. This is also the only scope that is sound in a repo where four
 *   agents share one worktree: a working-tree rule would fire on every
 *   in-flight edit, and test/gate-wiring.test.ts already records that exact
 *   false positive as the class that teaches people to ignore a gate. So the
 *   honest limit of this gate is stated up front: it judges SHIPPED changes.
 *   An uncommitted residue — the literal GOAL-183 shape — is invisible to any
 *   commit-range rule, and is covered by the independent-verifier rung instead.
 *
 * THE SCOPE BOUNDARY, DECIDED, WITH THE FALSE-POSITIVE ARGUMENT.
 *   A repo legitimately changes comments, docs, generated files and formatting
 *   with no test, so "any file under src/ changed" is NOT the rule. This repo
 *   has already shipped two gates that were vacuous for exactly that reason, so
 *   the boundary is defined by WHAT THE CHANGE ACTUALLY IS rather than by a
 *   directory or a heuristic:
 *
 *     A BEHAVIOUR CHANGE is a path in the shipped compile set — derived from
 *     tsconfig.json's own `include`, never a hand-typed `src/` — whose CONTENT
 *     changes once every COMMENT and every WHITESPACE character is removed.
 *     String and template-literal contents are preserved, because a changed
 *     string literal IS a behaviour change (`"dry run"` -> `"CHANGED"` was one
 *     of the four real findings below).
 *
 *     THE COMMENT/FORMAT INSENSITIVITY IS NOT NICETY, IT IS THE FALSE-POSITIVE
 *     CONTROL, and it is measured on this repo's real history rather than
 *     argued: over the last 120 commits the naive rule ("a src/*.ts path was
 *     touched and no test/ path was touched") flags 6 commits, and this rule
 *     flags 4. The 2 extra are commits whose entire src change was comments and
 *     whitespace; 28 individual changed src files in that window were
 *     comment/format-only and are correctly silent. A gate that cried wolf on
 *     those would have been switched off, which is the outcome the goal names
 *     as the one this repo has already produced twice.
 *
 *     MEASURED THROUGH THIS GATE'S OWN FUNCTIONS over those same 120 commits:
 *     27 accompanied, 4 unaccompanied, 89 with no behaviour change. All 4 reds
 *     are true positives — `src/plugin/wigolo-context.ts` (the wigolo tier may
 *     not invent a success), `src/agent/acp.ts` twice (the ACP credential gate,
 *     and the hub publish hardening), and `src/cli.ts` (refusing unknown
 *     flags) — each a real behaviour change whose own commit moved no test.
 *
 *     AND THE COMMENT CASE IS NOT HYPOTHETICAL: commit 61d65a1, the very commit
 *     that corrected a phantom gate claim on the credential path, changes
 *     `src/runtime/session-store.ts` ENTIRELY in comments. A naive rule flags
 *     it; this rule reports zero behaviour files, which is the correct answer.
 *
 *   THE ASYMMETRY. A commit that changes shipped behaviour AND moves the
 *   verification surface is fine. One that changes shipped behaviour with NO
 *   verification change is the defect. `sites/`, `data/`, `dist/`, `capabilities/`
 *   and `docs/` are excluded — BY DERIVATION, not by a hand-typed list: they are
 *   not in tsconfig.json's `include`, so they cannot be behaviour changes. A
 *   list of forbidden directories would be a second place to forget an entry,
 *   which is the rot this file's own `isForbiddenTracked` rewrite already had to
 *   remove once.
 *
 *   THE VERIFICATION SURFACE is derived the same way, from three shipped files
 *   rather than from `test/` typed out: tsconfig.test.json's `include` minus
 *   tsconfig.json's `include`, restricted to the directory the unit suite
 *   actually runs its files from (the common root of the paths named by
 *   scripts["test:unit"]). It is not restricted to `.ts`, because a commit whose
 *   only test-side change is a JSON fixture is still a commit that moved the
 *   verification surface — and it is NOT counted when the test-side edit is
 *   comment-only, because "add a comment to a test" is not proof and must not be
 *   able to buy a green gate.
 *
 *   KNOWN FALSE NEGATIVES, named rather than discovered later:
 *     - `scripts/**` is typechecked by tsconfig.test.json but is NOT in the
 *       shipped build, so a behaviour change confined to a CI/ops script is not
 *       gated here.
 *     - A regex literal containing `//` can make the scanner read the rest of the
 *       line as a comment, hiding a same-line change. Swept: across all 99
 *       tracked src/*.ts files, appending a statement to the file always changes
 *       the stripped text, so no real file is currently blind to this.
 *     - A commit that ships behaviour in one commit and its test in a later
 *       commit is flagged on the first. That is the intended direction: the
 *       moment it shipped, nothing had verified it.
 *
 * WHY A RANGE IS STILL THE RIGHT UNIT, AND WHAT IT COSTS.
 *   `measureRange` accepts any range so an operator or a CI job can point the
 *   gate at a landing unit (`UI2API_VERIFY_RANGE=<a>..<b>`), and the enforcing
 *   half is a SEPARATE function so every branch — including the failing one — is
 *   reachable without this repository. The default is the commit that just
 *   landed, `HEAD^..HEAD`, which is measurable in CI because
 *   test/clone-depth.test.ts already fails a truncated checkout outright. An
 *   UNRESOLVABLE range is refused, never treated as a pass: a gate that cannot
 *   see the commit must not report that the commit was clean.
 * ===================================================================== */

/** TypeScript with every COMMENT and every WHITESPACE character removed.
 *
 *  String and template-literal contents are preserved VERBATIM, delimiters
 *  included. That asymmetry is the whole design and it is deliberate in both
 *  directions:
 *   - a comment is not executable, so removing it is what makes the false
 *     positive go away (measured above: 2 of the naive rule's 6 hits);
 *   - a literal IS the value, so blanking it would make `"dry run"` ->
 *     `"CHANGED"` invisible — and that is precisely the shape of the
 *     `vault tighten --apply` finding, a report whose text described a
 *     different action from the one taken.
 *
 *  It is a character scanner rather than a regex because the naive forms are
 *  destructive here and the repo has already been bitten by both: a
 *  `.replace(/\/\/.*$/gm)` eats the `//` of every `https:` inside a string
 *  literal, and a non-greedy block-comment regex mis-pairs on files with more
 *  block terminators than openers. Tracking string/template state is what makes
 *  both safe.
 */
export function stripTs(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  let st: "code" | "line" | "block" | "str" | "tpl" | "tplexp" = "code";
  let quote = "";
  while (i < n) {
    const c = src[i] as string;
    const d = src[i + 1];
    if (st === "code") {
      if (c === "/" && d === "/") { st = "line"; i += 2; continue; }
      if (c === "/" && d === "*") { st = "block"; i += 2; continue; }
      if (c === '"' || c === "'") { st = "str"; quote = c; out += c; i++; continue; }
      if (c === "`") { st = "tpl"; out += c; i++; continue; }
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      out += c; i++; continue;
    }
    if (st === "line") { if (c === "\n") st = "code"; i++; continue; }
    if (st === "block") { if (c === "*" && d === "/") { st = "code"; i += 2; continue; } i++; continue; }
    if (st === "str") {
      out += c;
      if (c === "\\" && i + 1 < n) { out += d as string; i += 2; continue; }
      if (c === quote) st = "code";
      i++; continue;
    }
    // template literal, and the code inside its ${…} holes
    if (c === "\\") { out += c + (d ?? ""); i += 2; continue; }
    if (c === "`") { out += c; st = "code"; i++; continue; }
    if (c === "$" && d === "{") { out += "${"; st = "tplexp"; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** One tsconfig's `include`/`exclude`, as data. Read rather than re-typed, so
 *  the shipped compile set and this gate cannot drift apart. */
export function tsconfigGlobs(repoDir: string, file: string): { include: string[]; exclude: string[] } {
  const doc = JSON.parse(readFileSync(join(repoDir, file), "utf8")) as {
    include?: unknown;
    exclude?: unknown;
  };
  const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { include: asList(doc.include), exclude: asList(doc.exclude) };
}

/** One include/exclude glob to an anchored matcher.
 *  `**` spans zero or more path segments, `*` and `?` stay inside one. Enough
 *  for the shapes a tsconfig `include` actually uses; anything else is escaped,
 *  so an unrecognised glob matches literally rather than matching everything.
 *  Built by hand rather than by chained `.replace()`: the first version used
 *  sentinel characters to stand in for `**`, and the sentinels ended up INSIDE
 *  the regex source as literal control characters, which is the shape that makes
 *  a matcher throw on some inputs and match nothing on others. */
export function globToMatcher(glob: string): (p: string) => boolean {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    const d = glob[i + 1];
    if (c === "*" && d === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (c === "*") { out += "[^/]*"; i++; continue; }
    if (c === "?") { out += "[^/]"; i++; continue; }
    out += c.replace(/[.+^${}()|[\]\\]/, "\\$&");
    i++;
  }
  const re = new RegExp(`^${out}$`);
  return (p) => re.test(p);
}

const matchesAny = (p: string, globs: readonly string[]): boolean => globs.some((g) => globToMatcher(g)(p));

export interface SurfaceModel {
  /** globs tsconfig.json compiles into the shipped build — the behaviour surface */
  behaviour: readonly string[];
  /** globs the unit suite verifies — the accompaniment surface */
  verification: readonly string[];
  /** the directory the unit suite runs its files from, derived from package.json */
  unitRoot: string;
  prodConfig: string;
  testConfig: string;
  unitScript: string;
}

/** The two surfaces, DERIVED from three shipped files.
 *
 *  Not `["src/**"]` and `["test/**"]` typed out: this repo's rule is that a list
 *  a human maintains rots on the day the layout moves, and the gate would then
 *  judge a partial corpus — which is the failure every anti-vacuity pin in this
 *  file exists to catch. Move a directory, update package.json and the
 *  tsconfigs, and the gate follows without being edited.
 */
export function classifySurfaces(repoDir: string = ROOT): SurfaceModel {
  const prod = tsconfigGlobs(repoDir, "tsconfig.json");
  const testCfg = tsconfigGlobs(repoDir, "tsconfig.test.json");
  const pkg = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const unitScript = String(pkg.scripts?.["test:unit"] ?? "");
  const named = [...unitScript.matchAll(/(?:^|[\s"'])([\w.-]+\/[\w./-]+)/g)].map((m) => m[1] as string);
  // The unit root is the LONGEST common directory prefix of the files the unit
  // suite is told to run. Derived, and it fails loudly rather than guessing.
  const dirs = [...new Set(named.map((p) => p.split("/").slice(0, -1).join("/")))];
  let unitRoot = dirs.length > 0 ? dirs[0] as string : "";
  for (const d of dirs.slice(1)) {
    const a = unitRoot.split("/");
    const b = d.split("/");
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k++;
    unitRoot = a.slice(0, k).join("/");
  }
  const behaviour = prod.include.filter((g) => !matchesAny(g, prod.exclude));
  const verification = testCfg.include.filter(
    (g) => !matchesAny(g, testCfg.exclude) && !behaviour.includes(g) && g.split("/")[0] === unitRoot,
  );
  if (behaviour.length === 0) throw new Error(`tsconfig.json's include yielded no behaviour glob in ${repoDir} — the gate would judge nothing`);
  if (verification.length === 0) throw new Error(`tsconfig.test.json's include yielded no verification glob under "${unitRoot}" in ${repoDir} — the gate could never see a test`);
  return { behaviour, verification, unitRoot, prodConfig: "tsconfig.json", testConfig: "tsconfig.test.json", unitScript: "scripts[\"test:unit\"]" };
}

export type ShippedVerdict = "accompanied" | "unaccompanied" | "no-behaviour-change" | "empty-range";

export interface ShippedFinding {
  sha: string;
  subject: string;
  behaviourFiles: string[];
  /** the verification files that moved with it — empty on a violation */
  verificationFiles: string[];
}

export interface ShippedVerification {
  range: string;
  commitsMeasured: number;
  behaviourFiles: string[];
  verificationFiles: string[];
  accompanied: ShippedFinding[];
  unaccompanied: ShippedFinding[];
  verdict: ShippedVerdict;
  reason: string;
}

/** A blob at `sha`, or `null` when the path does not exist there.
 *
 *  Existence is ASKED rather than inferred from a failed `git show`: a `show`
 *  that fails for any other reason (a truncated buffer, a lock) would otherwise
 *  be read as "the file was added", and "added" is a behaviour change — so an
 *  unreadable blob would become a FALSE POSITIVE, the one direction this gate
 *  must never fail in. */
function blobAt(repoDir: string, sha: string, path: string): string | null {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}:${path}`], { cwd: repoDir, stdio: "ignore", timeout: 60_000 });
  } catch {
    return null;
  }
  try {
    return gitIn(repoDir, "show", `${sha}:${path}`);
  } catch (e) {
    throw new Error(`git show ${sha}:${path} failed AFTER cat-file proved the path exists — refusing to classify it as a change: ${String(e)}`);
  }
}

const parentOf = (repoDir: string, sha: string): string | null => {
  try {
    return gitIn(repoDir, "rev-parse", "--verify", `${sha}^1`).trim();
  } catch {
    return null;
  }
};

/** The paths a commit landed, against its FIRST parent.
 *
 *  `-m --first-parent` is load-bearing and not decoration: plain `diff-tree` on a
 *  merge commit returns NOTHING, so a merge that shipped behaviour with no test
 *  would measure as an empty commit and pass. This repo has 19 merge commits,
 *  so that is not hypothetical. */
const commitPaths = (repoDir: string, sha: string): string[] =>
  gitIn(repoDir, "diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--first-parent", "--root", sha)
    .split("\n")
    .filter(Boolean);

/** Did this path's CONTENT change in a way that can change behaviour?
 *
 *  Added or deleted counts: removing a guard is a behaviour change with no
 *  surviving content to compare. For a `.ts` file the comparison is on the
 *  comment/whitespace-stripped text. For a NON-ts file under the verification
 *  surface (a JSON fixture, a markdown case table) it is a RAW comparison,
 *  because the comment scanner would misread markdown and would make a changed
 *  URL invisible — verified wrong in both directions while building this. */
function changedMaterially(before: string | null, after: string | null, path: string): boolean {
  if (before === null || after === null) return true;
  return path.endsWith(".ts") ? stripTs(before) !== stripTs(after) : before !== after;
}

/** Measure a commit range against the two surfaces. Pure over git, no network. */
export function measureRange(repoDir: string, range: string, surfaces: SurfaceModel = classifySurfaces(repoDir)): ShippedVerification {
  let shas: string[];
  try {
    shas = gitIn(repoDir, "rev-list", range).split("\n").filter(Boolean);
  } catch (e) {
    throw new Error(`range "${range}" could not be resolved in ${repoDir}: ${String(e)} — an unseeable range is NOT a pass`);
  }
  const behaviourMatcher = surfaces.behaviour.map(globToMatcher);
  const verificationMatcher = surfaces.verification.map(globToMatcher);
  const accompanied: ShippedFinding[] = [];
  const unaccompanied: ShippedFinding[] = [];
  const behaviourFiles = new Set<string>();
  const verificationFiles = new Set<string>();
  for (const sha of shas) {
    const parent = parentOf(repoDir, sha);
    const subject = (() => {
      try {
        return gitIn(repoDir, "log", "-1", "--format=%s", sha).trim();
      } catch {
        return "(subject unreadable)";
      }
    })();
    const beh: string[] = [];
    const ver: string[] = [];
    for (const p of commitPaths(repoDir, sha)) {
      if (behaviourMatcher.some((m) => m(p))) {
        if (changedMaterially(parent ? blobAt(repoDir, parent, p) : null, blobAt(repoDir, sha, p), p)) beh.push(p);
      } else if (verificationMatcher.some((m) => m(p))) {
        if (changedMaterially(parent ? blobAt(repoDir, parent, p) : null, blobAt(repoDir, sha, p), p)) ver.push(p);
      }
    }
    for (const p of beh) behaviourFiles.add(p);
    for (const p of ver) verificationFiles.add(p);
    if (beh.length === 0) continue;
    const finding: ShippedFinding = { sha, subject, behaviourFiles: beh, verificationFiles: ver };
    if (ver.length > 0) accompanied.push(finding);
    else unaccompanied.push(finding);
  }
  const base = { range, commitsMeasured: shas.length, behaviourFiles: [...behaviourFiles].sort(), verificationFiles: [...verificationFiles].sort(), accompanied, unaccompanied };
  if (shas.length === 0) {
    return { ...base, verdict: "empty-range", reason: `range "${range}" contains 0 commits — the gate measured nothing, which is not a pass` };
  }
  if (unaccompanied.length > 0) {
    return {
      ...base,
      verdict: "unaccompanied",
      reason: `${unaccompanied.length} of ${shas.length} commit(s) in "${range}" changed shipped behaviour with NO change to the verification surface`,
    };
  }
  if (accompanied.length === 0) {
    return { ...base, verdict: "no-behaviour-change", reason: `${shas.length} commit(s) in "${range}" moved no shipped behaviour` };
  }
  return { ...base, verdict: "accompanied", reason: `${accompanied.length} commit(s) in "${range}" changed shipped behaviour WITH a verification change` };
}

/** The enforcing half. THROWS on the one verdict that must not ship.
 *
 *  Separate from the measurement so the failing branch is reachable without this
 *  repository, and so the failure message can carry the commit and the file —
 *  "you shipped unverified behaviour" without the sha is not actionable. */
export function assertShippedWithTests(v: ShippedVerification): void {
  if (v.verdict === "empty-range") {
    throw new Error(`UNVERIFIED SHIP, VACUOUSLY: ${v.reason}. A gate that measured zero commits must say so, not pass.`);
  }
  if (v.verdict === "unaccompanied") {
    const detail = v.unaccompanied
      .map((f) => `  ${f.sha.slice(0, 8)}  ${f.behaviourFiles.join(" ")}\n      "${f.subject}"`)
      .join("\n");
    throw new Error(
      `UNVERIFIED SHIP: ${v.reason}.\n${detail}\n` +
        `A behaviour change on a path with no test is unverified no matter how cleanly it compiles: the checks that ` +
        `cannot detect the defect are exactly the ones that make it look verified. Ship the test with the change, in ` +
        `the same commit.`,
    );
  }
}

/** The range the live half judges: the commit that just landed.
 *
 *  Env-overridable so a CI job or the operator can point the gate at a whole
 *  landing unit instead. `HEAD^..HEAD` is the default because it is the unit
 *  that is measurable in CI (test/clone-depth.test.ts already fails a truncated
 *  checkout, so the parent is always there). */
export function defaultVerifyRange(): string {
  return process.env.UI2API_VERIFY_RANGE && process.env.UI2API_VERIFY_RANGE.trim() !== ""
    ? process.env.UI2API_VERIFY_RANGE.trim()
    : "HEAD^..HEAD";
}

/* ========================================================================
 * GOAL 183: the gate over synthetic commit ranges, then over the real one.
 * ===================================================================== */

/** A REAL throwaway git repository carrying its OWN tsconfigs and package.json.
 *
 *  The configs matter as much as the commits: `classifySurfaces` derives both
 *  surfaces from those three files, so a fixture that omitted them would prove
 *  nothing about the derivation — the measurement would silently fall back to
 *  whatever the gate hardcoded. Building the same layout the repo really has is
 *  what makes the red/green proof a proof of the DERIVATION, not of a fixture. */
function scratchRepoWithCommits(steps: Array<{ paths: Record<string, string | null>; subject: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "ui2api-unverified-ship-"));
  const g = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8", cwd: dir, timeout: 120_000 });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "gate@example.invalid");
  g("config", "user.name", "unverified-ship gate");
  // The layout, verbatim in shape: a shipped tsconfig, a test tsconfig that adds
  // the verification tree, and a unit script naming files under it.
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"], exclude: ["node_modules", "dist", "test"] }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "tsconfig.test.json"),
    JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { noEmit: true }, include: ["src/**/*.ts", "test/**/*.ts"], exclude: ["node_modules", "dist"] }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "scratch", scripts: { "test:unit": "node --test test/a.test.ts test/b.test.ts" } }, null, 2) + "\n",
  );
  g("add", "-A");
  g("commit", "-q", "-m", "layout: the shipped configs the gate derives from");
  const shas: string[] = [];
  for (const s of steps) {
    for (const [p, body] of Object.entries(s.paths)) {
      if (body === null) {
        g("rm", "-q", "--", p);
      } else {
        const full = join(dir, p);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, body);
        g("add", "-A", "--", p);
      }
    }
    g("commit", "-q", "-m", s.subject);
    shas.push(g("rev-parse", "HEAD").trim());
  }
  return dir;
}

const withScratch = <T>(dir: string, fn: () => T): T => {
  try {
    return fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

d("GOAL 183: a behaviour change must ship WITH its test", () => {
  t("the two surfaces are DERIVED from the shipped configs, and generated/vendor trees fall out by construction", () => {
    const s = classifySurfaces(ROOT);
    assert.deepEqual([...s.behaviour], ["src/**/*.ts"], "the behaviour surface must be what tsconfig.json compiles — read, not typed");
    assert.deepEqual([...s.verification], ["test/**/*.ts"], "the verification surface must be what tsconfig.test.json adds under the unit root");
    assert.equal(s.unitRoot, "test", "the unit root must come from the files scripts[\"test:unit\"] actually names");
    // The classification itself, on paths this repo really has. The generated /
    // vendored / corpus / doc trees are the exclusion argument: they are NOT in
    // tsconfig.json's include, so no hand-typed forbidden list is needed and
    // there is no second place to forget an entry.
    const isBehaviour = (p: string) => s.behaviour.some((g) => globToMatcher(g)(p));
    for (const p of ["src/cli.ts", "src/runtime/session-store.ts", "src/prompt/http.ts"]) {
      assert.ok(isBehaviour(p), `${p} is shipped source and must be the behaviour surface`);
    }
    for (const p of [
      "test/foo.test.ts", "test/helpers/doc-scan.ts", "test/fixtures/registry/index.json",
      "sites/gemini/server/index.js", "sites/gemini/.session/state.json",
      "data/sessions/kimi.ai/default/state.json", "dist/runtime/browser.js",
      "capabilities/gemini/manifest.json", "docs/VISION.md", "AGENTS.md", "package.json", "README.md",
    ]) {
      assert.ok(!isBehaviour(p), `${p} must NOT be a behaviour change — it is generated, vendored, corpus, config or prose`);
    }
  });

  t("the behaviour definition is comment- and whitespace-insensitive but LITERAL-sensitive", () => {
    // The two halves of the definition, each pinned in the direction that
    // matters. A scanner that blanked string contents would make the second case
    // pass and the first fail — which is how `"dry run"` -> `"CHANGED"` (the
    // `vault tighten --apply` finding) would have gone unmeasured.
    const base = 'export const MODE = "dry run";\n';
    assert.equal(stripTs(base), stripTs(`${base}// a note that changes nothing\n`), "a line comment is not executable");
    assert.equal(stripTs(base), stripTs(`/* block */\n${base}`), "a block comment is not executable");
    assert.equal(stripTs(base), stripTs("export   const   MODE   =   \"dry run\"  ;\n"), "reformatting is not a behaviour change");
    assert.notEqual(stripTs(base), stripTs('export const MODE = "CHANGED";\n'), "a changed string literal IS the behaviour change");
    assert.notEqual(stripTs("const s = `a b`;"), stripTs("const s = `ab`;"), "whitespace INSIDE a literal is data, not formatting");
    assert.notEqual(stripTs("const s = 'a';"), stripTs('const s = "a";'), "the delimiter is part of the literal");
    // And the `//`-inside-a-string case the naive regex gets wrong: a naive
    // `/\\/`-style line strip would eat the rest of this line.
    const url = 'export const U = "https://x/y";\nexport const AFTER = 1;\n';
    assert.notEqual(stripTs(url), stripTs(url.replace("AFTER = 1", "AFTER = 2")), "a // inside a string literal must not hide a real change after it");
  });

  t("the scanner is not blind on ANY real source file", (tt) => {
    // The known false negative — a regex literal containing `//` can make the
    // scanner read the rest of the line as a comment — is real, so it is
    // MEASURED on the whole corpus rather than trusted. Appending a statement to
    // a file must always change its stripped text; if it does not, that file's
    // tail is invisible to this gate, and the file is named.
    const files = gitIn(ROOT, "ls-files", "src/").split("\n").filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 50, `anti-vacuity: only ${files.length} src files enumerated — the sweep would be judging a partial corpus`);
    const blind: string[] = [];
    for (const f of files) {
      const body = readFileSync(join(ROOT, f), "utf8");
      if (stripTs(body) === stripTs(`${body}\nexport const __GOAL183_PROBE__ = 1;\n`)) blind.push(f);
    }
    assert.deepEqual(blind, [], `these shipped source files have an invisible tail — the scanner stops reading before the end:\n${blind.join("\n")}`);
    tt.diagnostic(`scanner sweep: ${files.length} shipped source files, 0 with an invisible tail`);
  });

  t("RED: a commit that changes shipped behaviour and NOTHING in the verification surface is refused", () => {
    // The GOAL 183 shape, built for real: a credential-path behaviour change
    // that landed without its gate. The refusal must name the commit and the
    // file, because "you shipped unverified behaviour" without them is not
    // actionable.
    const repo = scratchRepoWithCommits([
      {
        paths: { "src/runtime/vault.ts": 'export function tighten(root: string, apply: boolean) {\n  return apply ? "CHANGED" : "dry run";\n}\n' },
        subject: "vault tighten --apply is parsed now",
      },
    ]);
    withScratch(repo, () => {
      const v = measureRange(repo, "HEAD^..HEAD");
      assert.equal(v.verdict, "unaccompanied", "a behaviour change with no test change is the defect this gate exists for");
      assert.equal(v.commitsMeasured, 1, "the range really did contain the one commit");
      assert.deepEqual(v.behaviourFiles, ["src/runtime/vault.ts"], "the changed file must be named");
      assert.deepEqual(v.verificationFiles, [], "no verification file moved");
      assert.throws(() => assertShippedWithTests(v), /UNVERIFIED SHIP[\s\S]*src\/runtime\/vault\.ts/, "the refusal must name the file");
      assert.throws(() => assertShippedWithTests(v), /vault tighten --apply is parsed now/, "the refusal must name the commit subject, so the author can find it");
    });
  });

  t("GREEN: the same change shipped WITH a test passes, and the pass is a real measurement", () => {
    const repo = scratchRepoWithCommits([
      {
        paths: {
          "src/runtime/vault.ts": 'export function tighten(root: string, apply: boolean) {\n  return apply ? "CHANGED" : "dry run";\n}\n',
          "test/a.test.ts": 'import { test } from "node:test";\ntest("apply is reported as CHANGED", () => {});\n',
        },
        subject: "vault tighten --apply is parsed now, with its test",
      },
    ]);
    withScratch(repo, () => {
      const v = measureRange(repo, "HEAD^..HEAD");
      assert.equal(v.verdict, "accompanied", "behaviour plus a test is the legal shape");
      assert.deepEqual(v.verificationFiles, ["test/a.test.ts"], "the verification move must be measured, not assumed");
      assert.doesNotThrow(() => assertShippedWithTests(v), "a change that shipped with its test must not be refused");
    });
  });

t("RANGE PERTURBATION: the verdict tracks the COMMITS IN the range, measured on real repositories", (tt) => {
    // The honest mutation for a git-reading gate. Mutating the detector's own
    // regex proves nothing: a detector can be broken and still pass its own
    // unit test. What has to move is the INPUT — here, the commit set inside a
    // real range.
    //
    // Three ranges over two real repositories, and the property that matters:
    // a test landing in a LATER commit does NOT retroactively rescue an earlier
    // behaviour change. The verdict is per-commit, so the commit that shipped
    // unaccompanied is judged on its own terms. That is the intended direction
    // (at the moment it landed, nothing had verified it) and it is the property
    // a range-level "some commit in here touched a test" rule would silently
    // lose — so it is pinned, not left to chance.
    const mk = (split: boolean) =>
      scratchRepoWithCommits(
        split
          ? [
              { paths: { "src/runtime/vault.ts": 'export const tighten = (a: boolean) => (a ? "CHANGED" : "dry run");\n' }, subject: "the behaviour change" },
              { paths: { "test/a.test.ts": 'import { test } from "node:test";\ntest("tighten", () => {});\n' }, subject: "the gate, written in a LATER commit" },
            ]
          : [
              {
                paths: {
                  "src/runtime/vault.ts": 'export const tighten = (a: boolean) => (a ? "CHANGED" : "dry run");\n',
                  "test/a.test.ts": 'import { test } from "node:test";\ntest("tighten", () => {});\n',
                },
                subject: "the behaviour change, with its gate in the SAME commit",
              },
            ],
      );

    const together = mk(false);
    const split = mk(true);
    try {
      // `--all` enumerates every reachable commit, so these ranges are not
      // HEAD~n guesses and cannot drift by an off-by-one when a fixture grows.
      const togetherRange = measureRange(together, "--all", classifySurfaces(together));
      const splitRange = measureRange(split, "--all", classifySurfaces(split));
      // Same detector, same code, SAME behaviour change, ONE COMMIT different.
      assert.equal(togetherRange.verdict, "accompanied", "behaviour + gate in one commit is GREEN");
      assert.doesNotThrow(() => assertShippedWithTests(togetherRange), "and must not be refused");
      assert.equal(splitRange.verdict, "unaccompanied", "the same change with its gate in a LATER commit is still RED — a test that arrives later never verified the moment it shipped");
      assert.equal(splitRange.commitsMeasured, 3, "the split range must really hold 3 commits (layout + behaviour + later gate)");
      assert.equal(splitRange.unaccompanied.length, 1, "exactly the behaviour commit must be named");
      assert.equal(splitRange.unaccompanied[0]?.behaviourFiles.join(" "), "src/runtime/vault.ts", "and the offending file must be named on it");
      assert.throws(() => assertShippedWithTests(splitRange), /UNVERIFIED SHIP[\s\S]*src\/runtime\/vault\.ts/, "the split shape must be refused, naming the file");
      tt.diagnostic(`range perturbation: together(${togetherRange.commitsMeasured})=${togetherRange.verdict}  split(${splitRange.commitsMeasured})=${splitRange.verdict}`);
    } finally {
      rmSync(together, { recursive: true, force: true });
      rmSync(split, { recursive: true, force: true });
    }
  });

  t("a comment-only and a formatting-only src change with no test are NOT a violation", () => {
    // The false-positive control, executed rather than argued. This is the
    // class that decides whether the gate survives: a gate that fires on a
    // comment is a gate whose readers learn to skip it.
    const repo = scratchRepoWithCommits([
      { paths: { "src/runtime/vault.ts": "export const N = 1;\n" }, subject: "the file exists" },
      {
        paths: { "src/runtime/vault.ts": "export const N = 1;\n\n// MEASURED: this note is prose, not executable code.\n" },
        subject: "a comment explaining the line above",
      },
      { paths: { "src/runtime/vault.ts": "export    const    N    =    1;\n" }, subject: "a reformat" },
    ]);
    withScratch(repo, () => {
      const v = measureRange(repo, "HEAD~2..HEAD", classifySurfaces(repo));
      assert.equal(v.verdict, "no-behaviour-change", "comment and formatting changes are not behaviour changes");
      assert.doesNotThrow(() => assertShippedWithTests(v), "the legal comment/reformat shape must not be refused");
      // And the FIRST of the three IS a behaviour change, so the classifier is
      // not simply reporting nothing on this repo. It sits at HEAD~2 (the last
      // three are: exists, comment, reformat), so the single-commit range that
      // contains only it is HEAD~3..HEAD~2.
      const real = measureRange(repo, "HEAD~3..HEAD~2", classifySurfaces(repo));
      assert.equal(real.commitsMeasured, 1, "the single-commit range must really hold exactly the 'file exists' commit");
      assert.equal(real.verdict, "unaccompanied", "the commit that really added a statement must still be caught");
    });
  });

  t("a comment-only edit to a TEST does not buy a green gate", () => {
    // The cheap defeat. If any change under test/ counted, "add a comment to an
    // existing test" would silence the gate, and a gate that can be silenced by
    // editing prose is not a gate. The test-side edit must carry code.
    const repo = scratchRepoWithCommits([
      {
        paths: {
          "src/runtime/vault.ts": 'export const tighten = (a: boolean) => (a ? "CHANGED" : "dry run");\n',
          "test/a.test.ts": 'import { test } from "node:test";\ntest("tighten", () => {});\n',
        },
        subject: "behaviour + test",
      },
      {
        paths: { "src/runtime/vault.ts": 'export const tighten = (a: boolean) => (a ? "APPLIED" : "dry run");\n' },
        subject: "the behaviour changes again",
      },
      { paths: { "test/a.test.ts": 'import { test } from "node:test";\n// a note about the test below\ntest("tighten", () => {});\n' }, subject: "a comment added to the test" },
    ]);
    withScratch(repo, () => {
      // The last commit alone changed a test, so it has no behaviour of its own.
      const last = measureRange(repo, "HEAD~1..HEAD", classifySurfaces(repo));
      assert.equal(last.verdict, "no-behaviour-change", "a test-only commit moves no behaviour");
      // The third commit is the violation: behaviour with no test move. It sits at
      // HEAD~1 (layout, behaviour+test, behaviour-again, test-comment), so the
      // range holding only it is HEAD~2..HEAD~1.
      const mid = measureRange(repo, "HEAD~2..HEAD~1", classifySurfaces(repo));
      assert.equal(mid.commitsMeasured, 1, "the range must really hold only the second behaviour commit");
      assert.equal(mid.verdict, "unaccompanied", "the behaviour commit must be flagged on its own, before the comment lands");
      assert.throws(() => assertShippedWithTests(mid), /UNVERIFIED SHIP/, "and it must be refused");
    });
  });

  t("an EMPTY range is refused as vacuous, not passed", () => {
    // A gate that measures zero commits and reports "clean" is the exact shape
    // that produced test/clone-depth.test.ts's CI incident: right about what it
    // could see, silent about what it could not, and trusted anyway.
    const v = measureRange(ROOT, "HEAD..HEAD");
    assert.equal(v.verdict, "empty-range", "a range containing no commits must classify as empty");
    assert.throws(() => assertShippedWithTests(v), /measured nothing, which is not a pass/, "zero commits must never read as a pass");
  });

  t("an UNRESOLVABLE range is refused, never treated as clean", () => {
    assert.throws(
      () => measureRange(ROOT, "no-such-ref..no-such-ref"),
      /could not be resolved[\s\S]*an unseeable range is NOT a pass/,
      "a range that cannot be resolved must fail loudly — a truncated checkout must not report that nothing was unverified",
    );
  });

  t("LIVE: the range that just landed is measurable, and is reported with its numbers", (tt) => {
    const range = defaultVerifyRange();
    const v = measureRange(ROOT, range);
    assert.notEqual(v.verdict, "empty-range", `the default range "${range}" resolved to 0 commits in this checkout — the gate would be measuring nothing`);
    assert.ok(v.commitsMeasured >= 1, "the landing range must contain at least the commit that just landed");
    tt.diagnostic(
      `landing range ${v.range}: ${v.commitsMeasured} commit(s), ${v.behaviourFiles.length} behaviour file(s), ` +
        `${v.verificationFiles.length} verification file(s), ${v.accompanied.length} accompanied, ${v.unaccompanied.length} unaccompanied -> ${v.verdict}`,
    );
  });

  t("LIVE: what just landed shipped its behaviour WITH a test (enforced)", () => {
    // The enforcing half on the real repository. It is a separate test from the
    // measurability one above so that "the gate could not see anything" and "the
    // gate saw a violation" are two distinguishable failures.
    assertShippedWithTests(measureRange(ROOT, defaultVerifyRange()));
  });
});
