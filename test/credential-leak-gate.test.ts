import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

const git = (...args: string[]): string => execFileSync("git", args, { encoding: "utf8" , timeout: 120000 }).trim();
const GITIGNORE = readFileSync(".gitignore", "utf8");
const TRACKED: string[] = git("ls-files").split("\n").filter(Boolean);

/** The REAL ignore seam: ask git, never guess from the text. `.env` is covered
 *  by a pattern, not a literal line, so substring matching was a wrong check. */
export const isIgnored = (p: string): boolean => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { stdio: "ignore" , timeout: 120000 });
    return true;
  } catch {
    return false;
  }
};

/** Secret-bearing paths AGENTS.md declares must never be committed. */
export const FORBIDDEN_TRACKED_PREFIXES = ["data/", ".agents/", ".opencode/", "sites/*/server/"];

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
    const leaked = TRACKED.filter((f) => f.startsWith("data/") || f.startsWith(".agents/") || f.startsWith(".opencode/") || /^sites\/[^/]+\/server\//.test(f));
    assert.deepEqual(leaked, [], `these secret-bearing files are TRACKED and would ship real credentials: ${leaked.join(" ")}`);
  });

  t("no tracked file has a session-snapshot/credential shape", () => {
    const shaped = credentialShaped(TRACKED);
    // .brain/verbatim/state.json is brain STATE, not a session snapshot — it is
    // legitimately tracked in a private repo, so it is explicitly allowed.
    const real = shaped.filter((f) => f !== ".brain/verbatim/state.json");
    assert.deepEqual(real, [], `these tracked files look like session snapshots/credentials: ${real.join(" ")}`);
  });

  t("privacy gate: .brain/ is tracked iff the repo is PRIVATE", () => {
    const brainTracked = TRACKED.some((f) => f.startsWith(".brain/"));
    let isPrivate = true;
    try {
      isPrivate = JSON.parse(execFileSync("gh", ["repo", "view", "MeRezaRezaei/ui2api", "--json", "isPrivate"], { encoding: "utf8" , timeout: 120000 })).isPrivate === true;
    } catch {
      // gh unavailable/offline: do not fabricate a verdict — assert the safe branch only
      assert.ok(brainTracked, "if repo visibility cannot be proven, .brain/ must still be tracked (fail safe)");
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

  t("negative: a credential-shaped path in the file list is reported (the gate CAN fail)", () => {
    const scratch = [...TRACKED, "data/sessions/kimi.ai/default/state.json"];
    const shaped = credentialShaped(scratch).filter((f) => f !== ".brain/verbatim/state.json");
    assert.ok(shaped.includes("data/sessions/kimi.ai/default/state.json"), "a tracked session snapshot must be reported");
    // and a leaked data/ path must be caught by the tracked-prefix rule too
    const leaked = scratch.filter((f) => f.startsWith("data/"));
    assert.deepEqual(leaked, ["data/sessions/kimi.ai/default/state.json"], "a tracked data/ path must be reported");
  });
});
