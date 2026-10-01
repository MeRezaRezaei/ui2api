import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The THIRD seam that turns a package identifier into a filesystem path, and the
// only one of the three that had no gate. `store.ts` got `assertSafePackageSegment`
// in GOAL 121 and `install.ts` in GOAL 113; the mirror joined the pair afterwards and
// was left bare. PROVEN here before the fix (a real local bare repo, real push):
// `name: "../../ESCAPED"` wrote `ESCAPED/1.0.0.json` OUTSIDE the mirror work tree —
// and the only thing that reported it was `git commit` failing with
// "nothing to commit, working tree clean", which names the symptom, not the cause.
// The escaped write is the defect; a confusing git error is not a gate.
// Imported from the canonical leaf, not from `store.ts`: the rule is POLICY
// (safe-segment.ts:28-36) and the module is a strict leaf whose only import is
// `node:path`, so this edge cannot close a cycle. See the module doc for why it
// lives in its own file.
import { assertSafePackageSegment } from "../registry/safe-segment.js";

export interface MirrorPackage {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  module: string;
}

/**
 * The `latest` sentinel the Hub's uplink asks for by name.
 *
 * `src/hub/api.ts:84` fetches `${registryUrl}/${name}/${version ?? "latest"}.json`,
 * so a versionless `GET /api/packages/<name>` can only be answered from the mirror
 * if a file called `latest.json` exists there. Nothing ever wrote one — the mirror
 * only ever wrote `<name>/<version>.json` — so the request 404'd, and because
 * `uplink` swallows a non-OK fetch into `return null` (api.ts:102) the hub's
 * refusal collapsed two DIFFERENT causes into one identical
 * `404 {"error":"not found"}`: "in the mirror, but the sentinel is missing" and
 * "in neither the store nor the mirror". This is the half the mirror owns; the
 * api.ts half is unchanged and stays correct either way.
 *
 * THE WRITER, not the sentinel's removal — argued, because it is a judgement call:
 *
 *  - The uplink tier is the mirror's entire stated purpose (mirror.ts:14-16: the
 *    mirror exists "so the Hub's read-only uplink can fetch it"). Its primary
 *    shape is the versionless request, because that is the only one a client that
 *    has not yet learned a version can make. Deleting the sentinel would not
 *    simplify that path, it would kill it: the router would have to list the
 *    mirror's versions over the network and pick a maximum itself, per request,
 *    in code I do not own.
 *  - Dropping it also cannot be done from here. `uplink` reads
 *    `data.manifest.version` and `data.module` (api.ts:105-106) and type-checks
 *    on `data` being non-null, so a POINTER file (`{"version":"1.1.0"}`) would
 *    throw a TypeError, be swallowed by `catch { return null }`, and reproduce the
 *    very 404 being fixed. The artifact has to be a full payload copy.
 *  - A copy is only safe if it cannot drift, so it is recomputed from the files
 *    actually on disk on EVERY push and read back off disk byte-for-byte. It is
 *    never composed from the caller's in-memory claim.
 */
export const MIRROR_LATEST_FILE = "latest.json";

/** `1.2.3` / `v1.2.3-beta` -> [1,2,3]; anything else -> null (not a semver). */
function versionRank(v: string): [number, number, number] | null {
  const m = /^\d+\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[0].split(".")[0]), Number(m[1]), Number(m[2])];
}

/**
 * The newest PUBLISHED version, derived from the file names actually present —
 * never from a caller-supplied string. Any parseable semver outranks every
 * unparseable name, so a real `1.10.0` always beats a `nightly`; two unparseable
 * names fall back to a plain codepoint max purely for determinism (the mirror
 * would otherwise pick arbitrarily between two equally-unrankable names).
 */
export function pickLatestVersion(names: string[]): string | null {
  let bestSemver: { name: string; rank: [number, number, number] } | null = null;
  let bestOther: string | null = null;
  for (const name of names) {
    const rank = versionRank(name);
    if (rank) {
      if (
        !bestSemver ||
        rank[0] > bestSemver.rank[0] ||
        (rank[0] === bestSemver.rank[0] && (rank[1] > bestSemver.rank[1] || (rank[1] === bestSemver.rank[1] && rank[2] > bestSemver.rank[2])))
      ) {
        bestSemver = { name, rank };
      }
    } else if (bestOther === null || name > bestOther) {
      bestOther = name;
    }
  }
  return bestSemver ? bestSemver.name : bestOther;
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
/* The public repository is `MeRezaRezaei/ui2api`, written only by the sanitizer.
 * The name is overridable by env so a fork can guard ITS OWN public repo without
 * editing this file, and the DEFAULT is the operator's real destination — a gate
 * that defaults to permissive is not a gate. */
const PUBLIC_SANITIZED_DEST =
  process.env.UI2API_PUBLIC_DEST_REPO ?? "MeRezaRezaei/ui2api";

/** True when `repoUrl` names the public sanitized destination. Compared on the
 *  `owner/name` identity only, so ssh/https/`.git`/trailing-slash spellings all
 *  resolve to the same verdict — a gate that can be walked around by changing the
 *  URL's SHAPE is not a gate. */
export function namesPublicSanitizedDest(repoUrl: string): boolean {
  const m = /(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?\s*$/i.exec(repoUrl);
  if (!m) return false;
  return `${m[1]}/${m[2]}`.toLowerCase() === PUBLIC_SANITIZED_DEST.toLowerCase();
}

function assertNotPublicSanitizedDest(repoUrl: string): void {
  if (!namesPublicSanitizedDest(repoUrl)) return;
  throw new Error(
    `refusing to mirror packages into the PUBLIC SANITIZED repository ${PUBLIC_SANITIZED_DEST}. ` +
      "That repository is a full-history rewrite whose only writer is the sanitizer " +
      "(public_mirror), and it is published precisely because every forbidden class measured zero. " +
      "A package mirror would write into it with no sanitisation and no verification marker, which " +
      "destroys the property that makes it safe to publish. Mirror packages into the registry " +
      "(ui2api-registry) or the private full copy instead. If you really are re-pointing the " +
      "sanitizer, change scripts/ci/make-public-repo.sh and .gitlab-ci.yml, not a package push.",
  );
}

export function pushToMirror(pkg: MirrorPackage, opts: { repoUrl?: string; workDir?: string } = {}): void {
  const repoUrl = opts.repoUrl ?? process.env.UI2API_REGISTRY_REPO;
  if (!repoUrl) {
    throw new Error(
      "no mirror repository configured: pass repoUrl or set UI2API_REGISTRY_REPO to the git remote " +
        "that should receive published packages. There is no default community mirror — none is published."
    );
  }
  /* THE PUBLIC SANITIZED DESTINATION IS NOT A PACKAGE MIRROR, and this seam had
     no way to know that.
     `public_mirror`'s public half is the ONLY writer of
     `MeRezaRezaei/ui2api`, and it writes a full-history rewrite that has measured
     every forbidden class at zero. This function clones with `--depth 1` and
     commits package JSON into whatever URL it is handed — so
     `--mirror-repo https://github.com/MeRezaRezaei/ui2api.git` would be a second,
     ungated writer to a repository whose entire value is that it is a faithful
     mirror, and it would do so with no sanitisation step and no verification
     marker at all.

     Blast radius is bounded — package JSON, never the corpus — but "bounded" is
     not "safe": the failure is a public history that stops being a faithful
     mirror, which is precisely what the whole publication pipeline exists to
     prevent. The same shape as `assertSafePackageSegment`, one level up: a
     destination that is unsafe to write is refused BY NAME, before any
     filesystem or network work. */
  assertNotPublicSanitizedDest(repoUrl);
  // Refuse the identifier BEFORE any filesystem work, naming the field — same
  // gate, same order and the same refusal shape as the two sibling seams.
  const safeName = assertSafePackageSegment("name", pkg.name);
  const safeVersion = assertSafePackageSegment("version", pkg.version);
  const work = opts.workDir ?? mkdtempSync(join(tmpdir(), "u2a-mirror-"));
  try {
    if (!existsSync(join(work, ".git"))) {
      execFileSync("git", ["clone", "--depth", "1", repoUrl, work], { stdio: "inherit" });
    }
    const dir = join(work, safeName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${safeVersion}.json`),
      JSON.stringify({ manifest: pkg.manifest, module: pkg.module }, null, 2)
    );
    // Repoint the `latest` sentinel at whatever is REALLY published, derived from
    // the `<version>.json` files now on disk (the sentinel itself excluded, or it
    // would compete with the version it is a copy of). Recomputed on every push
    // rather than appended to, so it cannot accumulate drift: pushing 1.1.0 over
    // 1.0.0 repoints it, and a version removed from the mirror cannot leave it
    // naming something that is no longer there.
    const published = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== MIRROR_LATEST_FILE);
    const latest = pickLatestVersion(published);
    if (latest) {
      // Read the bytes back OFF DISK rather than re-serialising `pkg`: the
      // sentinel is then provably a copy of a real published artifact, and it can
      // never assert a version the mirror does not actually hold.
      writeFileSync(join(dir, MIRROR_LATEST_FILE), readFileSync(join(dir, latest), "utf8"));
    }
    execFileSync("git", ["add", "-A"], { cwd: work, stdio: "inherit" });
    execFileSync("git", ["commit", "-m", `add ${safeName}@${safeVersion}`], { cwd: work, stdio: "inherit" });
    execFileSync("git", ["push"], { cwd: work, stdio: "inherit" });
    console.log(`[ui2api] mirrored ${safeName}@${safeVersion} -> ${repoUrl}${latest ? ` (latest -> ${latest})` : ""}`);
  } finally {
    if (!opts.workDir) rmSync(work, { recursive: true, force: true });
  }
}
