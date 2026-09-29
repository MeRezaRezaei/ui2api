/**
 * SOFT TOOL CALLING — a prompt-driven FALLBACK, not real tool calling.
 * ============================================================================
 *
 * WHAT THIS IS
 * ------------
 * A chat site driven through its own UI gives us text, not a `tool_calls`
 * array. When a caller sends OpenAI-style `tools`, this module asks the model
 * — through the ordinary chat path, on the real site — to reply with a single
 * strict JSON object naming one function and its arguments, parses that object,
 * and hands it back shaped like an OpenAI tool call so a caller can execute it
 * and return the result as a `role:"tool"` message.
 *
 * WHAT THIS IS NOT — read this before trusting any result
 * ------------------------------------------------------
 * 1. THE FUNCTION HAS NOT RUN. Nothing in this file executes anything. The
 *    model did not call your function; it *wrote down* the name of your
 *    function. Execution, and its failure modes, belong entirely to the
 *    caller. A caller that believes a tool ran when it did not is worse than
 *    having no tool support at all, so every parse result is stamped
 *    `executed: false` and `soft: true` (see `SoftToolCall`), and those fields
 *    are non-optional in the type: you cannot hold one of these without being
 *    able to see that it has not been executed.
 * 2. IT COSTS A TURN. The chat round-trip is spent emitting JSON instead of
 *    answering. A tool-calling turn and a normal answer turn are not
 *    interchangeable.
 * 3. IT DEPENDS ON THE MODEL COMPLYING. Models wrap JSON in fences, prefix it
 *    with prose, trail commas, or ignore the instruction entirely. When the
 *    model does not comply, `parseToolCall` returns `null`. That `null` is the
 *    honest answer and MUST be surfaced as "no tool call" — never patched over
 *    with a guessed function name or empty arguments.
 *
 * WHAT IT MUST NOT BE USED FOR
 * ----------------------------
 * - Anything IRREVERSIBLE or outward-facing (sending mail, posting, paying,
 *   deleting) on the strength of the parse alone. The parse is a *request*
 *   from a model that was asked in prose to behave like a function caller; it
 *   carries no stronger claim than "a language model said these words".
 * - Side effects the caller will not re-verify. There is no confirmation
 *   round-trip here; the site's real action happens later, on the caller's
 *   own execution path, and must be read back the way every other outward
 *   action in this project is.
 * - Security boundaries. A model that ignored the instruction can name
 *   anything; the only defence here is that `parseToolCall` REJECTS any
 *   function name the caller did not actually offer. That is a filter against
 *   invention, not an authorisation system — an offered-but-dangerous function
 *   is still offered.
 * - Anything needing exact, typed, guaranteed arguments. The arguments came
 *   from a text completion; they are a best effort, not a validated call.
 *
 * A site whose real wire protocol supports tool calls (and where a capture
 * shows the site itself emitting the function call) is served by that real
 * path. This module is the fallback for sites that do not have one.
 *
 * See `test/soft-tool-calling.test.ts` for the mutation reds that hold each of
 * the three load-bearing behaviours (fence parsing, name validation, stripping).
 */

/** A JSON-Schema-ish parameter description, as OpenAI-style `tools[]` carries it. */
export interface ToolParameters {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

/**
 * One entry of an OpenAI-style `tools` array. Only `function.name` is load
 * bearing here; `description` and `parameters` are echoed into the instruction
 * so the model knows what shape of arguments to produce.
 */
export interface ToolSpec {
  type?: "function" | string;
  function: {
    name: string;
    description?: string;
    parameters?: ToolParameters;
  };
  [k: string]: unknown;
}

/**
 * A parsed — but NOT EXECUTED — tool call.
 *
 * The name is qualified on purpose. `ToolCall` alone would let the next reader
 * assume a function ran. `executed` is typed as the literal `false` so it
 * cannot be assigned `true` by accident while the value stays a boolean, and
 * `soft: true` / `mechanism` say the same thing in words a human reads.
 */
export interface SoftToolCall {
  /** OpenAI-shaped correlation id; echo it back on the `role:"tool"` message. */
  readonly toolCallId: string;
  /** The offered function the model named. Validated against `ToolSpec[]`. */
  readonly name: string;
  /** Parsed arguments. Always a plain object — never a partial parse. */
  readonly arguments: Record<string, unknown>;
  /** The same arguments as the JSON string OpenAI's wire format carries. */
  readonly argumentsJson: string;
  /** NOT AN OpenAI `ToolCall` — the type name is qualified deliberately. */
  readonly type: "function";
  /** Always `true`. This call was produced by asking the model in prose. */
  readonly soft: true;
  /** The function has NOT been executed. This literal type makes that unmissable. */
  readonly executed: false;
  /** How the call was obtained. "soft-prompt" is the only value that exists. */
  readonly mechanism: "soft-prompt";
}

/** Alias kept because the contract in the task named this type. Same shape. */
export type ParsedToolCall = SoftToolCall;

/** Hard cap on the reply we are willing to scan, so a runaway page cannot stall us. */
const MAX_SCAN_CHARS = 200_000;

/** Keys a model plausibly uses for the function name, in preference order. */
const NAME_KEYS = ["name", "function", "tool", "tool_name", "recipient_name"] as const;

/** Keys a model plausibly uses for the arguments, in preference order. */
const ARG_KEYS = ["arguments", "args", "parameters", "input", "kwargs", "params"] as const;

// ---------------------------------------------------------------- instruction --

/**
 * Build the instruction block to append to the outgoing messages when the
 * caller requested tools.
 *
 * Returns `""` for an empty/absent tool list — an empty instruction is worse
 * than none, because it tells the model a format is expected and then never
 * describes it. The caller should append this text only when it is non-empty.
 *
 * The block is a plain-text contract: the model must answer with ONE JSON
 * object and nothing else, and must choose a function the caller offered.
 */
export function buildToolInstruction(tools: ToolSpec[]): string {
  if (!Array.isArray(tools) || tools.length === 0) return "";
  const offered = tools
    .filter((t): t is ToolSpec => !!t && typeof t === "object" && typeof t.function?.name === "string" && t.function.name.length > 0)
    .map((t) => ({
      name: t.function.name,
      description: typeof t.function.description === "string" ? t.function.description : "",
      parameters: t.function.parameters ?? { type: "object", properties: {}, required: [] },
    }));
  if (offered.length === 0) return "";

  const catalogue = offered
    .map((f) => `  - name: ${JSON.stringify(f.name)}\n    description: ${JSON.stringify(f.description)}\n    parameters: ${JSON.stringify(f.parameters)}`)
    .join("\n");

  return [
    "TOOL CALLING MODE.",
    "The user has asked you to use one of the following tools. You cannot run a tool yourself; all you can do is REQUEST one, by replying with a single JSON object and nothing else.",
    "",
    "Reply with EXACTLY this shape and NOTHING else — no prose before it, no prose after it, no markdown of your own:",
    '{"name": "<one of the tool names below>", "arguments": {<the arguments for that tool>}}',
    "",
    "Rules:",
    "- Output raw JSON only. If you are about to explain, do not — the explanation is dropped.",
    '- The "name" MUST be copied character-for-character from the list below. Inventing a name is a failure.',
    '- "arguments" MUST be a JSON object, even when the tool takes no arguments (use {}).',
    "- Choose at most ONE tool. Never emit more than one JSON object.",
    "- If no tool fits the request, do not emit JSON at all; answer normally in plain text.",
    "",
    "Available tools:",
    catalogue,
    "",
    "Request:",
  ].join("\n");
}

// --------------------------------------------------------------------- parse --

/** Remove `,` that sits before a `}` or `]` — the single most common model slip. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        if (i + 1 < text.length) out += text[++i];
      } else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop the comma
    }
    out += ch;
  }
  return out;
}

/** Balanced `{...}` extraction that ignores braces inside strings. Returns every candidate, outermost-first. */
function balancedObjects(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr: string | null = null;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          found.push(text.slice(i, j + 1));
          i = j; // outermost only
          break;
        }
      }
    }
  }
  return found;
}

/** Fenced code blocks (```json / ``` / ```JSON …), plus the bare objects outside them. */
function jsonCandidates(raw: string): string[] {
  const out: string[] = [];
  const fenceRe = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  for (const m of raw.matchAll(fenceRe)) {
    const body = m[2] ?? "";
    if (body.includes("{")) out.push(body);
  }
  // Strip fences before hunting for bare objects, so the fenced text is not
  // also considered a second time from the outside.
  const outside = raw.replace(fenceRe, "\n");
  out.push(...balancedObjects(outside));
  return out;
}

/**
 * A plain object — not null, not an array, not a primitive.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readName(obj: Record<string, unknown>): string | null {
  for (const key of NAME_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (isPlainObject(v) && typeof (v as Record<string, unknown>).name === "string") return String((v as Record<string, unknown>).name).trim();
  }
  return null;
}

/**
 * Read the arguments, tolerating a JSON-STRING payload (the OpenAI wire form,
 * and the form most models produce). Anything that is not a plain object is a
 * REJECT, never a partial parse.
 *
 * `scope` is where the arguments are looked for: the top-level object, or the
 * nested `function` wrapper when the model used one.
 */
function readArguments(obj: Record<string, unknown>, scope: Record<string, unknown> = obj): Record<string, unknown> | null {
  for (const key of ARG_KEYS) {
    if (!(key in scope)) continue;
    const v = scope[key];
    if (isPlainObject(v)) return v;
    if (typeof v === "string") {
      const parsed = tryJson(v);
      if (isPlainObject(parsed)) return parsed;
      return null; // a string that is not an object is a reject, not a fallback
    }
    return null; // number/boolean/array/null arguments are a reject
  }
  // No argument key at all is legal: a no-argument tool was called with {}.
  return {};
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(stripTrailingCommas(text));
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

/** Deterministic, collision-resistant-enough id for the `role:"tool"` round-trip. */
function makeToolCallId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `call_soft_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Parse a model reply into a SOFT (unexecuted) tool call, or `null` when the
 * model did not comply.
 *
 * Rejects — by returning `null`, never by throwing — on: no JSON at all, JSON
 * that is not an object, a name the caller did not offer, a name that is not a
 * string, arguments that are not a plain object, and arguments given as a
 * string that does not parse to an object.
 */
export function parseToolCall(raw: string, tools: ToolSpec[]): ParsedToolCall | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const offered = new Set(tools.filter((t) => !!t && typeof t === "object" && typeof t.function?.name === "string").map((t) => t.function.name));
  if (offered.size === 0) return null;

  const text = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryJson(candidate);
    if (!isPlainObject(parsed)) continue;
    const name = readName(parsed);
    // THE VALIDATION GATE: a model inventing a function name is rejected here,
    // never passed through to the caller.
    if (!name || !offered.has(name)) continue;
    // When the model used the nested `{"function":{…}}` wrapper, the arguments
    // live inside that wrapper, not at the top level.
    const scope = isPlainObject(parsed.function) ? (parsed.function as Record<string, unknown>) : parsed;
    const args = readArguments(parsed, scope);
    if (!args) continue; // not a plain object -> no partial parse
    return {
      toolCallId: makeToolCallId(`${name}:${JSON.stringify(args)}`),
      name,
      arguments: args,
      argumentsJson: JSON.stringify(args),
      type: "function",
      soft: true,
      executed: false,
      mechanism: "soft-prompt",
    };
  }
  return null;
}

// -------------------------------------------------------------------- strip --

/** Does this text contain a tool-call-shaped envelope, at all? (shape only, no name validation) */
function looksLikeEnvelope(obj: Record<string, unknown>): boolean {
  return readName(obj) !== null && ARG_KEYS.some((k) => k in obj);
}

/**
 * Is this raw candidate the tool-call envelope?
 *
 * Two ways to be one, and both must be caught:
 *  - it parses as a JSON object carrying a name and an arguments key; or
 *  - it does NOT parse — a model that echoed the instruction back carries the
 *    SHAPE EXAMPLE, `{"name": "<one of the tool names below>", "arguments":
 *    {<the arguments for that tool>}}`, which is not valid JSON but is pure
 *    scaffolding and must never be visible to the caller.
 */
function isEnvelopeSpan(candidate: string): boolean {
  const obj = tryJson(stripTrailingCommas(candidate));
  if (isPlainObject(obj)) return looksLikeEnvelope(obj);
  return /"name"\s*:/.test(candidate) && ARG_KEYS.some((k) => new RegExp(`"${k}"\\s*:`).test(candidate));
}

/**
 * Remove the tool-call envelope from the model's reply so the scaffolding never
 * reaches the caller as visible content.
 *
 * When an envelope is present the returned `content` is what remains of the
 * reply after the JSON and the "here is the JSON" scaffolding are removed, so a
 * model that said only the JSON leaves `""`. When there is NO envelope the
 * content is returned byte-for-byte untouched — this function never invents a
 * tool call and never edits prose that was not scaffolding.
 */
export function stripToolCall(raw: string): { content: string; parsed: boolean } {
  if (typeof raw !== "string" || raw.length === 0) return { content: "", parsed: false };
  const text = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;

  const fenceRe = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let parsed = false;
  let content = text;

  // 1. Fenced envelopes: drop the whole block, never its contents.
  content = content.replace(fenceRe, (whole, _lang: string, body: string) => {
    if (!body.includes("{")) return whole;
    for (const cand of balancedObjects(body)) {
      if (isEnvelopeSpan(cand)) {
        parsed = true;
        return "";
      }
    }
    return whole;
  });

  // 2. Bare object outside any fence. Every envelope found is removed, not just
  //    the first: a model that echoed the instruction back carries a copy of
  //    the SHAPE EXAMPLE, and leaving that visible would be worse than useless.
  for (const cand of balancedObjects(content)) {
    if (isEnvelopeSpan(cand)) {
      parsed = true;
      content = content.replace(cand, "");
    }
  }

  if (!parsed) return { content: raw, parsed: false };

  // 3. Drop the scaffolding prose that exists only to introduce the JSON. A line
  //    qualifies only when it NAMES the envelope ("Here is the JSON:",
  //    "Tool call:") or is a short bare introducer ending in a colon. A line
  //    like "Sure, I will look that up." is the model's real answer and survives.
  const lines = content
    .split(/\r?\n/)
    .filter((l) => {
      if (/\bjson\b|tool[_ ]?call|"name"\s*:|```/i.test(l)) return false;
      const t = l.trim();
      return !(t.length > 0 && t.length <= 80 && t.endsWith(":") && !/[{}]/.test(t));
    });
  return { content: lines.join("\n").trim(), parsed: true };
}
