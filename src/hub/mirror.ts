import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MirrorPackage {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  module: string;
}

/**
 * Push a published package into the community registry mirror. The mirror
 * stores each package at `<name>/<version>.json` so the Hub's read-only uplink
 * can fetch it from the raw GitHub URL.
 *
 * This only ever WRITES a vetted, already-published package; it never pulls or
 * executes anything. Requires git push access to the mirror repo.
 *
 * GOAL 120: there is NO published community registry, so this used to default to
 * `https://github.com/MeRezaRezaei/ui2api-registry` — a repo that does not
 * exist, which made every mirror attempt a silent failure against nothing. The
 * mirror target is now EXPLICIT: supply `repoUrl` or `UI2API_REGISTRY_REPO`. We
 * never invent a default destination for a write.
 */
export function pushToMirror(pkg: MirrorPackage, opts: { repoUrl?: string; workDir?: string } = {}): void {
  const repoUrl = opts.repoUrl ?? process.env.UI2API_REGISTRY_REPO;
  if (!repoUrl) {
    throw new Error(
      "no mirror repository configured: pass repoUrl or set UI2API_REGISTRY_REPO to the git remote " +
        "that should receive published packages. There is no default community mirror — none is published."
    );
  }
  const work = opts.workDir ?? mkdtempSync(join(tmpdir(), "u2a-mirror-"));
  try {
    if (!existsSync(join(work, ".git"))) {
      execFileSync("git", ["clone", "--depth", "1", repoUrl, work], { stdio: "inherit" });
    }
    const dir = join(work, pkg.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${pkg.version}.json`),
      JSON.stringify({ manifest: pkg.manifest, module: pkg.module }, null, 2)
    );
    execFileSync("git", ["add", "-A"], { cwd: work, stdio: "inherit" });
    execFileSync("git", ["commit", "-m", `add ${pkg.name}@${pkg.version}`], { cwd: work, stdio: "inherit" });
    execFileSync("git", ["push"], { cwd: work, stdio: "inherit" });
    console.log(`[ui2api] mirrored ${pkg.name}@${pkg.version} -> ${repoUrl}`);
  } finally {
    if (!opts.workDir) rmSync(work, { recursive: true, force: true });
  }
}
