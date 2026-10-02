// OpenAI-compatible surface for promptd — /v1/models + /v1/chat/completions.
//
// Purpose: turn ui2api's browser-control chat sites into a first-class
// OpenAI-compatible endpoint so OmniRoute (and any OpenAI SDK/client) can
// route chat completions to the user's real logged-in sessions — the same
// machinery as POST /prompt, but speaking the industry wire format.
//
//   GET  /v1/models
//           -> {object:"list", data:[{id:"deepseek", ...}, {id:"kimi", ...}, ...]}
//   GET  /v1/models/<id>
//           -> the SAME single entry the list would contain for that id
//   POST /v1/chat/completions
//           body: {model:"deepseek"|"ui2api/deepseek", messages:[...],
//                  stream?:boolean, stream_options?:{include_usage?:boolean},
//                  new_chat?:boolean, account?:string,
//                  temperature?, max_tokens?}
//           -> non-stream: OpenAI chat.completion JSON
//              stream:     SSE of chat.completion.chunk events then [DONE]
//
// ── PARAMETER HONESTY (read this before adding a knob) ───────────────────────
//
// This surface types a prompt into a site's own composer through its own UI and
// reads the rendered answer back. There is no sampling API underneath: the site
// is not asked for a temperature, a top_p, a seed or a stop sequence, because
// the site is not being ASKED anything of the kind — a human is not either.
//
// So those parameters are NOT honoured, and the important part is that they are
// not SILENTLY dropped. A caller that tunes `temperature: 0.2` and believes it
// got a greedy answer has been told something false, and a caller that tunes it
// and cannot see that it was ignored will keep tuning it forever. Every response
// therefore REPORTS the ignored ones back, by name, under
// `ui2api.parameters.ignored` — the caller learns from the response that the
// knob did nothing, without reading this file.
//
// Deliberately NOT "honoured" by truncating the finished answer: `stop` and
// `max_tokens` both mean "generate less". The site already generated the whole
// answer and we hold it complete; cutting it would produce a short answer that
// is byte-identical in shape to a model that genuinely stopped there, and the
// caller could not tell the difference. That is the confidently-wrong-answer
// class this project refuses, so these are reported as ignored instead. The
// parameters that ARE honoured are `stream`, `stream_options.include_usage`,
// `tools` (soft, when a tool layer is wired), `new_chat` and `account`.
//

// Streaming note (honest): the ChatDriver reads the site's rendered answer
// when it stops growing, so the completion is COMPLETE before we start
// writing. stream:true replays the finished answer as incremental SSE
// chunks — token timings are cosmetic; there is no half-answer visible.
//
// Capabilities beyond chat (web search toggles, file/vision upload, model
// pickers…) stay on the ui2api-native /capability/<site> routes; the /v1
// surface covers the chat core (the router's main call path).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatPool } from "./pool.js";
import { redactInternalError } from "./error-redaction.js";
import { INVALID_JSON_MESSAGE } from "./consumer-surface.js";
import type { ChatSiteProfile } from "../profile/profile.js";
import {
  chatSurfaceStatus,
  defaultChatSurface,
  answerableChatSurface,
  readModelVerification,
  withheldChatModels,
  modelAdvertisementSummary,
  type ChatSurfaceStatus,
  type RegistryVerified,
} from "./registry.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeToolReadback, type KimiToolEvidenceRaw } from "../capabilities/kimi.js";

export interface OpenAIOptions {
  pool: ChatPool;
  profilesById: Record<string, ChatSiteProfile>;
  /**
   * The prompt-driven tool layer, injected BY STRUCTURE (never imported — the
   * module is owned elsewhere and this file must not break while it is
   * absent). When the daemon passes the three functions below, this surface can
   * execute an OpenAI `tools` array the SOFT way: the tools are rendered into
   * the prompt, the model's reply is parsed back into a tool call, and the
   * markup is stripped from the visible answer. Absent → `tools: "none"`,
   * which is the honest state of a build with no tool layer.
   *
   * Structural on purpose: whoever wires the layer passes its exports and the
   * compiler checks the signature here, so a drift in the layer's shape is a
   * TYPE error instead of a runtime lie.
   */
  softTools?: {
    buildToolInstruction(tools: unknown): string;
    parseToolCall(raw: string, tools: unknown): unknown;
    stripToolCall(raw: string): { content: string; parsed: unknown };
  };
  /** Identity-keyed account validation, injected by the daemon (http.ts) so the
   *  /v1 surface enforces the SAME vault check as /prompt and /capability/<site>:
   *  an unknown account throws (→ 400 in the server catch) BEFORE any browser
   *  work. Absent → no account was requested (legacy default path). */
  validateAccount?: (account: string | undefined, profile: ChatSiteProfile) => void;
}

const PREFIX = "ui2api/";

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY METADATA ON /v1/models (the "make the models discoverable as a
// provider with their capabilities" ask)
//
// Before this, an entry carried `id` + `object:"model"` and nothing else: a
// consumer materialising one provider per advertised model could not tell
// whether it streams, whether it can take tools, or whether it is honestly
// blocked — it could only find out by making a request and failing. That is
// the same defect class this whole surface exists to prevent (a caller forced
// to discover a fact by failing).
//
// EVERY field below is DERIVED at request time from a source that already owns
// the truth. There is deliberately NO per-model capability table anywhere in
// this file: such a table is a snapshot that rots, and this repo has been
// burned by hand-typed snapshots more than once. If a fact is not derivable it
// is OMITTED, never filled in with a plausible number.
// ─────────────────────────────────────────────────────────────────────────────

/** Drift gate for the capability block (same idea as REGISTRY_CONTRACT_VERSION):
 *  bumped whenever the SHAPE of a capability field changes, so a consumer built
 *  against an older daemon can detect the mismatch instead of silently
 *  mis-reading a field. */
export const MODEL_CAPABILITIES_VERSION = 1;

/**
 * Tool-calling support, and the vocabulary a consumer must read:
 *  - "native" — the SITE itself invoked its own tool during the turn, and this
 *    surface read that invocation back off the page and reports it. The
 *    arguments are the site's own evidence and nothing else (see
 *    NATIVE_TOOL_READERS).
 *  - "soft"   — the daemon renders the requested tools into the prompt and
 *                parses the reply back into a tool call. Works on any chat site
 *                because it uses only the site's own composer. Enabled by
 *                `opts.softTools` being wired. The model has NOT run anything.
 *  - "none"   — no tool layer is wired; a `tools` array in the request is
 *                ignored. Honest, and the default.
 */
export type ModelToolSupport = "native" | "soft" | "none";

export const MODEL_TOOL_SUPPORT_VALUES: readonly ModelToolSupport[] = ["native", "soft", "none"];

/**
 * Did THIS handler ever emit `tools:"native"`? Read this before believing the
 * word "native" anywhere in this file.
 *
 * `tools:"native"` is a per-SITE claim, and the site is what runs the tool —
 * so it is derived per site from NATIVE_TOOL_READERS below, never from this
 * constant. This constant answers a narrower, still-useful question: does this
 * handler CONTAIN a native emission path at all? A `true` here with an empty
 * registry would be a lie, and the registry is the thing that actually
 * produces calls.
 *
 * It is consulted by the gates that read this file as text (a `tool_calls`
 * emission is only legitimate when it is reachable from here), which is why it
 * stays a single auditable constant rather than being computed at each use.
 */
export const NATIVE_TOOL_CALL_SUPPORTED = true;

// ─────────────────────────────────────────────────────────────────────────────
// NATIVE TOOL EVIDENCE — the real thing.
//
// A native call is NOT one this daemon invents. It is a record that the SITE,
// through its own UI and its own JavaScript, invoked a tool while answering
// this turn, and that the site then RENDERED the result of that invocation into
// the page we are already holding. The evidence is therefore read off that page
// after the answer settles, using the site's own verified selectors.
//
// THE RULE THAT MAKES THIS HONEST: an argument may only ever be built from
// what the site rendered. There is no path here that turns a model sentence, a
// prompt instruction, or a soft-parser hit into a native call. When the site
// rendered nothing, the answer is returned untouched and no call is emitted —
// see `observed === false` in buildNativeToolCall, which returns null.
// ─────────────────────────────────────────────────────────────────────────────

/** The site's own evidence, flattened to exactly the fields a call may carry. */
export interface NativeToolEvidence {
  /** The tool as the site labels it, e.g. "web_search". */
  tool: string;
  /** TRUE only when the site itself rendered proof the tool ran. */
  observed: boolean;
  /** The site's own human-facing tool title, e.g. "Retrieve Tokyo weather via Web Search". */
  toolTitle: string | null;
  /** N parsed out of the site's own "Search（N results）" label; null when not rendered. */
  resultCount: number | null;
  /** The site's own result label, verbatim. */
  resultLabel: string | null;
  /** Real citation URLs the SITE rendered, in page order, deduped. Never synthesized. */
  citations: string[];
  /** NAMED reason when observed === false. */
  reason: string | null;
}

/** The minimum page surface a reader needs. Structurally typed so a Playwright
 *  `Page` satisfies it without this file importing a browser type, and so a
 *  test can supply a stub that returns a fixed raw scrape. */
export interface NativeReadablePage {
  evaluate(script: string): Promise<unknown>;
}

export type NativeToolReader = (page: NativeReadablePage) => Promise<NativeToolEvidence>;

/**
 * KIMI — the measured native reader.
 *
 * Every selector here is VERIFIED against a live kimi.ai account (see the
 * header comment of src/capabilities/kimi.ts for the measurement): the site's
 * own fired-search node `div.toolcall-web_search`, the tool-title spans
 * `span.toolcall-title-name-text` carrying `Search（N results）` with FULLWIDTH
 * parens, and the citation anchors `a.pua-ref-cite-tag[href]` carrying the real
 * external URLs.
 *
 * The scrape is a STRING evaluate, not a closure: the kimi bundle is
 * __name-mangled and a named arrow inside page.evaluate hangs or crashes. That
 * constraint is measured, not stylistic, and it is the same one duckduckgo's
 * history read-back hit.
 *
 * The verdict is NOT made here. This function only collects raw DOM facts and
 * hands them to the site's own `normalizeToolReadback` — the single fabrication
 * gate, already exercised by the capability runner. Reusing it rather than
 * re-implementing it is the point: a second, looser gate in this file would be
 * a second place to get the fabrication wrong.
 */
const kimiNativeReader: NativeToolReader = async (page) => {
  const raw = (await page.evaluate(`(() => {
    const txt = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\\s+/g, " ").trim();
    const labelNodes = [...document.querySelectorAll("span.toolcall-title-name-text")].map(txt).filter(Boolean);
    const containers = document.querySelectorAll('div[class*="toolcall-container"][class*="web_search"], div.toolcall-web_search, [class*="toolcall"][class*="web_search"]');
    const cite = [...document.querySelectorAll('a.pua-ref-cite-tag[href]')].map((a) => (a.getAttribute('href') || '').split('#')[0]).filter((h) => /^https?:\\/\\//.test(h));
    const resultLabel = labelNodes.find((l) => /Search\\s*[(\\uff08]\\s*\\d+\\s*results?/i.test(l)) || null;
    return {
      labels: labelNodes,
      resultLabel,
      searchToolContainers: containers.length,
      referencesAction: [...document.querySelectorAll(".ref-action")].some((e) => txt(e) === "Reference"),
      citations: [...new Set(cite)],
      searchEnabled: localStorage.getItem("selectSearch") === "true" ? true : localStorage.getItem("selectSearch") === "false" ? false : null,
    };
  })()`)) as KimiToolEvidenceRaw;
  const rb = normalizeToolReadback(raw);
  return {
    tool: rb.tool,
    observed: rb.observed,
    toolTitle: rb.toolTitle,
    resultCount: rb.evidence.resultCount,
    resultLabel: rb.evidence.resultLabel,
    citations: rb.evidence.citations,
    reason: rb.reason,
  };
};

/**
 * Which sites have a MEASURED native reader, keyed by site id.
 *
 * This is the single source of every native fact in this file: the /v1/models
 * `tools` value is derived from its keys, and a native tool call is emitted only
 * for a site in it. A site with no entry here is `tools:"soft"` or `"none"` and
 * can never produce a native call — which is the honest state, not a gap: a
 * reader needs VERIFIED selectors and a live measurement behind it, and adding
 * one is a measurement, not a declaration.
 *
 * Not a capability table: a per-model table of what a model "can do" is the
 * snapshot-that-rots this file refuses everywhere else. This maps a site to the
 * CODE that reads that site, and every key is a real, working reader.
 */
export const NATIVE_TOOL_READERS: Readonly<Record<string, NativeToolReader>> = { kimi: kimiNativeReader };

/** The site ids that can produce a real, evidence-backed tool call. */
export function nativeToolSites(): string[] {
  return Object.keys(NATIVE_TOOL_READERS);
}

/** How a tool call on this wire was produced. The field a consumer reads to
 *  tell the two apart without consulting any ui2api document.
 *  - "native"       — the SITE ran the tool; `executed` is true; the arguments
 *                     are the site's own evidence.
 *  - "soft-prompt"  — the MODEL was asked, in prose, to emit a call; `executed`
 *                     is false and the caller runs the function. Nothing ran. */
export type ToolCallMechanism = "native" | "soft-prompt";

/** The per-call provenance block, emitted on every choice that carries a call. */
export interface ToolCallProvenance {
  mechanism: ToolCallMechanism;
  /** Did the function actually run? true for native, false for soft. */
  executed: boolean;
  /** Which site answered. */
  site: string;
  /** The tool as the SITE names it. Null for a soft call (the model named it). */
  tool: string | null;
  /** The site's own rendered evidence, verbatim. Null for a soft call. */
  evidence: {
    toolTitle: string | null;
    resultCount: number | null;
    resultLabel: string | null;
    citations: string[];
  } | null;
  /** True when the model also emitted soft scaffolding that was NOT promoted,
   *  because the site's real invocation outranks a prompt-driven approximation. */
  suppressedSoft: boolean;
}

/** The argument object of a native call. EXACTLY the three measured fields and
 *  nothing else — no prompt text, no answer text, no inferred query. If the
 *  site rendered no result count, `resultCount` is `null`, which is the truth. */
export interface NativeToolArguments {
  tool: string;
  tool_title: string | null;
  result_count: number | null;
  citations: string[];
}

/**
 * Build a native tool call from site evidence, or `null` for NO call.
 *
 * `null` is returned in every case that is not a proven invocation, and those
 * cases are the common ones: the site has no reader, the reader found no page,
 * the page scrape failed, or `observed` is false. The last of those is the
 * fabrication gate in its purest form — an unobserved turn produces an ordinary
 * answer with no `tool_calls` key, because there is no such thing as a tool
 * call that did not happen.
 */
export function buildNativeToolCall(
  evidence: NativeToolEvidence | null,
  site: string
): { call: OpenAIToolCall; arguments: NativeToolArguments; provenance: Omit<ToolCallProvenance, "suppressedSoft"> } | null {
  if (!evidence) return null;
  if (evidence.observed !== true) return null;
  // The function name is DERIVED from the site's own vocabulary with this
  // repo's established tool-naming rule (`<site>_<capability>`, the same shape
  // the /registry tool names use), so it cannot drift from the capability the
  // site actually exposes.
  const name = `${site}_${evidence.tool}`;
  const args: NativeToolArguments = {
    tool: evidence.tool,
    tool_title: evidence.toolTitle,
    result_count: evidence.resultCount,
    citations: evidence.citations,
  };
  return {
    call: {
      id: `call_native_${site}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    arguments: args,
    provenance: {
      mechanism: "native",
      executed: true,
      site,
      tool: evidence.tool,
      evidence: {
        toolTitle: evidence.toolTitle,
        resultCount: evidence.resultCount,
        resultLabel: evidence.resultLabel,
        citations: evidence.citations,
      },
    },
  };
}

/**
 * Read the site's own tool evidence off the page this turn was answered on.
 *
 * Returns `null` — never a throw, never a partial readback — for a site with no
 * reader, a driver holding no page, or a scrape that failed. A readback that
 * cannot be trusted is indistinguishable from no readback, and both mean the
 * same thing on the wire: no call.
 */
async function readNativeEvidence(
  site: string,
  driver: unknown
): Promise<NativeToolEvidence | null> {
  const reader = NATIVE_TOOL_READERS[site];
  if (!reader) return null;
  // Same structural reach pool.ts already uses to health-check a worker: the
  // page is the driver's own, and it is only readable while the worker is held.
  const page = (driver as { page?: NativeReadablePage } | null | undefined)?.page;
  if (!page || typeof page.evaluate !== "function") return null;
  try {
    return await reader(page);
  } catch {
    return null;
  }
}

/**
 * Streaming is a property of the SURFACE, not of a site: the SSE branch below
 * is model-agnostic (any profile that clears the model gate gets the same
 * `text/event-stream` + `chat.completion.chunk` replay), so every advertised
 * model streams. `streamingMode: "replay"` is the honesty qualifier — the
 * ChatDriver reads the site's rendered answer when it stops growing, so the
 * completion is COMPLETE before the first chunk is written. Token timings are
 * cosmetic; a consumer that needs true incremental output must not infer it
 * from `streaming: true`. Omitting `streamingMode` would be the overstatement.
 */
export const MODEL_STREAMING_SUPPORTED = true;
export const MODEL_STREAMING_MODE = "replay";

/** The exact wire shape a tool call MUST take when this surface surfaces one.
 *  Declared here (not in the soft-tool layer) so the vocabulary `/v1/models`
 *  advertises and the vocabulary the answer uses cannot drift apart. */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type OpenAIToolCallMessage = {
  role: "assistant";
  content: string | null;
  tool_calls: OpenAIToolCall[];
};

export const OPENAI_TOOL_CALL_FINISH_REASON = "tool_calls";

export interface ModelCapabilityMetadata {
  /** Streaming shape, surface-level (see MODEL_STREAMING_SUPPORTED). */
  streaming: boolean;
  /** "replay" — the answer is complete before the first chunk; see above. */
  streamingMode: typeof MODEL_STREAMING_MODE;
  /** native | soft | none (see ModelToolSupport). */
  tools: ModelToolSupport;
  /** Machine status from the registry's own resolver (verified /
   *  unverified-candidate / builtin / dormant / dead-end). */
  status: ChatSurfaceStatus;
  /** Where the serving profile comes from: the builtin catalog or an
   *  installed capability package. */
  provenance: "builtin" | "packaged";
  /** The package's real verification record from metadata.json, or `false`
   *  when there is none. Never synthesised. */
  verified: RegistryVerified | false;
  /** True when this site is only driveable with a real logged-in browser. */
  requiresRealBrowser: boolean;
  /** The tool-call shape a `tools:"soft"` call will come back in. */
  toolCallShape: "openai.function_call" | null;
  /** EVERY mechanism this site can reach, strongest first. `tools` above names
   *  the best one; this names the rest, so a site that supports both a native
   *  read and a prompt-driven `tools` array is not flattened into one of them. */
  toolMechanisms: ModelToolSupport[];
  /** The vocabulary a consumer reads on a returned call to know WHICH mechanism
   *  produced it. Mirrors `ToolCallProvenance.mechanism` on the wire. */
  toolCallProvenanceField: "choices[0].ui2api.toolCall.mechanism";
}

/** Where a served profile's authority comes from — DERIVED, never typed.
 *  The default chat surface already resolves this (a builtin id is
 *  authoritative for itself, a packaged id otherwise); an explicitly
 *  allow-listed id that is NOT on the default surface is resolved from the
 *  package/profile the id actually has. */
function provenanceOf(siteId: string, onSurface: Map<string, { packaged: boolean }>): "builtin" | "packaged" {
  const entry = onSurface.get(siteId);
  if (entry) return entry.packaged ? "packaged" : "builtin";
  // Not on the default surface: only reachable through an explicit --site
  // allow-list. Ask the package dir, then the builtin catalog, in that order.
  for (const up of [2, 3]) {
    let p = fileURLToPath(new URL(".", import.meta.url));
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities", siteId), resolve(p, "src", "capabilities", siteId)]) {
      if (existsSync(resolve(root, "manifest.json"))) return "packaged";
    }
  }
  return "builtin";
}

/** Read a package's real `verified` record (metadata.json) — the same file the
 *  registry reads. `false` when absent/unreadable/not a full record. This is a
 *  re-read rather than a second STATUS resolver on purpose: only the record
 *  (not the status, which has exactly one resolver) is needed here. */
function verifiedRecordOf(siteId: string): RegistryVerified | false {
  for (const up of [2, 3]) {
    let p = fileURLToPath(new URL(".", import.meta.url));
    for (let i = 0; i < up; i++) p = dirname(p);
    for (const root of [resolve(p, "capabilities", siteId), resolve(p, "src", "capabilities", siteId)]) {
      const file = resolve(root, "metadata.json");
      if (!existsSync(file)) continue;
      try {
        const v = (JSON.parse(readFileSync(file, "utf8")) as { verified?: unknown }).verified;
        if (v && typeof v === "object") {
          const r = v as { since?: unknown; evidence?: unknown; via?: unknown; scope?: unknown };
          if (typeof r.since === "string" && typeof r.evidence === "string" && typeof r.via === "string") {
            return {
              since: r.since,
              evidence: r.evidence,
              via: r.via,
              scope: typeof r.scope === "string" ? r.scope : undefined,
            };
          }
        }
      } catch {
        return false; // malformed metadata claims nothing
      }
    }
  }
  return false;
}

/** The tool levels this daemon can actually execute for ONE site, DERIVED from
 *  the wiring rather than from a per-site table.
 *
 *  - "native" — the site is in NATIVE_TOOL_READERS, so a call can be backed by
 *    the site's own rendered invocation. This is the strongest level available,
 *    so it wins when both are possible.
 *  - "soft"   — no native reader for this site, but the prompt-driven layer is
 *    injected, so a `tools` array is honoured as an approximation.
 *  - "none"   — neither. A `tools` array is ignored, and saying so is the point.
 *
 * `siteId` is optional so a caller that has no site in hand (an audit, a test)
 * still gets an honest answer rather than an exception: with no site, no native
 * reader can apply.
 */
export function modelToolSupport(opts: Pick<OpenAIOptions, "softTools">, siteId?: string): ModelToolSupport {
  if (NATIVE_TOOL_CALL_SUPPORTED && siteId !== undefined && Object.prototype.hasOwnProperty.call(NATIVE_TOOL_READERS, siteId)) {
    return "native";
  }
  if (opts.softTools) return "soft";
  return "none";
}

/** Every mechanism a site can reach, strongest first — so a consumer that wants
 *  the FULL picture (this site can do native reads AND honour a `tools` array)
 *  is not misled by a single-value field that can only name one. */
export function modelToolMechanisms(
  opts: Pick<OpenAIOptions, "softTools">,
  siteId?: string
): ModelToolSupport[] {
  const out: ModelToolSupport[] = [];
  if (NATIVE_TOOL_CALL_SUPPORTED && siteId !== undefined && Object.prototype.hasOwnProperty.call(NATIVE_TOOL_READERS, siteId)) {
    out.push("native");
  }
  if (opts.softTools) out.push("soft");
  return out;
}

/** Build the enriched, DERIVED capability block for one served profile. */
export function modelCapabilities(
  profile: ChatSiteProfile,
  ctx: {
    toolSupport: ModelToolSupport;
    onSurface: Map<string, { packaged: boolean }>;
    /** The site id's full mechanism list. Derived, never typed; defaults to the
     *  single `toolSupport` so a caller that does not know about the richer list
     *  still gets a self-consistent block rather than an empty array. */
    toolMechanisms?: ModelToolSupport[];
  }
): ModelCapabilityMetadata {
  const soft = ctx.toolSupport !== "none";
  return {
    streaming: MODEL_STREAMING_SUPPORTED,
    streamingMode: MODEL_STREAMING_MODE,
    tools: ctx.toolSupport,
    status: chatSurfaceStatus(profile.id),
    provenance: provenanceOf(profile.id, ctx.onSurface),
    verified: verifiedRecordOf(profile.id),
    requiresRealBrowser: Boolean((profile as { realProfileOnly?: boolean }).realProfileOnly),
    toolCallShape: soft ? "openai.function_call" : null,
    toolMechanisms: ctx.toolMechanisms ?? [ctx.toolSupport],
    toolCallProvenanceField: "choices[0].ui2api.toolCall.mechanism",
  };
}



// ─────────────────────────────────────────────────────────────────────────────
// USAGE ACCOUNTING — an ESTIMATE, ALWAYS LABELLED AS ONE
//
// `response.usage` used to be absent on both paths, and a missing usage object
// is not a neutral omission: openai-python's accounting, LangChain's cost
// middleware and every budget tracker treat it as a broken provider, and
// `stream_options:{include_usage:true}` was read and then ignored. A field that
// is `None` where a client needs a number is a crash or a mis-bill, so a real
// object is emitted here instead.
//
// WHAT THE NUMBER IS, precisely: a character-based estimate over OUR OWN text —
// the prompt string this surface typed into the site's composer, and the answer
// string this surface read back off the page. It is NOT the site's backend
// tokenization and it is NOT the provider's billable count. The site's own
// tokenizer is never exposed to us (there is no endpoint that reports it), so
// there is no honest way to produce its number, and producing a number that
// merely LOOKS like one is exactly the fabrication this surface exists to
// avoid. It is therefore an estimate, on a field a billing system can read but
// never mistake for a measurement, because `estimated: true` and
// `siteReported: false` sit right next to it — and, on the streaming path, in
// the same object.
//
// The ratio is 4 characters per token, the widely used English-text heuristic.
// It is chosen for being roughly right on prose, not for being exact: an
// estimate labelled as an estimate is usable for a budget guard, while a
// missing field is not.
// ─────────────────────────────────────────────────────────────────────────────

/** The OpenAI usage block. Field names and nesting are the protocol's own, so a
 *  client reads it without knowing anything about ui2api. */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/** The label that travels WITH the estimate. A consumer that wants a bill must
 *  read this; a consumer that wants a number gets the number. */
export interface UsageAccounting {
  /** Always true. There is no path here that produces a measured count. */
  estimated: true;
  /** The concrete method, so the number is auditable rather than magic. */
  method: "ui2api-char-estimate";
  /** What was measured, in words. */
  basis: "characters/4 over ui2api's own prompt and answer text";
  /** Always false: the site's backend tokenization is never available here. */
  siteReported: false;
  note: string;
}

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil((text ?? "").length / CHARS_PER_TOKEN);
}

/** Build the usage block + its label from the exact two strings this request
 *  really involved: the prompt the site received, and the answer the caller
 *  receives. Passing anything else would make the accounting describe a
 *  conversation that did not happen. */
export function estimateUsage(promptText: string, completionText: string): { usage: OpenAIUsage; usageAccounting: UsageAccounting } {
  const prompt_tokens = estimateTokens(promptText);
  const completion_tokens = estimateTokens(completionText);
  return {
    usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
    usageAccounting: {
      estimated: true,
      method: "ui2api-char-estimate",
      basis: "characters/4 over ui2api's own prompt and answer text",
      siteReported: false,
      note:
        "Estimated by ui2api from the text it sent and read. This is NOT the site's own " +
        "backend tokenization and must not be treated as a billable provider count.",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARAMETER HONESTY — the ignored set, as DATA the response is built from
//
// Listed once, used twice: the comment at the top of the file explains WHY, and
// this array is what actually names them on the wire, so the two cannot drift
// into "documented but not reported" (which is the silent drop this replaces).
//
// Not a capability table — it says nothing about any model, only about this
// surface's own seam to the site.
// ─────────────────────────────────────────────────────────────────────────────

/** OpenAI sampling/generation parameters this surface cannot honour, because
 *  the site is driven through its own composer and exposes no sampling API. */
export const IGNORED_REQUEST_PARAMETERS: readonly string[] = [
  "temperature",
  "top_p",
  "seed",
  "stop",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logprobs",
  "top_k",
  "logit_bias",
  "response_format",
];

/** Which of the ignored parameters this caller ACTUALLY sent — the ones a
 *  consumer can act on. A caller that sent nothing gets an empty list, so the
 *  field is not noise on every response. Presence in the request is the test,
 *  not truthiness of the value: `temperature: 0` and `max_tokens: 0` are both
 *  attempts to tune and both did nothing. */
export function ignoredParametersOf(body: Record<string, unknown>): string[] {
  return IGNORED_REQUEST_PARAMETERS.filter((name) => Object.prototype.hasOwnProperty.call(body, name));
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  // GOAL 83: answer at most once. The daemon's aggregate deadline answers an
  // over-deadline /v1 request with a named 504 while this route's browser work
  // is still in flight; when that work finally settles, this guard makes the
  // late answer a no-op instead of a second write on a finished response. The
  // happy-path bytes are unchanged.
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  } catch {
    // socket already gone (client hung up / shutdown destroyed it)
  }
}

// profilesById is the daemon's configured allow-list; a site that is not
// configured here is refused (origin pinning — see src/runtime/ssrf.ts).
function profileById(id: string, profilesById: Record<string, ChatSiteProfile>): ChatSiteProfile {
  const p = profilesById[id];
  if (p) return p;
  throw new Error(`unknown site "${id}" — try one of ${Object.keys(profilesById).join(", ")}`);
}

/** Percent-decode a path segment without letting a malformed escape throw out
 *  of the route: a client sending a stray `%` gets the raw segment (and then a
 *  named 404), not a stack trace and a dropped connection. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function siteIdFromModel(model: unknown, fallback: string): string {
  let m = typeof model === "string" && model ? model : fallback;
  if (m.startsWith(PREFIX)) m = m.slice(PREFIX.length);
  // accept ui2api-deepseek style too (executor convenience)
  if (m.startsWith("ui2api-")) m = m.slice("ui2api-".length);
  return m;
}
export { siteIdFromModel };

/** A request carried content parts this surface cannot honour (image_url,
 *  input_image, file, …). Carries the kinds so the 400 can NAME them. */
export class ContentPartUnsupported extends Error {
  constructor(readonly kinds: string[]) {
    super(
      `unsupported content part${kinds.length === 1 ? "" : "s"}: ${kinds.join(", ")}. ` +
        `This surface sends text through each site's own composer, and an image ` +
        `cannot be typed — the site has a real file-upload UI for that, and it is ` +
        `reached on /capability/<site> today. Silently dropping the part would ` +
        `return a real answer to a question that was never actually asked, so it ` +
        `is refused instead.`
    );
    this.name = "ContentPartUnsupported";
  }
}

function messagesToPrompt(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const parts: string[] = [];
  for (const m of messages) {
    const role = typeof (m as { role?: unknown })?.role === "string" ? (m as { role: string }).role : "user";
    let content = "";
    const raw = (m as { content?: unknown })?.content;
    if (typeof raw === "string") content = raw;
    else if (Array.isArray(raw)) {
      // ROUND N+106 — image and file parts used to be SILENTLY DROPPED. An agent
      // that sent a picture got a text-only prompt, a real answer, and no
      // indication that the picture had never been seen. That is the worst class
      // of failure this project has: not an error, just a confidently wrong
      // answer, and the caller has no way to detect it.
      //
      // So the part is now NAMED and refused. A caller learns immediately that
      // this surface does not take images, which is a fact it can act on, instead
      // of discovering it from a wrong answer three turns later.
      //
      // Vision is not merely unimplemented on the sites: many of them have a real
      // file-upload UI in their composer, driven exactly the way a human would.
      // That path exists on /capability/<site> and is being wired into /v1
      // properly — by uploading through the site's own UI, never by inventing a
      // wire payload. Until it lands, this refusal is the honest state.
      const nonText = raw.filter(
        (p) => typeof (p as { type?: unknown })?.type === "string"
          && (p as { type: string }).type !== "text"
          && (p as { type: string }).type !== "input_text"
      );
      if (nonText.length > 0) {
        const kinds = [...new Set(nonText.map((p) => String((p as { type: string }).type)))];
        throw new ContentPartUnsupported(kinds);
      }
      content = raw
        .filter((p) => typeof (p as { type?: unknown })?.type === "string" && ((p as { type: string }).type === "text" || (p as { type: string }).type === "input_text"))
        .map((p) => String((p as { text?: unknown })?.text ?? ""))
        .join("\n");
    }
    if (!content.trim()) continue;
    // ROUND N+103 — the tool round trip used to arrive UNLABELLED. The flattener
    // pushed only `content`, so a `role:"tool"` result reached the model as bare
    // text, indistinguishable from something the user had just said, and
    // `tool_call_id` was dropped entirely. That defeats the purpose of the field:
    // OpenAI's format carries the role and the id PRECISELY so the model can tell
    // what it asked for from what it got back. Without them, a tool result is
    // just an unattributed paragraph, and the model has to guess.
    //
    // The label is explicit rather than implicit. A consumer reading a flattened
    // transcript should be able to reconstruct the roles, and a model reading one
    // should be told the difference between its own prior turn, a user
    // instruction, and an observation returned on its request.
    const tcid = (m as { tool_call_id?: unknown }).tool_call_id;
    if (role === "tool" || role === "function") {
      const id = typeof tcid === "string" && tcid ? ` (tool_call_id: ${tcid})` : "";
      parts.push(`[tool result${id}]: ${content.trim()}`);
    } else if (role === "assistant") {
      parts.push(`[assistant]: ${content.trim()}`);
    } else if (role === "system" || role === "developer") {
      // A system/developer turn is an INSTRUCTION, and it must not read as
      // something the user typed — an agent's system prompt is the most
      // authority-bearing text in the transcript.
      parts.push(`[system instruction]: ${content.trim()}`);
    } else {
      parts.push(content.trim());
    }
  }
  return parts.join("\n");
}
export { messagesToPrompt };

export async function handleOpenAIRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  opts: OpenAIOptions
): Promise<void> {
  const { pool, profilesById } = opts;
  const url = req.url ?? "";
  // A query string on a client-library call is ordinary (`?v=1`, cache busters),
  // and refusing it would be a pointless 404. The PATH is what routes; the raw
  // url is still what the terminal 404 quotes back, so a mistake stays visible.
  const path = url.split("?")[0].split("#")[0];

  // GET /v1/models — the chat sites this daemon can serve, each with the
  // DERIVED capability metadata a consumer needs to materialise a provider
  // without discovering the facts by failing. See the CAPABILITY METADATA block
  // above for what each field is derived from and what is deliberately absent
  // (context_window: this repo has no measured per-site value, so the field is
  // OMITTED rather than invented — a made-up context window is a number a
  // consumer would size real requests against).
  //
  // GET /v1/models/<id> is the SAME entry, and it exists because client
  // libraries call it as a matter of course (openai-python's
  // `client.models.retrieve`, the VS Code / Continue model pickers, several
  // routers' health checks). A 404 there reads to those callers as "this
  // provider does not know its own models", and they drop the provider. Both
  // routes therefore build the entry through ONE function, so a single-model
  // answer can never be a differently-shaped or differently-honest version of
  // the list entry.
  if (req.method === "GET" && (path === "/v1/models" || path.startsWith("/v1/models/"))) {
    const onSurface = new Map(defaultChatSurface().map((e) => [e.id, { packaged: e.packaged }]));
    // GOAL 159: /v1/models is a PROMISE surface — a consumer materialises one
    // provider per id it finds here. It is therefore gated on the measured
    // record (class ANSWERS), not on the addressable surface alone: an id whose
    // selectors parse but which no live round trip ever answered is not
    // advertised. The full catalogue stays reachable on /registry, /sites and
    // /capability/<id>, and the honest split travels with this response so a
    // consumer can tell "offers 4" from "hides 18".
    const verification = readModelVerification();
    if (verification.refusal !== null) {
      return sendJson(res, 503, {
        error: {
          message: verification.refusal,
          type: "service_unavailable",
          code: "model_verification_unreadable",
        },
      });
    }
    const offered = new Set(answerableChatSurface(verification).map((e) => e.id));
    const entryFor = (p: ChatSiteProfile) => ({
      id: p.id,
      object: "model",
      created: 0,
      owned_by: "ui2api",
      permission: [],
      root: p.id,
      parent: null,
      site: p.name,
      url: p.url,
      loginRequired: p.loginRequired ?? false,
      // …and the capability block, spread at the TOP level of the entry so a
      // consumer reads `m.tools` / `m.status` without unwrapping a sub-object
      // whose shape it would have to guess. `tools` is resolved PER SITE: the
      // native level is a property of whether this site has a measured reader
      // (NATIVE_TOOL_READERS), not of the daemon, so kimi and deepseek can
      // honestly differ on the same running daemon.
      ...modelCapabilities(p, {
        toolSupport: modelToolSupport(opts, p.id),
        toolMechanisms: modelToolMechanisms(opts, p.id),
        onSurface,
      }),
    });
    const single = path.slice("/v1/models".length).replace(/^\//, "");
    if (single) {
      // A nested path is a different endpoint, not a model id: answering
      // /v1/models/a/b with a's entry would be a lie about what was asked.
      const first = single.split("/")[0];
      const id = siteIdFromModel(safeDecode(first), "");
      const profile = profilesById[id];
      const withheld = withheldChatModels(verification).find((w) => w.model === id);
      if (profile && !offered.has(id) && withheld) {
        return sendJson(res, 404, {
          error: {
            message: `the model \`${single}\` is not advertised: ${withheld.reason}. Its package is still on /registry, /sites and POST /capability/${id}. GET /v1/models lists only the models this daemon has measured as answering.`,
            type: "invalid_request_error",
            code: "model_withheld",
            param: "id",
            withheldClass: withheld.class,
          },
        });
      }
      if (!profile || single.includes("/")) {
        return sendJson(res, 404, {
          error: {
            message: `the model \`${single}\` does not exist; GET /v1/models lists every model this daemon serves`,
            type: "invalid_request_error",
            code: "model_not_found",
            param: "id",
          },
        });
      }
      return sendJson(res, 200, { ...entryFor(profile), capabilitiesVersion: MODEL_CAPABILITIES_VERSION });
    }
    const data = Object.values(profilesById)
      .filter((p) => offered.has(p.id))
      .map(entryFor);
    return sendJson(res, 200, {
      object: "list",
      capabilitiesVersion: MODEL_CAPABILITIES_VERSION,
      // The honest count, not a hidden one: how many are offered, how many of
      // the addressable catalogue are withheld, and under which measured class.
      advertisement: modelAdvertisementSummary(verification, Object.keys(profilesById)),
      withheld: withheldChatModels(verification).filter((w) => w.model in profilesById),
      data,
    });
  }

  if (req.method === "POST" && url === "/v1/chat/completions") {
    let body: Record<string, unknown>;
    try {
      body = (await readJsonBody(req)) as Record<string, unknown>;
    } catch {
      // The SAME sentence the thrower used (INVALID_JSON_MESSAGE, owned by
      // consumer-surface.ts). This used to re-type the words, which made one
      // caller mistake answerable in two ways on one daemon — see the owner.
      return openAiError2(res, 400, INVALID_JSON_MESSAGE);
    }
    const stream = Boolean(body.stream);
    // `stream_options.include_usage` was accepted and dropped. It is the one
    // generation option this surface CAN honour honestly, because the estimate
    // it asks for is over our own text and is emitted either way (see
    // estimateUsage) — the flag only decides whether the streaming path carries
    // it, which is the OpenAI convention.
    const streamOptions = (body.stream_options ?? null) as { include_usage?: unknown } | null;
    const includeUsage = Boolean(streamOptions && typeof streamOptions === "object" && streamOptions.include_usage === true);
    const ignoredParams = ignoredParametersOf(body);
    const modelRaw = body.model;
    const site = siteIdFromModel(modelRaw, "");
    let profile: ChatSiteProfile;
    try {
      profile = profileById(site, profilesById);
    } catch (e) {
      return sendJson(res, 404, {
        error: {
          message: e instanceof Error ? e.message : `unknown model "${modelRaw}"`,
          type: "invalid_request_error",
          code: "unknown_model",
          param: "model",
        },
      });
    }
    let prompt: string;
    try {
      prompt = messagesToPrompt(body.messages);
    } catch (e) {
      // A caller's mistake keeps its NAMED 4xx and its own message — OpenAI
      // clients parse this shape, so an agent can branch on it programmatically
      // instead of parsing prose. A 500 here would tell the caller nothing except
      // that something went wrong somewhere, which is the same deception as the
      // silent drop this replaced.
      if (e instanceof ContentPartUnsupported) {
        return sendJson(res, 400, {
          error: {
            message: e.message,
            type: "invalid_request_error",
            param: "messages[].content",
            code: "unsupported_content_part",
          },
        });
      }
      throw e;
    }
    // ROUND N+103 — the SOFT tool layer, wired here and nowhere else.
    //
    // This is deliberately the ONLY place the instruction is injected, and it is
    // injected into the PROMPT rather than into any wire payload: the site's own
    // JavaScript receives it, types it, and sends it exactly as a human's prompt
    // would. Nothing is forged, no internal API is called, and there is no
    // request shape here that a person clicking in the composer could not
    // produce. That is what keeps it ban-safe — the failure mode this project
    // cannot accept is a tool-calling implementation that gets an account
    // banned for traffic the site never saw a human generate.
    //
    // HONESTY, and it is the point of the whole exercise: the model has NOT run
    // the function. The caller receives a tool call, executes it themselves, and
    // sends the result back as a `role:"tool"` message. If the model ignores the
    // instruction we get `null` and the answer falls through untouched — we
    // never invent a function name to fill the gap.
    const softTools = opts.softTools;
    const requestedTools = Array.isArray(body.tools) ? body.tools : undefined;
    const toolInstruction =
      softTools && requestedTools && requestedTools.length > 0
        ? softTools.buildToolInstruction(requestedTools)
        : "";
    if (toolInstruction) prompt = `${prompt}\n\n${toolInstruction}`;
    if (!prompt.trim()) {
      return sendJson(res, 400, {
        error: { message: "messages must contain at least one non-empty text part", type: "invalid_request_error", param: "messages" },
      });
    }
    // ROUND N+103 — the OpenAI surface was NEVER starting a fresh conversation.
    //
    // It read `body.new_chat`, a ui2api-specific field that does not exist in the
    // OpenAI wire format, so for every standards-compliant request this was
    // `false` and the reset never ran. The driver then composed into whatever
    // page the warm pool had handed back — a page still holding the PREVIOUS
    // request's conversation. Measured: a request that had nothing to do with the
    // weather came back with `"title":"Weather in Paris"`, the prior
    // conversation's title, sitting in the response body.
    //
    // Why this matters more than a dirty title: the /v1 surface flattens the
    // whole `messages` array into ONE prompt, so the request is self-contained
    // and the site's own history is a SECOND, invisible source of truth. Two
    // sources of truth, one of them the previous caller's conversation, is how an
    // agent gets an answer that belongs to somebody else — silently, and with a
    // confident-looking answer attached.
    //
    // So the default flips: a standards-compliant request ALWAYS starts a fresh
    // chat, because the caller has just told us the entire conversation in
    // `messages`. `new_chat:false` remains available to opt out and keep a
    // warm page, for a caller that genuinely wants site-side continuity.
    const newChat = body.new_chat === undefined ? true : Boolean(body.new_chat);
    const account = typeof body.account === "string" && body.account ? body.account : undefined;
    // Validate the identity-keyed account BEFORE any browser work (the same
    // guard /prompt runs): unknown -> the throw propagates to the server catch
    // for a 400, never a silent fallback to the legacy default session.
    opts.validateAccount?.(account, profile);
    const worker = await pool.acquire(profile.id, account);
    try {
      const result = await worker.driver.ask(prompt, { newChat });
      // ── NATIVE READ-BACK, and the ORDER matters ──────────────────────────────
      //
      // It runs HERE, after the answer settled and BEFORE the worker is released,
      // because the evidence is DOM the SITE rendered onto the driver's own page.
      // Releasing first would hand that page to the next request, and the read
      // would race another conversation's markup — a readback that returned
      // another turn's citations is precisely the fabrication this must not ship.
      //
      // It is also skipped for a restriction wall: a paywall/limit/login page is
      // not a tool invocation, and scraping it for "evidence" would only find
      // the wall's own DOM.
      const native =
        NATIVE_TOOL_CALL_SUPPORTED && result.doneReason !== "restricted"
          ? await readNativeEvidence(profile.id, worker.driver)
          : null;
      await pool.release(worker);
      // Parse the reply BEFORE it is rendered. On a hit the scaffolding is
      // stripped so the caller never sees the JSON envelope we asked for, and the
      // message carries a real `tool_calls` array plus finish_reason "tool_calls".
      // On a miss (`null`) the answer is returned verbatim — an ordinary reply.
      // The `softTools` seam is structural and its `parseToolCall` is typed
      // `unknown` on purpose, so the layer cannot break this file's build while
      // absent. Narrow it HERE, at the one place a value is produced, and fail
      // closed: anything that is not a well-formed call is treated as NO call,
      // which sends the answer through untouched rather than emitting a
      // `tool_calls` array built from a shape nobody validated.
      // ROUND N+106 — CONSENT-GATED, and this is the decision that stops the soft
      // path fabricating. The audit measured it returning a well-formed
      // `tool_calls` entry whose arguments came from the PROMPT rather than from
      // a model decision, with controls producing nothing. The parser can
      // validate that an answer CONTAINS a tool-shaped envelope; it cannot
      // validate that the MODEL chose it, because that information does not
      // survive into rendered text. A consumer would execute a function the
      // model never asked for — the same class as the silently dropped image and
      // the empty-snapshot overwrite: not an error, a plausible result that is
      // false.
      //
      // So a soft call is surfaced ONLY when the caller has explicitly opted in
      // with `tool_choice: "auto"`. Any other value — absent, "none",
      // "required", an object — and the layer does not run, the answer is
      // returned untouched, and nothing invented. The default is therefore
      // fail-CLOSED: an agent that sends `tools` and nothing else gets a normal
      // answer, never a call it did not ask for.
      const toolChoice = body.tool_choice;
      const softConsent = toolChoice === "auto" || (toolChoice !== null && typeof toolChoice === "object");
      const narrowed = (
        softTools && requestedTools && requestedTools.length > 0 && softConsent
          ? softTools.parseToolCall(result.answer ?? "", requestedTools)
          : null
      ) as {
        toolCallId?: unknown;
        name?: unknown;
        argumentsJson?: unknown;
      } | null;
      const parsedCall =
        narrowed &&
        typeof narrowed.toolCallId === "string" &&
        typeof narrowed.name === "string" &&
        typeof narrowed.argumentsJson === "string"
          ? {
              toolCallId: narrowed.toolCallId,
              name: narrowed.name,
              argumentsJson: narrowed.argumentsJson,
            }
          : null;
      // ── WHICH MECHANISM PRODUCED THE CALL ───────────────────────────────────
      //
      // A native invocation OUTRANKS a soft one, and the soft one is suppressed
      // rather than dropped silently: the site really ran a tool, so reporting a
      // prompt-driven approximation as the answer's call would understate what
      // happened and hand the caller the weaker evidence. The suppression is
      // recorded in `suppressedSoft` so nothing is hidden.
      //
      // The two can never be conflated in the other direction, which is the one
      // that matters: a soft hit NEVER becomes native. `buildNativeToolCall` is
      // the only producer of a native call and it takes site evidence alone.
      const built = buildNativeToolCall(native, profile.id);
      const toolCall: OpenAIToolCall | null = built
        ? built.call
        : parsedCall
          ? {
              id: parsedCall.toolCallId,
              type: "function" as const,
              function: { name: parsedCall.name, arguments: parsedCall.argumentsJson },
            }
          : null;
      const provenance: ToolCallProvenance | null = built
        ? { ...built.provenance, suppressedSoft: parsedCall !== null }
        : parsedCall
          ? {
              mechanism: "soft-prompt",
              executed: false,
              site: profile.id,
              tool: null,
              evidence: null,
              suppressedSoft: false,
            }
          : null;
      // The scaffolding is stripped when EITHER mechanism claimed the turn: a
      // caller told "run this function" must not also receive the prompt
      // envelope as if it were the model's answer.
      const answer =
        toolCall !== null ? (softTools?.stripToolCall(result.answer ?? "").content ?? "") : (result.answer ?? "");
      // The accounting is built from the two strings this request really
      // involved: the prompt the SITE received (the flattened messages plus any
      // tool instruction — not the caller's pre-flattening transcript) and the
      // answer the CALLER receives. It is an estimate over our own text, and it
      // is labelled as one on the wire (see estimateUsage).
      const { usage, usageAccounting } = estimateUsage(prompt, answer);
      const id = `chatcmpl-ui2api-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const created = Math.floor(Date.now() / 1000);
      if (stream) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        // The OpenAI streaming convention for usage: a final chunk whose `choices`
        // is EMPTY and which carries only `usage`, written after the terminal
        // frame and immediately before the stream's terminator sentinel. Emitted
        // only when the caller asked for it with `stream_options.include_usage`,
        // so a consumer that does not read usage is not handed a frame its
        // parser has no rule for. Every streaming exit (wall / tool call /
        // answer) ends through it, so no path can quietly drop the accounting
        // the caller asked for.
        const usageFrame = () =>
          chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [], usage, ui2api: { usageAccounting } });
        // GOAL 109: a restriction wall (paywall / limit / login) is NOT an empty
        // success. The OpenAI protocol has the right vocabulary for it —
        // finish_reason "content_filter" plus a `refusal` string — so use it
        // rather than inventing a status. The named hits stay visible.
        if (result.doneReason === "restricted") {
          const detail = (result.restrictions ?? []).map((r) => `${r.kind}: ${r.matched}`).join("; ") || "restriction wall detected";
          chunk({
            id, object: "chat.completion.chunk", created, model: profile.id,
            choices: [{ index: 0, delta: { refusal: detail }, finish_reason: "content_filter" }],
            ui2api: { site: profile.id, doneReason: "restricted", restrictions: result.restrictions ?? [] },
          });
          if (includeUsage) usageFrame();
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        if (toolCall) {
          // A tool call replaces the content replay: the caller is not being sent
          // prose, it is being told which function to run. Sending both would let
          // a consumer treat the instruction scaffolding as the model's answer.
          //
          // The SAME bytes are used for both mechanisms — the OpenAI wire has one
          // shape for a call. What tells them apart travels on the FINAL chunk,
          // in `choices[0].ui2api.toolCall`, because that is the one frame a
          // consumer is guaranteed to read (it carries finish_reason) and the one
          // a streaming SDK has finished accumulating when it yields the result.
          chunk({
            id,
            object: "chat.completion.chunk",
            created,
            model: profile.id,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: toolCall.id,
                      type: "function" as const,
                      function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          chunk({
            id,
            object: "chat.completion.chunk",
            created,
            model: profile.id,
            choices: [{ index: 0, delta: {}, finish_reason: OPENAI_TOOL_CALL_FINISH_REASON, ui2api: { toolCall: provenance } }],
          });
          if (includeUsage) usageFrame();
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        // replay the completed answer as incremental chunks
        for (let i = 0; i < answer.length; i += 8) {
          chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: { content: answer.slice(i, i + 8) }, finish_reason: null }] });
        }
        chunk({ id, object: "chat.completion.chunk", created, model: profile.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        if (includeUsage) usageFrame();
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      return sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: profile.id,
        choices: [
          {
            index: 0,
            // GOAL 109: never "stop" + empty content for a restriction wall.
            message: {
              role: "assistant",
              // `null` whenever the message carries `tool_calls`, which is the
              // OpenAI protocol's own convention and the reason a consumer that
              // renders `content` can be trusted: a tool turn has no prose answer,
              // and what this surface would otherwise hand it is the residue of
              // the instruction WE wrote into the prompt (or the site's own
              // "calling the tool" prose) — rendered as if the model had said it.
              //
              // The reason it is null and not the stripped residue is that the
              // two are indistinguishable to the reader: a client that prints
              // `content` would display our scaffolding as the model's answer.
              // The residue is still available where it is honest — it stays in
              // the call's own arguments when the site produced them.
              content: toolCall ? null : answer,
              // Present ONLY when a call was actually produced, so a consumer can
              // branch on the key's existence rather than on a magic empty value.
              // There is no such thing as an empty tool_calls array here: with no
              // call there is no key at all, and an unobserved native turn is
              // exactly that case.
              ...(toolCall ? { tool_calls: [toolCall] } : {}),
              refusal:
                result.doneReason === "restricted"
                  ? (result.restrictions ?? []).map((r) => `${r.kind}: ${r.matched}`).join("; ") || "restriction wall detected"
                  : null,
            },
            // `tool_calls` here is NOT a ui2api invention — it is the OpenAI
            // protocol's own value, and a consumer that ignores our provenance
            // field still gets a spec-correct finish_reason. (The SOFT path was
            // previously reporting "stop" here while carrying tool_calls, which
            // is a protocol error: OpenAI requires "tool_calls" whenever the
            // message carries the key. A strict SDK reconciles the stream and
            // can end up with a message holding calls and a "stop" reason.)
            finish_reason: result.doneReason === "restricted" ? "content_filter" : toolCall ? OPENAI_TOOL_CALL_FINISH_REASON : "stop",
            logprobs: null,
            // THE VOCABULARY. A consumer reads this one field to know whether the
            // site really ran a tool or the model was merely asked to pretend:
            //   mechanism:"native"      → executed:true,  arguments are the site's
            //                              own rendered evidence (real citations)
            //   mechanism:"soft-prompt" → executed:false, nothing ran, the CALLER
            //                              runs the function
            // It sits on the CHOICE, next to the call it describes, so it cannot
            // be missed by a consumer that only looks at `choices[0]`. Absent
            // entirely when no call was made.
            ...(provenance ? { ui2api: { toolCall: provenance } } : {}),
          },
        ],
        // A real usage object on the non-streaming path, ALWAYS. It used to be
        // absent, and absent is not neutral: openai-python's accounting, cost
        // middleware and budget trackers all read this field, and a missing one
        // is a crash or a mis-bill rather than a zero. `usageAccounting` sits
        // next to it so the number is never mistaken for the site's own billing.
        usage,
        ui2api: {
          site: profile.id,
          usageAccounting,
          chunkCount: result.chunkCount ?? 0,
          doneReason: result.doneReason ?? "stop",
          url: result.url ?? undefined,
          title: result.title ?? undefined,
          // Which request parameters the caller sent that this surface did NOT
          // honour, by name. A silently ignored `temperature` is worse than a
          // rejected one: the caller tunes it, believes it worked, and never
          // learns otherwise. Naming them here makes the ignore VISIBLE, and
          // `reason` says why in one line so nobody has to read this file to
          // find out. Omitted entirely when the caller sent none of them, so a
          // clean request carries no noise.
          ...(ignoredParams.length > 0
            ? {
                parameters: {
                  ignored: ignoredParams,
                  reason:
                    "This surface types the prompt into the site's own composer and reads the rendered " +
                    "answer back, so it has no sampling API to pass these to: they were received and had " +
                    "no effect on this answer. Truncating the finished answer to fake 'stop' or " +
                    "'max_tokens' was rejected because the result would be indistinguishable from a " +
                    "model that genuinely stopped there.",
                },
              }
            : {}),
          // Why a native read-back produced nothing, when this site has a reader
          // at all. This is the field that makes a MISSING call diagnosable: the
          // overwhelmingly common real answer is "the site did not run the tool
          // on this turn", and without a reason that is indistinguishable from a
          // broken reader.
          ...(NATIVE_TOOL_READERS[profile.id]
            ? {
                nativeTool: {
                  site: profile.id,
                  attempted: NATIVE_TOOL_CALL_SUPPORTED && result.doneReason !== "restricted",
                  observed: native?.observed === true,
                  reason: native?.reason ?? (result.doneReason === "restricted" ? "skipped: restriction wall" : native === null ? "no readable page for this turn" : null),
                },
              }
            : {}),
        },
      });
    } catch (e) {
      await pool.release(worker).catch(() => undefined);
      return sendJson(res, 502, {
        error: {
          message: redactInternalError(e, { site, account: typeof body.account === "string" ? body.account : undefined }),
          type: "server_error",
          code: "ui2api_driver_error",
          param: null,
        },
      });
    }
  }

  // Terminal fallback — NO /v1/* request may leave this handler without a
  // response. An unmatched path (any /v1/embeddings, /v1/completions, a wrong
  // method on /v1/chat/completions, …) used to fall through the whole function
  // and hang the connection forever: nothing ever wrote to res. Answer a named
  // 404 instead (the marketplace-class hang the user hit once — "the last
  // ocmmand you did stucked"). The native non-/v1 404 at http.ts stays the
  // fallback for paths outside the /v1 prefix.
  return sendJson(res, 404, {
    error: {
      message: `unknown endpoint ${req.method ?? "?"} ${url}; ui2api serves GET /v1/models and POST /v1/chat/completions`,
      type: "invalid_request_error",
      code: "not_found",
      param: null,
    },
  });
}

// --- helpers ----------------------------------------------------------------

function openAiError2(res: ServerResponse, status: number, message: string, code?: string): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code, param: null } });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}