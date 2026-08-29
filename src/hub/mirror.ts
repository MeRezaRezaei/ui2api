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
 * Push a published package into the community registry mirror (default
 * `ui2api-registry`). The mirror stores each package at `<name>/<version>.json`
 * so the Hub's read-only uplink can fetch it from the raw GitHub URL.
 *
 * This only ever WRITES a vetted, already-published package; it never pulls or
 * executes anything. Requires git push access to the mirror repo.
 */
export function pushToMirror(pkg: MirrorPackage, opts: { repoUrl?: string; workDir?: string } = {}): void {
  const repoUrl =
    opts.repoUrl ?? process.env.UI2API_REGISTRY_REPO ?? "https://github.com/MeRezaRezaei/ui2api-registry.git";
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
