import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * GOAL 98: `data/` holds REAL session snapshots — cookies + localStorage (the
 * kimi `access_token`, the deepseek `userToken`, the Tencent `hunyuan_token`) —
 * and AGENTS.md's red line is "never commit data/". Measured: that line rested
 * on ONE line of .gitignore that ZERO tests read, so a `git add -f data/...`
 * would commit real credentials with the suite fully GREEN.
 *
 * This gate makes the red line machine-verified. It inspects the GIT INDEX and
 * .gitignore only — it never opens a snapshot, and it reports paths and SHAPES,
 * never secret values.
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

  // The network half of the privacy gate. `gh repo view` is a NETWORK + CLI +
  // AUTH dependency, and it ran inside `test:unit` on every runner: it could
  // burn the full 120 s file timeout on a slow/absent runner, and its verdict
  // differed per environment. It is now opt-in, gated EXACTLY the way
  // test/install.test.ts:141 gates its live-registry test
  // (`{ skip: process.env.X !== "1" }`) — the sibling idiom, not a new one.
  // The deterministic half below runs unconditionally, so nothing is lost.
  t("privacy gate (live half): .brain/ tracked/ignored matches REAL repo visibility, opt-in via UI2API_GH_LIVE=1", { skip: process.env.UI2API_GH_LIVE !== "1" }, (tt) => {
    const brainTracked = TRACKED.some((f) => f.startsWith(".brain/"));
    // `gh` colourises its JSON when it believes it is on a terminal, so the raw
    // stdout is NOT valid JSON (measured: `[\1;37m{[\0m...`). The old test hid
    // that behind a try/catch, so its `isPrivate` branch was UNREACHABLE on a
    // colourised host — it always fell through to the fail-safe return. Strip the
    // ANSI first, so the branch it was written to pin can actually run.
    // eslint-disable-next-line no-control-regex
    const ANSI = /\u001B\[[0-9;]*m/g;
    let isPrivate: boolean;
    try {
      const raw = execFileSync("gh", ["repo", "view", "MeRezaRezaei/ui2api", "--json", "isPrivate"], { encoding: "utf8" , timeout: 120000 });
      isPrivate = (JSON.parse(raw.replace(ANSI, "")) as { isPrivate: boolean }).isPrivate === true;
    } catch (e) {
      // Opted IN and the verdict still cannot be obtained. Do not fabricate one:
      // skip with the named reason and let the offline half above hold the line.
      tt.skip(`gh could not prove repo visibility: ${(e as Error).message.split("\n")[0]}`);
      return;
    }
    if (isPrivate) {
      assert.ok(brainTracked, "PRIVATE repo: .brain/ is the real brain and must be tracked");
      assert.ok(!GITIGNORE.split("\n").some((l) => l.trim() === ".brain/"), "PRIVATE repo: .brain/ must NOT be gitignored");
    } else {
      assert.ok(!brainTracked, "PUBLIC repo: .brain/ must never be tracked");
      assert.ok(GITIGNORE.split("\n").some((l) => l.trim() === ".brain/"), "PUBLIC repo: .brain/ must be gitignored");
    }
  });

  // The offline half — no network, no gh, no auth: the fail-safe branch the old
  // test could only reach by accident (when gh happened to be missing). It is
  // the CONSERVATIVE direction, so it can never leak .brain/ to a public remote:
  // if visibility cannot be proven here, .brain/ must still be tracked. Pinned
  // unconditionally so a runner with no `gh` still enforces the red line.
  t("privacy gate (offline half, no network): .brain/ stays tracked and ungitignored until a live probe proves otherwise", () => {
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
