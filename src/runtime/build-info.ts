/* GOAL 157 (1) — THE DAEMON MUST REPORT WHICH BUILD IT **IS**.
 *
 * THE DEFECT THIS FILE EXISTS FOR. Every gate in this repo measures the REPO.
 * Nothing measured the RUNNING SERVICE. On 2026-09-29 that difference cost
 * 4h35m: the repo was green at commit 4ef0dfd (GOAL 156, which added
 * `perSiteMax` to the pool), the deployed daemon at `/opt/ui2api` had started
 * at 14:51, and MEASURED on the deployed tree:
 *
 *   $ grep -c perSiteMax /opt/ui2api/dist/prompt/pool.js   ->  0
 *
 * …while `src/prompt/pool.ts` contained it. The deployed binary PREDATED the
 * fix, and nothing in its own output said so — the deployed binary does not
 * record its own commit anywhere, so neither an operator nor a consumer
 * calling `GET /status` could tell which build was answering. That is the
 * project's core failure mode wearing a new hat: a plausible-looking service
 * answering with a build nobody can name.
 *
 * THE RULE, WHICH IS WHY THIS FILE IS CAREFUL: **a wrong build stamp is WORSE
 * than an absent one.** The whole point of ui2api is that the answer is read
 * off a real page, never a plausible fabrication; a build identity that
 * "looked right" would be the same lie in a different field. So there is
 * exactly ONE honest value, and everything else is an explicit `unknown` with
 * a NAMED reason — never a guess, never a default, never a zero.
 *
 * THE FALLBACK CHAIN (first hit wins, each step a FACT, never an inference):
 *
 *   1. `build-stamp` — `build-info.json` emitted next to the compiled module
 *      by `npm run build`. This is the ONLY source that survives outside a git
 *      checkout, and the deployed case is exactly the one that needs it: the
 *      deployed tree at `/opt/ui2api` has NO `.git` (MEASURED), so a
 *      git-derived value there can only ever be `unknown`. The stamp is
 *      written into `dist/`, which `.gitignore` already excludes, so the
 *      generated artefact can never be committed and never drift from a
 *      hand-edited value in the tree.
 *   2. `git-worktree` — the module resolves its own repository (`git rev-parse
 *      --show-toplevel` walked UP from this file's own directory) and reads the
 *      real HEAD, plus `git status --porcelain` so an UNCOMMITTED tree is
 *      reported as `dirty: true` rather than passing as a clean commit. This
 *      is the dev path (`npx tsx src/cli.ts`): honest, and explicitly labelled
 *      `git-worktree` so a reader knows it describes the checkout, not a
 *      deployed artefact.
 *   3. `unknown` — neither. `commit: null`, `dirty: null`, and a NAMED reason
 *      naming what was tried. `/status` and `/health` still answer, and the
 *      identity block is still present: "I cannot tell you what I am" is
 *      information, and a MISSING block would hide the question.
 *
 * Every probe is bounded and best-effort: a missing git binary, a permissions
 * error, or a slow repository yields a reason string, never a throw and never a
 * hang. `buildIdentity()` is called on `/status` and `/health` — both are
 * diagnostic surfaces that must answer even when the machine is unhealthy.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the build writes the stamp. `dist/` is already gitignored. */
export const BUILD_STAMP_FILENAME = "build-info.json";

/** The shape `npm run build` writes. Every field is optional on read. */
export type BuildStamp = {
  /** Full 40-hex commit the build was made from. */
  commit?: unknown;
  /** ISO timestamp the build ran. */
  builtAt?: unknown;
  /** True when the build was made from a tree with uncommitted changes. */
  dirty?: unknown;
};

export type BuildIdentitySource = "build-stamp" | "git-worktree" | "unknown";

export type BuildIdentity = {
  /** Full commit sha, or `null` when it cannot be determined. NEVER a guess. */
  commit: string | null;
  /** First 7 of `commit`, or `null`. Convenience only; `commit` is the truth. */
  shortCommit: string | null;
  /**
   * Which of the three chain steps answered. `unknown` is a first-class
   * answer here, not an error — a consumer can branch on it and a human can
   * see at a glance that the identity is unestablished.
   */
  source: BuildIdentitySource;
  /** ISO build timestamp, or `null` when there is no stamp to read it from. */
  builtAt: string | null;
  /**
   * True/False when a tree was actually inspected, `null` when nothing was
   * inspected (a stamp with no dirty flag is not "clean", it is unmeasured).
   */
  dirty: boolean | null;
  /**
   * NAMED reason, present whenever `source` is `unknown` (and as a note on the
   * `git-worktree` source). This repo's convention: a refusal always carries
   * the reason, never a silent empty.
   */
  reason: string | null;
};

/** Injection seam: a gate drives this with fixtures, never a real subprocess. */
export type BuildIdentityDeps = {
  /** Directory the probes resolve from — defaults to THIS module's directory. */
  fromDir?: string;
  /** Reads the build stamp; defaults to a real `readFileSync`. */
  readStamp?: (path: string) => string | null;
  /** Existence check for the stamp. */
  stampExists?: (path: string) => boolean;
  /** Runs a git command, returning trimmed stdout or throwing. */
  git?: (args: string[], cwd: string) => string;
};

/**
 * A 40-hex sha, or null. Anything else in the field is a FABRICATION risk —
 * and so is git's 40-zero "null oid", which is a sentinel for "no object" and
 * must never be reported as the commit. A stamp carrying it (or a hand-rolled
 * one) falls through the chain instead of naming a build.
 */
function asCommit(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(t)) return null;
  if (/^0+$/.test(t)) return null;
  return t;
}

function asIso(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function realGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // Bounded on purpose (doctrine: a hang is a NAMED failure, never a stall).
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function defaultReadStamp(path: string): string | null {
  try {
    if (!statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Walk UP from `fromDir` looking for a directory that actually contains
 * `.git` (a file for worktrees/submodules, a dir for a normal clone). This is
 * why the deployed tree resolves to `unknown` rather than to some ambient
 * repository: it walks from the MODULE's own location, so it can never
 * accidentally borrow the identity of whatever repository happens to be the
 * process's working directory.
 */
function findRepoRoot(fromDir: string): string | null {
  let dir = resolve(fromDir);
  for (let i = 0; i < 64; i++) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Derive this process's build identity. Never throws. */
export function buildIdentity(deps: BuildIdentityDeps = {}): BuildIdentity {
  const fromDir = deps.fromDir ?? dirname(fileURLToPath(import.meta.url));
  const stampPath = resolve(fromDir, BUILD_STAMP_FILENAME);
  const readStamp = deps.readStamp ?? defaultReadStamp;
  const stampExists = deps.stampExists ?? ((p: string) => existsSync(p));

  // ---- 1. the build stamp -------------------------------------------------
  const stamp: BuildStamp = (() => {
    if (!stampExists(stampPath)) return {};
    const raw = readStamp(stampPath);
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as BuildStamp) : {};
    } catch {
      return {};
    }
  })();

  const stampedCommit = asCommit(stamp.commit);
  if (stampedCommit) {
    return {
      commit: stampedCommit,
      shortCommit: stampedCommit.slice(0, 7),
      source: "build-stamp",
      builtAt: asIso(stamp.builtAt),
      dirty: typeof stamp.dirty === "boolean" ? stamp.dirty : null,
      reason: "read from the build stamp written by `npm run build`",
    };
  }

  // ---- 2. the git worktree (dev) -----------------------------------------
  const git = deps.git ?? realGit;
  const root = findRepoRoot(fromDir);
  if (root) {
    try {
      const head = asCommit(git(["rev-parse", "HEAD"], root));
      if (head) {
        let dirty: boolean | null = null;
        try {
          dirty = git(["status", "--porcelain"], root).length > 0;
        } catch {
          dirty = null; // unmeasured is null, NEVER "clean"
        }
        return {
          commit: head,
          shortCommit: head.slice(0, 7),
          source: "git-worktree",
          builtAt: null,
          dirty,
          reason:
            "read from the git worktree this module runs out of (a checkout, not a deployed artefact); `dirty:true` means the tree had uncommitted changes",
        };
      }
    } catch (e) {
      return unknownIdentity(`git-available-but-unreadable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 3. honest unknown -------------------------------------------------
  return unknownIdentity(
    root
      ? "no-build-stamp-and-git-worktree-has-no-commit"
      : "no-build-stamp-and-not-a-git-worktree (no .git found walking up from the running module)",
  );
}

function unknownIdentity(reason: string): BuildIdentity {
  return { commit: null, shortCommit: null, source: "unknown", builtAt: null, dirty: null, reason };
}
