// Registry surface for promptd — GET /registry
//
// This is the CONTRACT OmniRoute (and any other consumer) reads to drive a
// deployed ui2api daemon. It is built exclusively from the installed ui2api
// capability packages (the registry repo's content mirrored into
// capabilities/<id>/) — whatever is in the registry repository appears here,
// and nothing else. OmniRoute holds no site knowledge of its own: it syncs
// this endpoint into provider nodes (models) + MCP tools (capabilities).
//
//   GET /registry
//   -> { packages: [
//        { id, name, url, description, version, site, authRequired,
//          chat:   { model: <siteId>, streaming: true },
//          tools:  [ { name, description, method,
//                      inputSchema: {type:"object", properties, required} } ]
//        }, ...
//      ],
//      generatedAt }
//
// "tools" are the package's capabilities expressed as MCP-tool-shaped
// definitions. Tool naming: "<site>_<capability>" (capability ids already
// carry the site prefix, e.g. deepseek_chat); consumers prefix their own
// namespace (OmniRoute registers them as ui2api_<site>_<capability>).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackagedProfile } from "../profile/profile.js";

export interface RegistryToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
  required: string[];
}

export interface RegistryTool {
  /** Normalized "<site>_<capability>" name (consumer-facing, MCP id). */
  name: string;
  /** Raw capability id the daemon's /capability/<site> understands. */
  id: string;
  description: string;
  method: string;
  inputSchema: RegistryToolInputSchema;
}

export interface RegistryChat {
  model: string;
  streaming: boolean;
}

export interface RegistryPackage {
  id: string;
  name: string;
  url: string;
  description: string;
  version: string;
  site: string;
  authRequired: boolean;
  status: string;
  chat: RegistryChat;
  tools: RegistryTool[];
}

interface Metadata {
  status?: string;
}

interface ManifestCapability {
  id: string;
  name?: string;
  description?: string;
  method?: string;
}

interface Manifest {
  id: string;
  name?: string;
  url?: string;
  description?: string;
  version?: string;
  site?: string;
  auth?: { required?: boolean };
  capabilities?: ManifestCapability[];
}

/** Locate the capabilities/ package dir for a site (same source resolvePackagedProfile uses). */
export function findPackageDir(siteId: string): string | null {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of [2, 3]) {
    let p = here;
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities", siteId), resolve(p, "src", "capabilities", siteId)]) {
      if (existsSync(resolve(root, "manifest.json"))) return root;
    }
  }
  return null;
}

/** List installed package site ids (capabilities/<id>/manifest.json on disk). */
export function listInstalledPackageIds(): string[] {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const up of [2, 3]) {
    let p = here;
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities"), resolve(p, "src", "capabilities")]) {
      if (!existsSync(root)) continue;
      try {
        const ids = readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(resolve(root, d.name, "manifest.json")))
          .map((d) => d.name);
        if (ids.length > 0) return ids;
      } catch {
        // fall through to next candidate root
      }
    }
  }
  return [];
}

/** Strip a leading "<site>_" (or "<site-with-underscores>_") prefix from a capability id. */
export function bareCapabilityId(siteId: string, capabilityId: string): string {
  const hyphenPrefixed = `${siteId}_`;
  if (capabilityId.startsWith(hyphenPrefixed)) return capabilityId.slice(hyphenPrefixed.length);
  const underscorePrefixed = `${siteId.replace(/-/g, "_")}_`;
  if (capabilityId.startsWith(underscorePrefixed)) return capabilityId.slice(underscorePrefixed.length);
  return capabilityId;
}

/** Derive an MCP-tool-shaped input schema for a capability from its manifest entry. */
export function capabilityInputSchema(
  siteId: string,
  capabilityId: string,
  _method: string | undefined,
  description: string | undefined
): RegistryToolInputSchema {
  const bare = bareCapabilityId(siteId, capabilityId);
  // Chat capabilities carry the composer args.
  if (/_chat$/.test(capabilityId) || bare === "chat") {
    const properties: RegistryTool["inputSchema"]["properties"] = {
      prompt: { type: "string", description: "The prompt to send on the site's own composer" },
      new_chat: { type: "boolean", description: "Start a fresh conversation first (default false)" },
    };
    const required = ["prompt"];
    // Site-specific rendered toggles named in the manifest description surface as
    // extra boolean args so a single chat tool can flip them inline.
    for (const key of ["thinking", "search"]) {
      if (description && new RegExp(`\\b${key}\\b`, "i").test(description)) {
        properties[key] = {
          type: "boolean",
          description: `Enable the in-page "${key}" toggle (default: as left in the browser)`,
        };
      }
    }
    return { type: "object", properties, required };
  }
  // Toggle capabilities ("reasoner", "web_search", ...) — flip a real UI toggle.
  if (/reasoner|web_search|\bsearch\b|toggle|_state$/i.test(capabilityId)) {
    return {
      type: "object",
      properties: {
        state: { type: "boolean", description: "Desired toggle state" },
      },
      required: [],
    };
  }
  // Pure-read capabilities (list_conversations, model_list, ...) take hints only.
  if (/list_conversations|model_list|history/.test(capabilityId)) {
    return {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum number of entries to return" },
        account: { type: "string", description: "Identity key of a stored account for this site (optional)" },
      },
      required: [],
    };
  }
  // Everything else: method-driven, no declared args.
  return { type: "object", properties: {}, required: [] };
}

/** Build the registry 'packages' array from the installed capability packages. */
export function buildRegistryPackages(): RegistryPackage[] {
  const ids = listInstalledPackageIds();
  const packages: RegistryPackage[] = [];
  for (const siteId of ids) {
    // Only packages the daemon can actually serve (has a packaged ChatSiteProfile).
    const profile = resolvePackagedProfile(siteId);
    if (!profile) continue;
    const pkgDir = findPackageDir(siteId);
    if (!pkgDir) continue;
    let manifest: Manifest | null = null;
    try {
      manifest = JSON.parse(readFileSync(resolve(pkgDir, "manifest.json"), "utf8")) as Manifest;
    } catch {
      manifest = null;
    }
    const caps = Array.isArray(manifest?.capabilities) ? manifest.capabilities : [];
    let status = "unknown";
    try {
      const meta = JSON.parse(
        readFileSync(resolve(pkgDir, "metadata.json"), "utf8")
      ) as Metadata;
      if (typeof meta.status === "string" && meta.status.trim()) status = meta.status.trim();
    } catch {
      // metadata.json absent → scaffold/experimental package, status stays "unknown"
    }
    const tools: RegistryTool[] = caps.map((c) => ({
      name: `${siteId}_${bareCapabilityId(siteId, c.id)}`,
      id: c.id,
      description: c.description || c.name || c.id,
      method: c.method || "ui-path",
      inputSchema: capabilityInputSchema(siteId, c.id, c.method, c.description),
    }));
    packages.push({
      id: siteId,
      name: manifest?.name || profile.name || siteId,
      url: manifest?.url || profile.url || "",
      description: manifest?.description || "",
      version: manifest?.version || "",
      site: manifest?.site || "",
      authRequired: manifest?.auth?.required !== false,
      status,
      chat: { model: siteId, streaming: true },
      tools,
    });
  }
  return packages;
}