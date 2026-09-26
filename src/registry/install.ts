// Community registry installer — `ui2api install <site>`
//
// Fetches a per-site capability package from a community registry and
// materializes it into the same packages root the daemon serves from
// (`capabilities/<site>/` on disk — the layout `findPackageDir()` /
// `resolvePackagedProfile()` / `buildRegistryPackages()` already read).
//
// GOAL 116 — HONEST DEFAULT: no public community registry is published yet, so
// `DEFAULT_REGISTRY_URL` below is an INTENTIONAL placeholder that always 404s;
// install REQUIRES `--registry <url>` / `UI2API_REGISTRY_URL` pointing at a
// registry the operator runs or forks. The in-repo `capabilities/<site>/`
// packages are served with no install step at all. See `fetchRegistryIndex()`
// for the named error that says exactly this instead of guessing at reachability.
//
// The registry's layout is a git repo whose default branch is `master` (NOT
// `main`). Its root carries `index.json` — the installable-site catalog with `trust`
// (reviewed/unreviewed) and `version` per site — and per-site packages live
// under `packages/<site>/` in the MODERN shape: metadata.json + manifest.json +
// profile.json + session.lock.json + CAPABILITIES.md + recipes/<cap>.json
// (there is NO action-map.json anymore). This installer consumes that exact
// shape so install can never drift back to the dead metadata+action-map pair.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { validManifestCapability } from "../prompt/registry.js";
import { validatePackagedProfileShape, type ChatSiteProfile } from "../profile/profile.js";

/** The public registry's default branch (git default, reflected in the raw URL). */
export const DEFAULT_REGISTRY_BRANCH = "master";

/** Raw base URL for the public registry — index.json + packages/<site>/ live under it. */
export const DEFAULT_REGISTRY_URL = `https://raw.githubusercontent.com/MeRezaRezaei/ui2api-registry/${DEFAULT_REGISTRY_BRANCH}`;

export interface RegistryEntry {
  name?: string;
  url?: string | null;
  site?: string | null;
  version?: string;
  trust?: "reviewed" | "unreviewed";
  publishedAt?: string;
}

/** The registry's `index.json` root catalog: `{ <siteId>: entry }`. */
export type RegistryIndex = Record<string, RegistryEntry>;

export interface InstallResult {
  dir: string;
  siteId: string;
  version: string;
  trust: string;
  files: string[];
}

// The modern package files fetched verbatim from packages/<site>/. Recipes are
// added separately from the manifest's capability `recipe` pointers. The two
// REQUIRED ones gate a package as valid; the rest are tolerated as absent.
const REQUIRED_FILES = ["metadata.json", "manifest.json"];
const OPTIONAL_FILES = ["profile.json", "session.lock.json", "CAPABILITIES.md"];

/** Resolve the packages root the daemon serves from (the install target). */
export function defaultPackagesRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Module sits at <root>/src/registry/ or <root>/dist/registry/ — two levels
  // up lands on the package root in both layouts (same climb resolvePackagedProfile
  // / findPackageDir use). Prefer the root whose `capabilities/` dir already
  // exists; otherwise fall back to <root>/capabilities (created on install).
  let p = here;
  for (let i = 0; i < 2; i++) p = dirname(p);
  const root = p;
  for (const cand of [resolve(root, "capabilities"), resolve(root, "src", "capabilities")]) {
    if (existsSync(cand)) return cand;
  }
  return resolve(root, "capabilities");
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return await res.text();
}

/** Normalize a registry base URL: accept a GitHub repo page or the raw base. */
export function normalizeRegistryBase(input: string): string {
  const trimmed = input.replace(/\/+$/, "");
  const repoPage = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (repoPage) {
    return `https://raw.githubusercontent.com/${repoPage[1]}/${repoPage[2]}/${DEFAULT_REGISTRY_BRANCH}`;
  }
  return trimmed;
}

/**
 * Fetch the registry's index.json catalog (the discovery surface): the list of
 * installable sites with name/url/version/trust. Throws when the base URL is
 * wrong — including the pinned 404 cause (a `main` branch URL that no longer
 * exists), with the corrective hint.
 */
export async function fetchRegistryIndex(registryBaseUrl: string): Promise<RegistryIndex> {
  const base = normalizeRegistryBase(registryBaseUrl);
  try {
    return JSON.parse(await fetchText(`${base}/index.json`)) as RegistryIndex;
  } catch (e) {
    const wrongBranch = base.includes(`/main/`) || base.endsWith("/main");
    // GOAL 116: the DEFAULT base is NOT a reachable registry — no public
    // community registry is published, so a bare `ui2api install <site>` /
    // `install --catalog` 404s on the code's own default. Saying "verify the
    // registry repo is reachable" sent the reader hunting for a repo that does
    // not exist. Name the REAL cause (nothing is published) and the REAL
    // remedy (supply your own registry), instead.
    const isDefault = base === normalizeRegistryBase(DEFAULT_REGISTRY_URL);
    const hint = wrongBranch
      ? ` — the registry default branch is "${DEFAULT_REGISTRY_BRANCH}" (its /main is gone); use e.g. ${DEFAULT_REGISTRY_URL}`
      : isDefault
        ? ` — no public community registry is published yet: the built-in default ${DEFAULT_REGISTRY_URL} has no repo behind it, so it 404s by design. Supply a registry: pass --registry <url> or set UI2API_REGISTRY_URL to a raw base ending in the branch (e.g. <your-fork>/${DEFAULT_REGISTRY_BRANCH}) — or skip install entirely and use the packages already vendored in this repo's capabilities/<site>/ directories`
        : ` — no registry answered at that URL; --registry <url> / UI2API_REGISTRY_URL must point at a registry that publishes index.json on the ${DEFAULT_REGISTRY_BRANCH} branch`;
    throw new Error(`registry index.json not readable at ${base}/index.json${hint} (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Install a site package from the public registry into `packagesRoot/<site>/`.
 * Consumes the MODERN package shape (metadata/manifest/profile/session.lock/
 * CAPABILITIES.md + manifest-referenced recipes) and validates the result
 * before writing. Returns where the package landed + its catalog metadata.
 */
/**
 * GOAL 113: a package's file keys come from its OWN manifest (`recipe` strings),
 * so a hostile or compromised registry can name `../../.gitignore` or an absolute
 * path. PROVEN before this fix: with the package dir at
 * `/tmp/tv/root/capabilities/evil`, the key `../../../PWNED.txt` wrote
 * `/tmp/tv/PWNED.txt` and the key `/tmp/tv/ABS.txt` wrote that absolute path —
 * both outside the package dir, because `resolve()` collapses `..`, an absolute
 * key wins outright, and the recursive `mkdirSync` creates any parent.
 *
 * An install may only ever write INSIDE its own package directory. This is
 * containment by `resolve()` + a separator-terminated prefix test, not a naive
 * string match, so a legitimate `recipes/<cap>.json` still installs while
 * `..`, an absolute path, a backslash or a NUL is refused LOUDLY.
 */
export function assertPackageRelPath(file: string, dir: string): string {
  const why =
    file.length === 0
      ? "empty path"
      : file.includes("\u0000")
        ? "contains a NUL byte"
        : file.includes("\\")
          ? "contains a backslash"
          : file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)
            ? "is an absolute path"
            : file.split(/[\\/]+/).includes("..")
              ? "contains a '..' segment"
              : null;
  if (why) {
    // Name BOTH the offending key and where it WOULD have landed: a refusal a
    // reader cannot audit is half a fix.
    throw new Error(
      `refusing package file path ${JSON.stringify(file)} (${why}) — it would resolve to ` +
        `${resolve(dir, file)}, outside the package directory ${resolve(dir)}`
    );
  }
  const out = resolve(dir, file);
  const root = resolve(dir) + sep;
  if (out !== resolve(dir) && !out.startsWith(root)) {
    throw new Error(
      `refusing package file path ${JSON.stringify(file)} — it resolves to ${out}, outside the package directory ${resolve(dir)}`
    );
  }
  return out;
}

export async function installPackage(
  host: string,
  registryBaseUrl: string,
  packagesRoot: string
): Promise<InstallResult> {
  const base = normalizeRegistryBase(registryBaseUrl);
  const index = await fetchRegistryIndex(base);
  const entry = index[host];
  if (!entry) {
    const available = Object.keys(index)
      .sort()
      .map((s) => `${s}@${index[s].version ?? "?"} (${index[s].trust ?? "?"})`)
      .join(", ");
    throw new Error(`no package "${host}" in the registry catalog; installable: ${available || "(empty registry)"}`);
  }

  const pkgBase = `${base}/packages/${encodeURIComponent(host)}`;
  const toFetch = [...REQUIRED_FILES, ...OPTIONAL_FILES];
  const textByFile: Record<string, string> = {};
  for (const file of toFetch) {
    const res = await fetch(`${pkgBase}/${file}`);
    if (res.ok) {
      textByFile[file] = await res.text();
    } else if (REQUIRED_FILES.includes(file)) {
      throw new Error(
        `package "${host}" is missing required ${file} (HTTP ${res.status}) — not a valid ui2api package`
      );
    }
    // OPTIONAL_FILES (session.lock.json / CAPABILITIES.md / profile.json) may
    // legitimately be absent on some packages (anonymous or dead-end) — tolerated.
  }

  const manifest = JSON.parse(textByFile["manifest.json"]) as {
    id?: unknown;
    capabilities?: Array<{ recipe?: unknown }>;
  };
  if (manifest.id !== host) {
    throw new Error(
      `package "${host}" manifest carries id "${String(manifest.id)}" — refusing to install a mismatched package`
    );
  }
  // Recipes referenced by the manifest (`recipes/<cap>.json`) — the modern
  // layout's execution detail, replacing the dead action-map.json.
  const recipePaths = Array.from(
    new Set(
      (Array.isArray(manifest.capabilities) ? manifest.capabilities : [])
        .map((c) => c?.recipe)
        .filter((r): r is string => typeof r === "string")
    )
  );
  for (const recipe of recipePaths) {
    // GOAL 113: validate the manifest-declared path BEFORE any network request,
    // so a traversal ref is refused without a fetch ever being attempted.
    assertPackageRelPath(recipe, resolve(packagesRoot, host));
    const res = await fetch(`${pkgBase}/${recipe}`);
    if (res.ok) {
      textByFile[recipe] = await res.text();
    } else {
      throw new Error(`package "${host}" manifest references ${recipe} but it is missing (HTTP ${res.status})`);
    }
  }

  // GOAL 65: install-seam WRITE truth gate — validate the WHOLE fetched
  // package BEFORE anything lands on disk. The write side must refuse the
  // same malformed classes the read/serve seams refuse (GOAL 61 capability
  // entries, GOAL 48/56 profile shape, GOAL 64 profile id agreement), with
  // a named verdict and NOTHING written — the GOAL 49/50 session-write
  // principle ("refused at the write seam") applied to package installs.
  // A package that would only be refused later by /registry (caps silently
  // dropped) or by /capability + CLI (LOUD at serve time) must never
  // install "successfully" in the first place.
  for (const file of Object.keys(textByFile)) {
    if (!/\.(json|lock)$/.test(file)) continue;
    try {
      JSON.parse(textByFile[file]);
    } catch (e) {
      throw new Error(
        `package "${host}" ${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — refusing to install a corrupt package`
      );
    }
  }
  const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  for (let i = 0; i < caps.length; i++) {
    if (!validManifestCapability(caps[i])) {
      throw new Error(
        `package "${host}" manifest capabilities[${i}] is not a valid capability entry (needs an object with a string "id") — refusing to install a malformed package (it would be silently dropped from /registry)`
      );
    }
  }
  if (textByFile["profile.json"]) {
    const profilePath = `${host}/profile.json`;
    const profile = JSON.parse(textByFile["profile.json"]) as ChatSiteProfile;
    // GOAL 48/56 shape gate at the write seam — a profile the runtime would
    // refuse LOUD at serve time is refused here instead.
    validatePackagedProfileShape(profilePath, profile);
    // GOAL 64 id agreement — the package dir is truth: a mismatched "id"
    // would make /capability + CLI fail LOUD and /registry exclude the
    // package at load; never install "successfully" as the wrong identity.
    if (typeof profile.id === "string" && profile.id !== host) {
      throw new Error(
        `profile file ${profilePath} declares "id" "${profile.id}" but is installed as package "${host}" — refusing to silently install the wrong site (fix the file's "id" or publish it under capabilities/${profile.id}/)`
      );
    }
  }

  const dir = resolve(packagesRoot, host);
  // GOAL 113: validate EVERY key before writing ANY file, so a single bad path
  // cannot leave a half-written package behind.
  const targets = Object.keys(textByFile).map((file) => [file, assertPackageRelPath(file, dir)] as const);
  for (const [, out] of targets) mkdirSync(dirname(out), { recursive: true });
  for (const [i, [, out]] of targets.entries()) writeFileSync(out, textByFile[Object.keys(textByFile)[i]!]!);

  return {
    dir,
    siteId: host,
    version: entry.version ?? "unknown",
    trust: entry.trust ?? "unreviewed",
    files: Object.keys(textByFile),
  };
}