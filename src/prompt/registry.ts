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
//          chat:   { model: <siteId>, streaming: true },   // ONLY on driveable chat packages
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
//
// `chat` is stamped ONLY on ids in the servable chat set — the exact
// `defaultChatSurface()` gate promptd builds its `/v1` (profilesById) allow-list
// from (GOAL 34 truth-gate). Every other installed package (capability-only
// surfaces like gmail/youtube/araprat, url-less chatglm, dormant zenmux,
// dead-end xiaomimimo, …) carries NO `chat` key at all: `/v1/chat/completions`
// would refuse it with 404 unknown_model, so an honest registry must not
// advertise it as chat. Consumers treat absence as "no chat" — never
// materialize a chat provider from a package without `chat.model`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { isDispatchable } from "./capability-dispatch.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackagedProfile, listProfiles, isDriveableChatProfile, type ChatSiteProfile } from "../profile/profile.js";
import { listAccounts, verifyStoredAccount, withAccountVerdict, type StoredAccount } from "../runtime/session-store.js";

export interface RegistryToolInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; default?: unknown }>;
  required: string[];
  /**
   * GOAL 139: "at least one of these" groups. A runner that reads
   * `args.q ?? args.query` accepts EITHER name — declaring BOTH required would
   * be a false claim (a consumer would send both, or reject a valid call), and
   * declaring NEITHER would let it send nothing. `anyOf` is the honest form, and
   * it is what a validating consumer needs to check a call correctly.
   */
  anyOf?: { required: string[]; description?: string }[];
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
  /**
   * GOAL 139: was `inputSchema` DECLARED by the package, or guessed? A guessed
   * schema has been measurably wrong, so a consumer that auto-generates a client
   * must be able to see the difference rather than trust a fabrication.
   */
  argsDeclared: boolean;
  /**
   * GOAL 140: "wired" = the daemon can execute this tool; "declared-only" = the
   * package declares it but no dispatch route exists, so a call 404s. Never
   * advertise the second as servable.
   */
  dispatch: "wired" | "declared-only";
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
  /**
   * Chat claim of this package — ABSENT (undefined) on every package NOT in
   * the servable chat set. Present ONLY when `id` is on `defaultChatSurface()`
   * (the SAME gate promptd builds its /v1 profilesById allow-list from): then
   * `model` = the site id `/v1/chat/completions` actually answers for.
   * Capability-only / url-less / dormant / dead-end packages (gmail, youtube,
   * araprat, chatglm, zenmux, xiaomimimo, …) keep status/tools/accounts but
   * carry NO chat key — /v1 would refuse them with 404 unknown_model, so an
   * honest registry never advertises them as chat (GOAL 34). Consumers must
   * treat absence as "no chat" (key on `pkg.chat?.model`, never `pkg.chat.model`).
   */
  chat?: RegistryChat;
  tools: RegistryTool[];
  /**
   * The identity-keyed vault accounts stored for this site — the SAME source
   * as `GET /accounts?site=<id>` (http.ts). Host is derived from the packaged
   * profile's url (`new URL(profile.url).host`), matching /accounts exactly.
   * `[]` is honest: it means "no accounts stored for this site's host". The
   * field is ABSENT (undefined) only when the package has no resolvable url
   * (no host to key the vault by) — never an empty-by-accident array.
   *
   * GOAL 89: every row carries the RECONCILED verdict (`usable` + a NAMED
   * `reason` when it cannot drive requests) — see `accountsSummary` below.
   */
  accounts?: StoredAccount[];
  /**
   * GOAL 89 host-level rollup of the account verdicts above. The registry is
   * the ONLY info source a consumer has, so an all-unusable host must be
   * visible as such and not merely look like an empty choice set: `usable: 0`
   * with the NAMED reasons listed. ABSENT when the package has no accounts.
   */
  accountsSummary?: RegistryAccountsSummary;
}

export interface RegistryAccountsSummary {
  total: number;
  usable: number;
  unusable: number;
  /** Deduped NAMED reasons behind the unusable rows (empty when all usable). */
  reasons: string[];
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
  /**
   * GOAL 139: the DECLARED arg contract — the real fix for the app authoring the
   * registry's own metadata. Measured: 0 of 33 packages declared one, so
   * `capabilityInputSchema` had to GUESS from the capability id, and it guessed
   * wrong (youtube_search advertised `{}` while its runner requires `args.query`;
   * it advertised `new_chat` which no runner reads — they read `newChat`).
   *
   * The arg names live in the RUNNER, so a guess can never be right by
   * construction. Declaring them here puts the contract in the PACKAGE — which
   * is the registry — so the app only READS it, and a consumer (a skill, a doc,
   * a generated client) reads the same single source. `test/registry-args-truth`
   * then fails LOUD when a declaration drifts from what the runner reads, so the
   * manifest cannot quietly become a lie.
   */
  inputSchema?: unknown;
  args?: unknown;
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

/**
 * GOAL 139: a DECLARED arg contract, validated before any consumer can see it.
 *
 * A malformed declaration must be REFUSED, never served: an empty-but-present
 * schema is worse than none, because a consumer trusts it. Mirrors the GOAL 61
 * per-entry filter (a bad capability is excluded, it does not poison the list).
 * Returns null when absent or wrong-shaped, so the caller falls back honestly.
 */
export function declaredCapabilityInputSchema(
  c: ManifestCapability
): RegistryToolInputSchema | null {
  const raw = c.inputSchema ?? c.args;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as { type?: unknown; properties?: unknown; required?: unknown; anyOf?: unknown };
  if (o.type !== "object") return null;
  if (typeof o.properties !== "object" || o.properties === null || Array.isArray(o.properties)) {
    return null;
  }
  // Every property must itself be a {type} object — an untyped property is
  // exactly the kind of half-declaration that misleads a consumer.
  for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
    if (k.trim() === "") return null;
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    if (typeof (v as { type?: unknown }).type !== "string") return null;
  }
  const required = Array.isArray(o.required)
    ? o.required.filter((r): r is string => typeof r === "string" && r.trim() !== "")
    : [];
  // A required key that is not a declared property is a self-contradiction.
  const propNames = new Set(Object.keys(o.properties as Record<string, unknown>));
  if (required.some((r) => !propNames.has(r))) return null;
  // anyOf ("at least one of") must be well-formed for the same reason: each
  // branch needs a non-empty `required` naming only declared properties.
  let anyOf: RegistryToolInputSchema["anyOf"];
  if (o.anyOf !== undefined) {
    if (!Array.isArray(o.anyOf) || o.anyOf.length === 0) return null;
    const branches: { required: string[]; description?: string }[] = [];
    for (const raw of o.anyOf as unknown[]) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
      const b = raw as { required?: unknown; description?: unknown };
      if (!Array.isArray(b.required)) return null;
      const names = b.required.filter((r): r is string => typeof r === "string" && r.trim() !== "");
      if (names.length === 0) return null;
      if (names.some((r) => !propNames.has(r))) return null;
      branches.push({
        required: names,
        ...(typeof b.description === "string" ? { description: b.description } : {}),
      });
    }
    anyOf = branches;
  }
  return {
    type: "object",
    properties: o.properties as RegistryToolInputSchema["properties"],
    required,
    ...(anyOf ? { anyOf } : {}),
  };
}

/**
 * Derive an MCP-tool-shaped input schema for a capability from its manifest entry.
 *
 * A DECLARED contract wins outright. The regex branches below are now an
 * explicitly-labelled LAST RESORT for a package that has not declared one yet —
 * they are a guess, they have been measurably wrong, and `argsDeclared:false`
 * on the served tool tells every consumer not to trust them.
 */
export function capabilityInputSchema(
  siteId: string,
  capabilityId: string,
  _method: string | undefined,
  description: string | undefined,
  declared?: RegistryToolInputSchema | null
): RegistryToolInputSchema {
  if (declared) return declared;
  const bare = bareCapabilityId(siteId, capabilityId);
  // Chat capabilities carry the composer args.
  if (/_chat$/.test(capabilityId) || bare === "chat") {
    const properties: RegistryTool["inputSchema"]["properties"] = {
      prompt: { type: "string", description: "The prompt to send on the site's own composer" },
      // GOAL 139: the runners read camelCase `newChat` (gemini.ts:259,
      // kimi.ts:215). The old `new_chat` was read by NOTHING, so a consumer
      // following the schema sent it and silently continued the old
      // conversation instead of starting a new one — a wrong answer, not an
      // error. The name now matches the code that actually reads it.
      newChat: { type: "boolean", description: "Start a fresh conversation first (default false)" },
    };
    const required = ["prompt"];
    // Site-specific rendered toggles named in the manifest description surface as
    // extra boolean args so a single chat tool can flip them inline. GUESS ONLY:
    // these are keyed on description prose, and no runner reads them yet, so they
    // are deliberately NOT emitted (a schema property nothing implements is a
    // lie a consumer can act on). Declared args are the way to add one.
    void description;
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
 * Machine status of a SURFACED chat id (GOAL 32 truth-gate). "builtin" for the
 * curated catalog (its verification lives in the profile's own note, not a
 * machine field); packaged ids derive it from their manifest/metadata:
 * "verified" ONLY from a real metadata.verified record with a live round-trip;
 * "unverified-candidate" = driveable selectors, no recorded live round-trip
 * (annotated, never claimed verified); "dormant"/"dead-end" = excluded from
 * the chat surface until a live round-trip exists.
 */
export type ChatSurfaceStatus = "verified" | "unverified-candidate" | "dormant" | "dead-end" | "builtin";

/** Per-id status of the SURFACED chat set. Unknown/id-less ids get the
 *  conservative "unverified-candidate" (nothing beyond a packaged profile is
 *  ever asserted). */
export function chatSurfaceStatus(siteId: string): ChatSurfaceStatus {
  // GOAL 92: a builtin profile that ALSO has a packaged verified/dormant/dead-end
  // record must report THAT status, not the bare "builtin" — otherwise a
  // /registry consumer cannot tell "builtin + live-verified" from "builtin +
  // never tried", and the shipped status column cannot be pinned to the machine
  // truth. "builtin" is only the fallback for a profile with no package record.
  const packaged = packageStatusOf(siteId);
  if (listProfiles().some((p) => p.id === siteId)) {
    return packaged === "unknown" ? "builtin" : packaged;
  }
  return packaged === "unknown" ? "unverified-candidate" : packaged;
}

/** The manifest/metadata status of an installed package: "dormant", "dead-end"
 *  (both excluded from the chat surface), "verified" (real verified record) or
 *  "unknown" (scaffold/unverified — no metadata or no record). */
function packageStatusOf(siteId: string): ChatSurfaceStatus | "unknown" {
  const pkgDir = findPackageDir(siteId);
  if (!pkgDir) return "unknown";
  let meta: Metadata | null = null;
  try {
    meta = JSON.parse(readFileSync(resolve(pkgDir, "metadata.json"), "utf8")) as Metadata;
  } catch {
    meta = null; // no metadata.json -> scaffold/experimental, unverified
  }
  if (typeof meta?.status === "string") {
    if (meta.status === "dormant" || meta.status === "dead-end") return meta.status;
  }
  const v = meta?.verified;
  if (v && typeof v === "object" && typeof v.since === "string" && typeof v.evidence === "string" && typeof v.via === "string") {
    return "verified";
  }
  return "unknown";
}

export interface ChatSurfaceEntry {
  id: string;
  profile: ChatSiteProfile;
  /** GOAL 32 status of this surfaced id (see ChatSurfaceStatus). Excluded
   *  ids are NOT in this list — they stay on /registry with their honest
   *  manifest status instead. */
  status: ChatSurfaceStatus;
  packaged: boolean;
}

/**
 * The daemon's DEFAULT configured chat-site set (GOAL 30 merge + GOAL 32
 * truth-gate): the builtin chat catalog PLUS every installed, driveable
 * chat-shaped package profile (capabilities/<id>/profile.json — the same
 * canonical source /capability and /registry serve). This is what
 * `--site`-less promptd, `GET /sites`, `GET /v1/models` and
 * `ui2api prompt --sites` all reflect. Rules:
 *   - a builtin id is authoritative for that id (packaged overrides never
 *     shadow the builtin profile);
 *   - a package only joins when `isDriveableChatProfile` — chat-shaped
 *     (composer + answer + url, GOAL 30) AND every composer/answer entry is a
 *     PARSEABLE CSS selector (GOAL 32: prose entries like t3chat's former
 *     "UNVERIFIED-SCAFFOLD — …" crash the driver's querySelectorAll at send
 *     time); capability-only surfaces (gmail/youtube/araprat/chatglm/
 *     tinycms/…) never become chat models;
 *   - a packaged id whose manifest status is "dormant" or "dead-end"
 *     (zenmux parked-origin, xiaomimimo DNS-pinned dead-end) is EXCLUDED from
 *     the chat surface until live-verified — it stays fully served on
 *     /registry + /capability/<id> with that honest status;
 *   - an explicit `--site`/`profiles` list stays authoritative (startPromptd
 *     only calls this in its default path; resolveProfile is untouched).
 */
export function defaultChatSurface(): ChatSurfaceEntry[] {
  const entries: ChatSurfaceEntry[] = [];
  const byId = new Map<string, ChatSiteProfile>();
  for (const p of listProfiles()) {
    byId.set(p.id, p);
    entries.push({ id: p.id, profile: p, status: "builtin", packaged: false });
  }
  for (const id of listInstalledPackageIds()) {
    if (byId.has(id)) continue;
    const packaged = resolvePackagedProfile(id);
    if (!packaged || !isDriveableChatProfile(packaged)) continue;
    const status = packageStatusOf(id);
    if (status === "dormant" || status === "dead-end") continue; // honest exclusion until live-verified
    byId.set(id, packaged);
    entries.push({ id, profile: packaged, status: status === "verified" ? "verified" : "unverified-candidate", packaged: true });
  }
  return entries;
}

export function defaultChatProfiles(): ChatSiteProfile[] {
  return defaultChatSurface().map((e) => e.profile);
}

/** Build the registry 'packages' array from the installed capability packages. */
/**
 * GOAL 61: crash-proofing filter for manifest capability entries. A malformed
 * installed manifest (capabilities entry that is null / primitive / missing
 * its string `id`) must NEVER take down the whole /registry build — the read
 * seams refuse malformed storage gracefully (GOAL 58/59/60), and this is the
 * registry-build twin. Malformed entries are EXCLUDED (never advertised, never
 * crash); well-formed entries pass through untouched.
 */
export function validManifestCapability(c: unknown): c is ManifestCapability & { id: string } {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
  const id = (c as { id?: unknown }).id;
  return typeof id === "string" && id.trim() !== "";
}

/**
 * GOAL 139: the SELF-SUFFICIENCY BLOCK.
 *
 * The audit that started this found the load-bearing gap: `/registry` described
 * WHAT exists but never HOW to call it. A third-party consumer — a generated
 * PHP client, a skill teaching an AI to register a site, per-site docs — had to
 * know the verb, the path, and the body keys out of band, i.e. it had to know
 * ui2api's HTTP internals. That is precisely the coupling the registry exists to
 * remove, and it is why the PHP generator had to hardcode `/capability/` and
 * `{capability, args}` (lang-php.ts:363-369).
 *
 * So the daemon now ships its own call contract alongside its inventory. A
 * consumer reads this and can construct a valid request with zero knowledge of
 * the app. `contractVersion` is the DRIFT GATE: it changes whenever the wire
 * contract does, so a consumer built against an older daemon can detect the
 * mismatch instead of failing silently at runtime.
 */
export const REGISTRY_CONTRACT_VERSION = 1;

export interface RegistryContract {
  contractVersion: number;
  endpoints: {
    capability: { method: string; pathTemplate: string; bodyKeys: string[]; requiredBodyKeys: string[] };
    chatCompletions: { method: string; pathTemplate: string; bodyKeys: string[]; requiredBodyKeys: string[]; openAICompatible: boolean };
    registry: { method: string; pathTemplate: string };
    models: { method: string; pathTemplate: string };
    accounts: { method: string; pathTemplate: string; note: string };
  };
  auth: { header: string; scheme: string; required: boolean; note: string };
  /**
   * Honest scope note, so a consumer never over-reads the payload: the package
   * list is built ONLY from installed packages under capabilities/<id>/. The
   * daemon cannot fetch or publish registry content — that is a CLI action.
   */
  scope: { source: string; daemonFetchesRegistry: false; daemonPublishesRegistry: false };
}

export function buildRegistryContract(tokenRequired: boolean): RegistryContract {
  return {
    contractVersion: REGISTRY_CONTRACT_VERSION,
    endpoints: {
      capability: {
        method: "POST",
        pathTemplate: "/capability/{site}",
        // `account` is a TOP-LEVEL body key, not an arg — the audit found the
        // old schema advertising it inside `properties`, which would have made
        // a consumer nest it under args and have it ignored.
        bodyKeys: ["capability", "args", "account"],
        requiredBodyKeys: ["capability"],
      },
      chatCompletions: {
        method: "POST",
        pathTemplate: "/v1/chat/completions",
        bodyKeys: ["model", "messages", "stream", "new_chat", "account"],
        requiredBodyKeys: ["model", "messages"],
        openAICompatible: true,
      },
      registry: { method: "GET", pathTemplate: "/registry" },
      models: { method: "GET", pathTemplate: "/v1/models" },
      accounts: {
        method: "GET",
        pathTemplate: "/accounts?site={site}",
        note: "`account` accepted by the capability/chat endpoints is a slug or identity from this list",
      },
    },
    auth: {
      header: "Authorization",
      scheme: "Bearer",
      required: tokenRequired,
      note: tokenRequired
        ? "this daemon is token-gated; send `Authorization: Bearer <UI2API_PROMPTD_TOKEN>` on every call"
        : "no daemon token is configured; this daemon is loopback-only posture",
    },
    scope: {
      source: "installed packages under capabilities/<id>/ (manifest.json + metadata.json)",
      daemonFetchesRegistry: false,
      daemonPublishesRegistry: false,
    },
  };
}

export function buildRegistryPackages(): RegistryPackage[] {
  const ids = listInstalledPackageIds();
  const dataDir = resolveDataDir();
  const packages: RegistryPackage[] = [];
  // The ONLY servable chat set — the same gate promptd's /v1 profilesById is
  // built from (defaultChatProfiles → defaultChatSurface). A package is marked
  // chat iff its id is on this surface (GOAL 34 truth-gate): registry chat
  // claims must never exceed what /v1/chat/completions can actually answer.
  const chatSurfaceIds = new Set(defaultChatSurface().map((e) => e.id));
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
    // GOAL 61: per-entry filter — a malformed capability entry is EXCLUDED
    // (never advertised), never a TypeError that kills the whole registry.
    const tools: RegistryTool[] = caps.filter(validManifestCapability).map((c) => {
      const declared = declaredCapabilityInputSchema(c);
      return {
        name: `${siteId}_${bareCapabilityId(siteId, c.id)}`,
        id: c.id,
        description: c.description || c.name || c.id,
        method: c.method || "ui-path",
        workType: c.method === "js-function" ? "js-function" : "ui-path",
        reloadAfterSuccess: true,
        inputSchema: capabilityInputSchema(siteId, c.id, c.method, c.description, declared),
        // GOAL 139: the honesty flag. `false` means the schema above is a
        // best-effort GUESS, because the package declared no arg contract. A
        // consumer can then refuse to auto-generate a client for a tool it
        // cannot trust, instead of shipping a call that silently sends the
        // wrong fields.
        argsDeclared: declared !== null,
        // GOAL 140: is this tool actually CALLABLE, or only declared? /registry
        // is built from the manifest (data) while execution goes through the
        // dispatch table (also data now, but a separate one) — so a package can
        // declare a capability the daemon cannot route. Before this field that
        // was invisible: the tool was advertised and then 404'd at call time.
        // A consumer building a client keys on this instead of finding out.
        dispatch: isDispatchable(siteId) ? "wired" : "declared-only",
      };
    });
    // Stored vault accounts for this site, keyed by the packaged profile's host
    // — EXACTLY the host GET /accounts?site= uses (http.ts: new URL(profile.url).host).
    // No url → no host to key the vault by → field omitted (undefined).
    //
    // GOAL 89: the index is RECONCILED, not trusted. Every row is re-checked
    // against the snapshot actually on disk by the SAME pure reconciler
    // /accounts serves (`verifyStoredAccount`), so a row that points at a
    // missing / unreadable / anonymous / wrong-shaped snapshot is advertised
    // as `usable: false` with its NAMED reason — a consumer that trusts the
    // registry (the ONLY info source it has) can never pick an account that
    // can only replay signed-out. An unusable row is still LISTED (a real
    // stored row the user may want to see and delete), and the host-level
    // rollup makes an all-unusable host visible instead of silently empty.
    let accounts: StoredAccount[] | undefined;
    let accountsSummary: RegistryAccountsSummary | undefined;
    const profileUrl = profile.url;
    if (profileUrl) {
      try {
        const host = new URL(profileUrl).host;
        accounts = listAccounts(dataDir, host).map((a) => withAccountVerdict(a, verifyStoredAccount(dataDir, host, a)));
        if (accounts.length > 0) {
          const reasons = [...new Set(accounts.filter((a) => a.usable === false).map((a) => a.reason ?? "unknown"))];
          accountsSummary = {
            total: accounts.length,
            usable: accounts.filter((a) => a.usable !== false).length,
            unusable: accounts.filter((a) => a.usable === false).length,
            reasons,
          };
        }
      } catch {
        accounts = undefined;
        accountsSummary = undefined;
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
      ...(chatSurfaceIds.has(siteId) ? { chat: { model: siteId, streaming: true } } : {}),
      tools,
      ...(accounts !== undefined ? { accounts } : {}),
      ...(accountsSummary !== undefined ? { accountsSummary } : {}),
    });
  }
  return packages;
}