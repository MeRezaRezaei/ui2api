import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DENY = ["captcha", "bot detection", "bypass cloudflare", "evade", "solve captcha", "anti-bot"];

// Validate a published package from its parsed manifest + module source.
// Returns null on success, or a human-readable error string on failure.
export function validateManifest(manifest, moduleText) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") return "manifest must be an object";
  if (!manifest.authorizedUse || String(manifest.authorizedUse).trim().length < 4)
    errors.push("manifest.authorizedUse must be a non-empty authorized-use statement");
  const haystack = [
    manifest.authorizedUse || "",
    manifest.name || "",
    manifest.author || "",
    manifest.license || "",
    moduleText || "",
  ].join(" ").toLowerCase();
  for (const term of DENY) if (haystack.includes(term)) errors.push(`forbidden term in submission: "${term}"`);
  return errors.length ? errors.join("; ") : null;
}

// Legacy CLI / directory form. Returns { ok, errors }.
export function validatePackage(pkgDirOrManifest, moduleText) {
  if (typeof pkgDirOrManifest === "string") {
    return validateDir(pkgDirOrManifest);
  }
  return validateManifest(pkgDirOrManifest, moduleText);
}

function validateDir(pkgDir) {
  const errors = [];
  let metadata, map;
  try {
    metadata = JSON.parse(readFileSync(resolve(pkgDir, "metadata.json"), "utf8"));
    map = JSON.parse(readFileSync(resolve(pkgDir, "action-map.json"), "utf8"));
  } catch (e) {
    return { ok: false, errors: ["cannot read package files: " + e.message] };
  }
  if (!metadata.authorizedUse || metadata.authorizedUse.trim().length < 4)
    errors.push("metadata.authorizedUse must be a non-empty authorized-use statement");
  if (!map.host || !map.url) errors.push("action-map missing host/url");
  const haystack = [
    metadata.authorizedUse || "",
    metadata.name || "",
    ...(map.actions || []).flatMap((a) => [a.description || "", a.recipe?.target || "", a.recipe?.network?.url || ""]),
  ].join(" ").toLowerCase();
  for (const term of DENY) if (haystack.includes(term)) errors.push(`forbidden term in submission: "${term}"`);
  if (!/^https?:\/\//i.test(map.url || "")) errors.push("action-map.url must be http(s)");
  return { ok: errors.length === 0, errors };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  let failed = 0;
  for (const d of dirs) {
    const r = validatePackage(d);
    if (r.ok) console.log(`OK   ${d}`);
    else { failed++; console.error(`FAIL ${d}: ${r.errors.join("; ")}`); }
  }
  process.exit(failed ? 1 : 0);
}
