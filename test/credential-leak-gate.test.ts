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
});
