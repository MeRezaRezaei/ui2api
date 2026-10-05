import { readFileSync } from "node:fs";

/**
 * GOAL 91 / GOAL 104 — the daemon's NAMED error codes, MEASURED from source.
 *
 * WHY THIS IS A HELPER AND NOT A `.test.ts` IMPORT. The obvious fix for
 * "the readiness gate greps for the name `typedClientErrorCodes` instead of
 * measuring the contract" is to `import { measureEmitted } from
 * "./error-contract.test.js"`. That does NOT work here: under `node --test`,
 * importing a `.test.ts` from another `.test.ts` RE-REGISTERS that file's
 * `describe`/`test` blocks inside the importing run, so the readiness gate would
 * silently execute the whole error-contract suite a second time and report its
 * cases under its own file. The repo already records this exact hazard, for the
 * same reason, at `test/test-timeout-discipline.test.ts:245-250` ("importing
 * the sibling would (a) mean importing a `.test.ts`, which under node:test
 * RE-REGISTERS that file's tests inside this run"). So the measurement lives in
 * a plain module and BOTH gates call the ONE implementation.
 *
 * ONE implementation is the point. The defect being fixed was two files able to
 * disagree about what "the error contract is measured" means: the contract gate
 * ran a real scan, and the readiness gate asserted only that the scanner's NAME
 * appeared in the file — so emptying the scanner's body left both files
 * satisfied and the error contract unmeasured. There is now no second copy of
 * the rule to be stale.
 */

export type Emitted = Map<string, number>;

/**
 * THE CHARACTER CLASS EVERY HARVEST PATTERN BELOW USES, and why it is this one.
 *
 * MEASURED DEFECT: the class was `[a-z_]+` — lowercase letters and underscore
 * only, NO DIGIT. The daemon serves `ui2api_driver_error` (the `2` is inside
 * `ui2api`), so every pattern here returned `null` for it and the error-contract
 * gate was blind to the exact code `POST /prompt` was changed to answer
 * (0169578 / ca7d62c), where it previously erased a known driver fault into an
 * anonymous `internal_error` 500. A gate that cannot see a code the server
 * actually serves is not measuring the error contract; it is measuring a
 * vocabulary someone typed. Vocabulary measured 16 codes before, 17 after; the
 * one that appeared is `ui2api_driver_error` (502).
 *
 * WHY `[A-Za-z0-9_-]+` AND NOT "ANYTHING". An identifier shape, confirmed
 * against the real literals: `ui2api_driver_error` needs the digit,
 * `vault-root-unresolvable` / `host-unreadable` / `vault-probe-threw`
 * (src/prompt/http.ts:545,560,591,1553) need the hyphen, and uppercase is legal
 * so a future `NotFound` is not silently invisible either. It still REFUSES a
 * space, a dot, a colon, a slash, an embedded quote and the empty string — so it
 * cannot swallow prose, which is the failure mode of widening to `[^"]*`.
 *
 * IT IS PINNED, NOT HOPED FOR: `test/error-contract.test.ts` reads every
 * character class out of this file, asserts each one can express all three of
 * those shapes and rejects all of those non-codes, and asserts the measured
 * vocabulary really contains a code the old class could not see. Narrow this
 * class back to `[a-z_]+` and that suite goes RED naming it.
 */
const CODE_CLASS = "A-Za-z0-9_-";

/** Codes carried inside an `{ error: { ... code: "x" } }` envelope, with the status of its send(). */
function envelopeCodes(src: string, into: Emitted): void {
  const re = new RegExp(`error:\\s*\\{[\\s\\S]{0,400}?code:\\s*"([${CODE_CLASS}]+)"`, "g");
  for (const m of src.matchAll(re)) {
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    // the status literal of the enclosing send(res, NNN, {...}) / sendJson(res, NNN, ...)
    const statuses = [...before.matchAll(/(?:send|sendJson)\(\s*(?:res|w)\s*,\s*(\d{3})/g)];
    const status = statuses.length ? Number(statuses[statuses.length - 1]![1]) : 0;
    if (status) into.set(m[1]!, status);
  }
}

/**
 * GOAL 104: a typed `HttpClientError` carries its code dynamically, so the
 * envelope scan above cannot see it. These codes are EMITTED, and they are
 * measured from the real constructor call sites — a precise pattern
 * (`new HttpClientError(<status>, "<code>"`), not a hand-kept list, so a code
 * that is documented but never thrown still fails the bidirectional check.
 */
function typedClientErrorCodes(src: string, into: Emitted): void {
  for (const m of src.matchAll(new RegExp(`new HttpClientError\\(\\s*(\\d{3})\\s*,\\s*"([${CODE_CLASS}]+)"`, "g"))) {
    into.set(m[2]!, Number(m[1]));
  }
}

/** poolRefusal answers one code per pool refusal, all under the status its own doc comment states. */
function poolRefusalCodes(src: string, into: Emitted): void {
  const start = src.indexOf("function poolRefusal");
  if (start < 0) return;
  const body = src.slice(start, src.indexOf("\n}", start));
  // RegExp.prototype.exec takes ONE argument; a second `{ timeout }` arg is
  // silently ignored by V8 and was never a regex API. Removing it is provably
  // behaviour-preserving (measured: /a/.exec("a", {timeout:5}) -> ["a"]).
  const status = Number(/Answer (\d{3})/.exec(src.slice(Math.max(0, start - 500), start))?.[1] ?? 0);
  for (const m of body.matchAll(new RegExp(`return \\{ code: "([${CODE_CLASS}]+)" \\}`, "g"))) into.set(m[1]!, status);
}

/** Everything the daemon actually emits, measured. */
export function measureEmitted(): Emitted {
  const http = readFileSync("src/prompt/http.ts", "utf8");
  const openai = readFileSync("src/prompt/openai.ts", "utf8");
  const out: Emitted = new Map();
  envelopeCodes(http, out);
  envelopeCodes(openai, out);
  poolRefusalCodes(http, out);
  typedClientErrorCodes(http, out);
  // the last-resort net's named generic 500
  if (/code:\s*"internal_error"/.test(http)) out.set("internal_error", 500);
  return out;
}

/** The doc's table rows: status + code, as shipped. Same class, so a hyphenated code is readable in a doc row too. */
export function parseDocTable(doc: string): Emitted {
  const out: Emitted = new Map();
  for (const m of doc.matchAll(new RegExp(`^\\|\\s*(\\d{3})\\s*\\|\\s*\\\`([${CODE_CLASS}]+)\\\`\\s*\\|`, "gm"))) out.set(m[2]!, Number(m[1]));
  return out;
}

/** The single source of truth for "doc and code agree", shared by every caller. */
export function contractGaps(emitted: Emitted, documented: Emitted): string[] {
  const gaps: string[] = [];
  for (const [code, status] of emitted) {
    if (!documented.has(code)) gaps.push(`${code} (${status}) is emitted by the daemon but documented nowhere`);
    else if (documented.get(code) !== status) gaps.push(`${code}: code emits ${status}, doc says ${documented.get(code)}`);
  }
  for (const [code, status] of documented) {
    if (!emitted.has(code)) gaps.push(`${code} (${status}) is documented but the daemon never emits it`);
  }
  return gaps;
}