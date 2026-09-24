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
import { resolvePackagedProfile, listProfiles, isChatShapedProfile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, type StoredAccount } from "../runtime/session-store.js";

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
  /**
   * Execution style for this capability:
   *  - "ui-path":   drive the site's own real UI — mouse/keyboard against the
   *                 page (composer typing, toggle clicks). Slower, visible as
   *                 a genuine human session, works on any site.
   *  - "js-function": inject what the site's own JS function expects into the
   *                 DOM and call the function directly (no mouse/keyboard).
   *                 Faster, invisible — the site runs exactly its own code
   *                 path. Work type is chosen per-capability here, in the map.
   * Defaults to "ui-path".
   */
  workType: "ui-path" | "js-function";
  /**
   * Reload-after-success policy, part of the map contract itself: the only
   * thing the daemon needs to do after each successful action is to refresh
   * the page, so anything the host site's server knows about this session is
   * re-established and a missing piece of info in the current DOM can never
   * leak into the next call — the map functions keep working by just
   * reloading the page each time.
   */
  reloadAfterSuccess: boolean;
  method: string;  inputSchema: RegistryToolInputSchema;
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
  /**
   * Machine-checkable verification record, from metadata.json `verified`.
   * `false` (or absent) = NOT verified — the registry consumer can rely on
   * this to gate which packages it surfaces as working. Never set without a
   * real recorded live round-trip in this repo.
   */
  verified: RegistryVerified | false;
  chat: RegistryChat;
  tools: RegistryTool[];
  /**
   * The identity-keyed vault accounts stored for this site — the SAME source
   * as `GET /accounts?site=<id>` (http.ts). Host is derived from the packaged
   * profile's url (`new URL(profile.url).host`), matching /accounts exactly.
   * `[]` is honest: it means "no accounts stored for this site's host". The
   * field is ABSENT (undefined) only when the package has no resolvable url
   * (no host to key the vault by) — never an empty-by-accident array.
   */
  accounts?: StoredAccount[];
}

export interface RegistryVerified {
  /** ISO date the live round-trip was recorded. */
  since: string;
  /** Human-readable proof pointer (proof id / live-qualified check). */
  evidence: string;
  /** How it was verified (session-locked vault replay, attached real Chrome, …). */
  via: string;
  /** Optional honesty note: which capabilities the verification covers. */
  scope?: string;
}

interface Metadata {
  status?: string;
  verified?: RegistryVerified | boolean;
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

/** Resolve the daemon's data dir the same way promptd/pool do (env → "data"). */
export function resolveDataDir(): string {
  return process.env.UI2API_DATA_DIR || process.env.UI2API_DATA_DIR_OVERRIDE || "data";
}

/**
 * The daemon's DEFAULT configured chat-site set (GOAL 30): the builtin chat
 * catalog PLUS every installed, chat-shaped package profile
 * (capabilities/<id>/profile.json — the same canonical source /capability and
 * /registry serve). This is what `--site`-less promptd, `GET /sites`,
 * `GET /v1/models` and `ui2api prompt --sites` all reflect. Rules:
 *   - a builtin id is authoritative for that id (packaged overrides never
 *     shadow the builtin profile);
 *   - a package only joins when `isChatShapedProfile` (composer + answer + url);
 *     capability-only surfaces (gmail/youtube/araprat/chatglm/tinycms/…) never
 *     become chat models;
 *   - an explicit `--site`/`profiles` list stays authoritative (startPromptd
 *     only calls this in its default path).
 */
export function defaultChatProfiles(): ChatSiteProfile[] {
  const byId = new Map<string, ChatSiteProfile>();
  for (const p of listProfiles()) byId.set(p.id, p);
  for (const id of listInstalledPackageIds()) {
    if (byId.has(id)) continue;
    const packaged = resolvePackagedProfile(id);
    if (packaged && isChatShapedProfile(packaged)) byId.set(id, packaged);
  }
  return [...byId.values()];
}

/** Build the registry 'packages' array from the installed capability packages. */
export function buildRegistryPackages(): RegistryPackage[] {
  const ids = listInstalledPackageIds();
  const dataDir = resolveDataDir();
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
    let verified: RegistryVerified | false = false;
    try {
      const meta = JSON.parse(
        readFileSync(resolve(pkgDir, "metadata.json"), "utf8")
      ) as Metadata;
      if (typeof meta.status === "string" && meta.status.trim()) status = meta.status.trim();
      // A truthy `verified` value must be a full record; anything else (true,
      // bogus) is refused here and by validate-registry.mjs so consumers can
      // trust the field.
      const v = meta.verified;
      if (v && typeof v === "object" && typeof v.since === "string" && typeof v.evidence === "string" && typeof v.via === "string") {
        verified = { since: v.since, evidence: v.evidence, via: v.via, scope: v.scope ?? undefined };
      }
    } catch {
      // metadata.json absent → scaffold/experimental package, status stays "unknown"
    }
    const tools: RegistryTool[] = caps.map((c) => ({
      name: `${siteId}_${bareCapabilityId(siteId, c.id)}`,
      id: c.id,
      description: c.description || c.name || c.id,
      method: c.method || "ui-path",
      workType: c.method === "js-function" ? "js-function" : "ui-path",
      reloadAfterSuccess: true,
      inputSchema: capabilityInputSchema(siteId, c.id, c.method, c.description),
    }));
    // Stored vault accounts for this site, keyed by the packaged profile's host
    // — EXACTLY the host GET /accounts?site= uses (http.ts: new URL(profile.url).host).
    // No url → no host to key the vault by → field omitted (undefined).
    let accounts: StoredAccount[] | undefined;
    const profileUrl = profile.url;
    if (profileUrl) {
      try {
        accounts = listAccounts(dataDir, new URL(profileUrl).host);
      } catch {
        accounts = undefined;
      }
    }
    packages.push({
      id: siteId,
      name: manifest?.name || profile.name || siteId,
      url: manifest?.url || profile.url || "",
      description: manifest?.description || "",
      version: manifest?.version || "",
      site: manifest?.site || "",
      authRequired: manifest?.auth?.required !== false,
      status,
      verified,
      chat: { model: siteId, streaming: true },
      tools,
      ...(accounts !== undefined ? { accounts } : {}),
    });
  }
  return packages;
}