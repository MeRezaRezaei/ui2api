import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// UI2API Community Registry — v2 package validation.
//
// A v2 package is a folder packages/<site-id>/ containing:
//   metadata.json     registry-level: siteId, site, name, url, siteVersion,
//                     version, author, authorizedUse, license, ui2api,
//                     trust, publishedAt
//   manifest.json     capability package manifest (capabilities[], transport)
//   profile.json      (optional) selectors / login requirements
//   recipes/*.json    (optional) per-capability recipes
//   CAPABILITIES.md   (optional) human doc
//   ANALYSIS.md       (optional) raw analysis notes
//   session.lock.json (optional) session requirement description
//
// Two entry points:
//   validatePackage(dir)              -> { ok, errors } for a package dir
//   validateManifest(manifest, module)-> error string | null  (hub publish path)

// Evasion detection is PHRASE-based: honest disclosures like "this site is
// Cloudflare/hCaptcha gated and requires a headed capture" must pass; only
// statements that name a *bypass action* fail.
const DENY_PHRASES = [
  "bypass captcha", "solve captcha", "captcha solver", "captcha bypass", "anti-captcha", "anticaptcha",
  "bypass hcaptcha", "solve hcaptcha", "hcaptcha bypass",
  "bypass bot detection", "evade bot detection", "avoid bot detection", "defeat bot detection",
  "bypass cloudflare", "cloudflare bypass", "solve cf challenge",
  "evade paywall", "bypass paywall", "paywall bypass",
  "anti-bot bypass", "evade anti-bot", "bypass anti-bot",
];
const CORE_REQUIRED = ["siteId", "site", "name", "url", "version", "authorizedUse", "trust"];
const MANIFEST_REQUIRED = ["id", "name", "site", "url", "version"];

function denyTerms(...texts) {
  const haystack = " " + texts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  return DENY_PHRASES.filter((p) => haystack.includes(p));
}

const isDeadEnd = (meta) => meta?.status === "dead-end";

// ————————————————————— package dir (v2 filesystem) —————————————————————

export function validatePackage(pkgDir) {
  const errors = [];
  const present = (f) => existsSync(join(pkgDir, f));

  if (!present("metadata.json")) errors.push("missing metadata.json");
  if (!present("manifest.json")) errors.push("missing manifest.json");

  let metadata = null, manifest = null;
  try { metadata = JSON.parse(readFileSync(join(pkgDir, "metadata.json"), "utf8")); }
  catch (e) { errors.push("metadata.json unparseable: " + e.message); }
  try { manifest = JSON.parse(readFileSync(join(pkgDir, "manifest.json"), "utf8")); }
  catch (e) { errors.push("manifest.json unparseable: " + e.message); }

  const siteId = pkgDir.split(/[\\/]/).pop();
  if (metadata) {
    for (const k of CORE_REQUIRED) if (metadata[k] === undefined || metadata[k] === null || metadata[k] === "")
      if (!(["url", "site"].includes(k) && isDeadEnd(metadata))) errors.push(`metadata.${k} is required`);
    if (metadata.siteId !== siteId) errors.push(`metadata.siteId "${metadata.siteId}" must match folder name "${siteId}"`);
    if (metadata.authorizedUse && String(metadata.authorizedUse).trim().length < 4)
      errors.push("metadata.authorizedUse must be a non-empty authorized-use statement");
    if (metadata.url !== null && metadata.url !== undefined && !/^https?:\/\//i.test(String(metadata.url)))
      errors.push("metadata.url must be http(s) or null (dead-end)");
    if (!["reviewed", "unreviewed"].includes(metadata.trust)) errors.push("metadata.trust must be 'reviewed' | 'unreviewed'");
  }
  if (manifest) {
    for (const k of MANIFEST_REQUIRED) if (manifest[k] === undefined || manifest[k] === null || manifest[k] === "")
      if (!["url", "site"].includes(k) || !isDeadEnd(manifest)) errors.push(`manifest.${k} is required`);
    if (manifest.url !== null && manifest.url !== undefined && !/^https?:\/\//i.test(String(manifest.url)))
      errors.push("manifest.url must be http(s) or null (dead-end)");
    const caps = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
    if (!caps.length) errors.push("manifest.capabilities must be a non-empty array");
    for (const c of caps) {
      if (!c.id) errors.push("capability found without id");
      if (c.recipe) {
        if (!present(c.recipe)) errors.push(`capability ${c.id}: recipe file missing (${c.recipe})`);
      }
    }
    // recipe files must be under recipes/ and referenced by a capability
    if (present("recipes")) {
      for (const r of readdirSync(join(pkgDir, "recipes")).filter((f) => f.endsWith(".json"))) {
        if (!caps.some((c) => c.recipe === join("recipes", r))) errors.push(`orphan recipe file recipes/${r} (not referenced by any capability)`);
      }
    }
  }

  // authorized-use must exist in metadata (security baseline)
  const use = metadata?.authorizedUse ?? manifest?.authorizedUse ?? "";
  if (String(use).trim().length < 4) errors.push("authorized-use statement is required");
  const terms = denyTerms(
    use, metadata?.name, manifest?.name, manifest?.description,
    ...(manifest?.capabilities ?? []).flatMap((c) => [c.name, c.description, c.method])
  );
  for (const t of terms) errors.push(`forbidden term in submission: "${t}"`);

  return { ok: errors.length === 0, errors };
}

// ————————————————————— hub publish path (manifest + module) —————————————————————

export function validateManifest(manifest, moduleText) {
  if (!manifest || typeof manifest !== "object") return "manifest must be an object";
  const errors = [];
  if (!manifest.authorizedUse || String(manifest.authorizedUse).trim().length < 4)
    errors.push("manifest.authorizedUse must be a non-empty authorized-use statement");
  const haystack = " " + [manifest.authorizedUse || "", manifest.name || "", manifest.author || "", manifest.license || "", moduleText || ""].join(" ").toLowerCase().replace(/[^a-z0-9 ]/g, " ") + " ";
  const terms = DENY_PHRASES.filter((p) => haystack.includes(p));
  for (const term of terms) errors.push(`forbidden term in submission: "${term}"`);
  return errors.length ? errors.join("; ") : null;
}

// Legacy/compat: validatePackage(dir | manifest, module) dual-dispatch
export function validateManifestOrDir(pkgDirOrManifest, moduleText) {
  if (typeof pkgDirOrManifest === "string") return validatePackage(pkgDirOrManifest);
  return validateManifest(pkgDirOrManifest, moduleText);
}

// CLI entry: node scripts/validate-registry.mjs [dirs...]  (default: all of packages/)
if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname ?? (process.argv[1] ? resolve(process.argv[1], "..") : "."), "..");
  const pkgs = resolve(root, "packages");
  const explicit = process.argv.slice(2);
  const dirs = explicit.length
    ? explicit
    : existsSync(pkgs)
      ? readdirSync(pkgs).filter((d) => existsSync(join(pkgs, d, "manifest.json"))).map((d) => join(pkgs, d))
      : [];
  let failed = 0;
  if (!dirs.length) { console.error("no packages to validate"); process.exit(1); }
  for (const d of dirs) {
    const r = validatePackage(d);
    if (r.ok) console.log(`OK   ${d}`);
    else { failed++; console.error(`FAIL ${d}: ${r.errors.join("; ")}`); }
  }
  process.exit(failed ? 1 : 0);
}