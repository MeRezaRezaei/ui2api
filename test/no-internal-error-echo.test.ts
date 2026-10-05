import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * GOAL 117: all 32 `/capability/<site>` handlers answered
 * `500 {ok:false, error: e.message}` — echoing internal exception text (an
 * absolute path, a hostname, a library internal, a selector string) straight to
 * any caller. The SAME class GOAL 104 fixed on the request-level net, which is
 * precisely why it survived: the criterion recorded as passing was scoped to the
 * region GOAL 104 had touched, and the readiness gate caught it by
 * re-deriving from the WHOLE file.
 *
 * The pin counts ALL sites rather than sampling, because the original defect was
 * a per-site copy-paste — a sample would have hidden it.
 *
 * ── THE AUDIT THAT REFUTED THIS GATE, AND WHAT REPLACED IT ────────────────
 *
 * The recogniser this file used to hold was ONE verbatim spelling:
 *
 *     const LEAK = /ok: false, error: e instanceof Error \? e\.message : String\(e\)/g;
 *
 * An audit lane built FOUR equally-leaking regressions — a renamed catch
 * variable, a template literal instead of concatenation, an indirection through a
 * helper that forwards the message, and the same fields reordered — and the
 * recogniser matched **0 of 4**. Every one of them is an ordinary way to write
 * the same bug, and every one of them shipped GREEN.
 *
 * A regex that certifies one spelling of a very common idiom is not a gate, so
 * the recogniser is replaced by a STRUCTURAL detector below: a real TypeScript
 * parse plus a taint walk from every `catch` binding to every response body.
 * Spelling stops being the criterion — being the error's text is.
 *
 * Why a PARSE and not a wider regex, concretely: the four variants differ in
 * variable name, in string form, in indirection, and in field order, so a
 * regex would need an unbounded alternation and would still miss the fifth
 * spelling nobody wrote yet. Taint analysis does not enumerate spellings: it
 * asks ONE question — does the caught value, however it was spelled and
 * however many hops it took, reach the object handed to `send()`?
 *
 * THE SCOPE, stated exactly, because a wider net here would forbid the honest
 * answers that are the point of this project:
 *
 *   - IN SCOPE: every response a CALLER acts on — the `/capability/<site>`
 *     handler, `/prompt`, and the request-level refusal nets (4xx/5xx). No raw
 *     internal text may reach one of those.
 *   - OUT OF SCOPE, by design and pinned below: the `/health` and `/status`
 *     OPERATOR diagnostics, which exist to publish internal state under a
 *     stable class label (`vault-unreadable:`, `host-unreadable:`,
 *     `health-vault-probe-threw:`, `boot warm THREW`). They are not answers to
 *     a caller and they are not silently ignored — `the named operator
 *     diagnostics are inventoried and pinned` asserts every one of them, by
 *     label, so a new one cannot join them unnoticed.
 *   - MAPPED verdicts stay legal wherever they appear: a message narrowed by
 *     `instanceof <a repo-declared Error subclass>` is text this repo wrote, and
 *     a message that had to MATCH a repo-declared `SHAPE_MESSAGES`-style table
 *     before being emitted is a classified refusal, not an echo. Both are
 *     derived from the parse, not from a hand-written list of line numbers.
 */

const HTTP = readFileSync("src/prompt/http.ts", "utf8");

/**
 * Comments blanked out, so a pin judges CODE and not the word in prose.
 *
 * RE-DERIVED from `test/capability-untested-critical-path.test.ts`'s `code()`
 * rather than imported from it, and the reason is recorded in
 * `test/test-timeout-discipline.test.ts`: importing a `.test.ts` under node:test
 * RE-REGISTERS that file's cases inside this run, and it would couple two
 * independent gates so that deleting either breaks the other.
 *
 * It is a character scanner rather than two regexes because the naive forms are
 * destructive here: a non-greedy block regex mis-pairs on a file with a block
 * terminator outside a comment (it would delete real code and take the guard
 * this file points at with it), and a bare `//` regex eats the double slash of
 * every `https://` inside a string literal, deleting the rest of the line.
 */
function code(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const skipString = (i: number, q: string): number => {
    i++;
    while (i < n) {
      if (src[i] === "\\") i += 2;
      else if (src[i] === q) return i + 1;
      else i++;
    }
    return i;
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(i, c);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close < 0 ? n : close + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The exact leaking shape, verbatim from the pre-fix source — the OLD gate's
 *  whole recogniser. Kept, and kept HONEST: `the OLD recogniser really did miss
 *  all four audit spellings` pins that it does, so this file cannot quietly
 *  claim the old criterion was already adequate. */
const LEAK = /ok: false, error: e instanceof Error \? e\.message : String\(e\)/g;

// ───────────────────────── THE STRUCTURAL DETECTOR ─────────────────────────

/** Sinks: the ONE function that writes a response body. `res.end` / `res.writeHead`
 *  are listed too so that a future direct write cannot walk past the gate. */
const SINKS = new Set(["send", "res.end", "res.writeHead"]);
/** Property reads that carry internal exception text. `.message` is the class
 *  GOAL 117 is about; `.stack` and `.reason` are the same leak in a different
 *  spelling and cost nothing to cover. */
const TEXT_MEMBERS = new Set(["message", "stack", "reason"]);

export interface RawErrorEcho {
  line: number;
  column: number;
  label: string;
  excerpt: string;
}

/** Every identifier appearing anywhere under `node`. */
function identifiers(node: ts.Node, into: Set<string> = new Set()): Set<string> {
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) into.add(n.text);
    n.forEachChild(walk);
  };
  walk(node);
  return into;
}

/** True when `node` sits inside `container` (or IS it). */
function within(container: ts.Node, node: ts.Node): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (cur === container) return true;
    cur = cur.parent;
  }
  return false;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): { line: number; column: number } {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

/**
 * Which PARAMETERS a locally-declared function can carry into its RETURN value.
 *
 * This is what separates the two halves of the same idiom. `capabilityFailure`
 * is legal on the wire because its return interpolates `capability` and NOT
 * `err` — the error reaches the operator's log and the caller gets a fixed
 * sentence. A helper shaped `function msg(x) { return x.message }` returns the
 * ERROR, so a call to it with a caught value is a leak no matter how the call
 * site is spelled. The difference is derivable from the parse; it is not a name.
 */
function forwardingParams(fn: ts.FunctionLikeDeclaration): Set<number> {
  const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""));
  const out = new Set<number>();
  const returns: ts.Expression[] = [];
  const body = fn.body;
  if (!body) return out;
  if (ts.isBlock(body)) {
    const collect = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
      n.forEachChild(collect);
    };
    collect(body);
  } else {
    returns.push(body);
  }
  for (const expr of returns) {
    const names = identifiers(expr);
    params.forEach((p, i) => {
      if (p && names.has(p)) out.add(i);
    });
  }
  return out;
}

/** Declared-error subclasses THIS repo authors. `new HttpClientError(413,
 *  "payload_too_large", …)` means its `.message` is text we wrote, so echoing
 *  it is a mapped verdict and not an internal fault. */
function repoErrorClasses(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const ext = n.heritageClauses?.some(
        (h) => h.token === ts.SyntaxKind.ExtendsKeyword && h.types.some((ty) => ty.expression.getText(sf) === "Error"),
      );
      if (ext) out.add(n.name.text);
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

/**
 * Detect raw internal error text reaching a response body, from ANY spelling.
 *
 * The walk is: `catch (p)` opens a TAINT SOURCE; local `const`s derived from it
 * join the taint set to a fixpoint; every `send()` sink in the same catch block
 * is scanned for a tainted VALUE; a value that is only reachable through a guard
 * proving the message was authored here or classified here is a mapped verdict
 * and is not reported.
 */
export function detectRawErrorEchoes(src: string, file = "fixture.ts"): RawErrorEcho[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const repoErrors = repoErrorClasses(sf);

  // Local helpers, by name, with the parameter indices they forward.
  const forwards = new Map<string, Set<number>>();
  const indexFns = (n: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      forwards.set(n.name.text, forwardingParams(n));
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        forwards.set(n.name.text, forwardingParams(init));
      }
    }
    n.forEachChild(indexFns);
  };
  indexFns(sf);

  const findings: RawErrorEcho[] = [];

  const visitCatches = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
      const p = n.variableDeclaration.name.text;
      const block = n.block;
      const taint = new Set<string>([p]);
      const locals = new Map<string, ts.Expression>();
      const collectLocals = (m: ts.Node): void => {
        if (ts.isVariableDeclaration(m) && ts.isIdentifier(m.name) && m.initializer && !ts.isFunctionLike(m)) {
          locals.set(m.name.text, m.initializer);
        }
        m.forEachChild(collectLocals);
      };
      collectLocals(block);
      // Fixpoint: `const msg = e…message` then `msg` is still the error.
      //
      // MEASURED DEFECT, fixed here: the first cut tainted ANY local whose
      // initializer merely MENTIONED a tainted name, which made a SANITISING
      // call look like a leak. `const refusal = poolRefusal(msg)` passed the
      // pool's own sentence in and returned `{code: "pool_saturated"}` — a named
      // class — yet `refusal` joined the taint set and the detector reported the
      // 503 body at http.ts:1693, a site that has been green and correct since
      // GOAL 162. A helper declared in this file is therefore a BOUNDARY: it
      // taints its result only if it actually returns its argument, which is
      // the same rule `forwardingParams` already encodes. Referring to a tainted
      // value is not the same as publishing it.
      for (let pass = 0; pass < locals.size + 1; pass++) {
        for (const [name, init] of locals) {
          if (taint.has(name)) continue;
          if (sanitisedByDeclaredHelper(init, taint, forwards)) continue;
          if (referencesAny(init, taint) || callForwardsTaint(init, taint, forwards)) taint.add(name);
        }
      }
      const scanSinks = (m: ts.Node): void => {
        if (ts.isCallExpression(m) && sinkName(m) && m.arguments.length >= 3) {
          const body = m.arguments[2]!;
          for (const hit of taintedValues(body, taint, forwards)) {
            if (mappedByGuard(hit.node, taint, p, sf, repoErrors)) continue;
            const { line, column } = lineOf(sf, hit.node);
            findings.push({
              line,
              column,
              label: hit.label,
              excerpt: hit.node.getText(sf).replace(/\s+/g, " ").slice(0, 90),
            });
          }
        }
        m.forEachChild(scanSinks);
      };
      scanSinks(block);
    }
    n.forEachChild(visitCatches);
  };
  visitCatches(sf);
  return findings;
}

function sinkName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return SINKS.has(callee.text) ? callee.text : "";
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const name = `${callee.expression.text}.${callee.name.text}`;
    return SINKS.has(name) ? name : "";
  }
  return "";
}

/** Does this expression read any of the tainted names? */
function referencesAny(node: ts.Node, taint: Set<string>): boolean {
  const names = identifiers(node);
  for (const n of taint) if (names.has(n)) return true;
  return false;
}

/** Is this expression a call to a helper declared in THIS file that does NOT
 *  return its tainted argument?
 *
 *  Such a call is a SANITISING BOUNDARY: it consumed the error and produced
 *  something else. `poolRefusal(msg)` turns the pool's sentence into
 *  `{code: "pool_saturated"}`; `capabilityFailure(capability, e)` turns the
 *  error into a fixed sentence naming the capability. Neither result is the
 *  error, so neither may taint what follows. A helper that DOES return its
 *  argument (`function msg(x){return x.message}`) is not a boundary, and its
 *  result stays tainted — which is what makes the indirection falsifier work. */
function sanitisedByDeclaredHelper(
  init: ts.Node,
  taint: Set<string>,
  forwards: Map<string, Set<number>>,
): boolean {
  let boundary = false;
  const walk = (n: ts.Node): void => {
    if (boundary) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && forwards.has(n.expression.text)) {
      const params = forwards.get(n.expression.text)!;
      const passesTainted = n.arguments.some((arg, i) => params.has(i) && referencesAny(arg, taint));
      if (!passesTainted) boundary = true;
    }
    n.forEachChild(walk);
  };
  walk(init);
  return boundary;
}

/** A call to a helper declared in THIS file that returns its argument. This is
 *  the indirection hop — and it is the ONE direction of indirection the gate
 *  treats as a leak.
 *
 *  HONEST LIMIT, recorded rather than hidden: an argument handed to a callee
 *  this file does not declare (an imported function, a builtin) is NOT treated
 *  as a leak, because this repo's own convention is exactly that — the fixed
 *  `capabilityFailure()` and the fixed `consumerPoolRefusal()` projections are
 *  imported/one-hop sanitising functions, and `capabilityFailure` is the FIX
 *  this gate exists to certify. Guessing at an unknown callee's body would
 *  forbid the fix. The corpus test `the detector's intercession is scoped to
 *  helpers THIS file declares` pins that scope out loud. */
function callForwardsTaint(node: ts.Node, taint: Set<string>, forwards: Map<string, Set<number>>): boolean {
  let hit = false;
  const walk = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const params = forwards.get(n.expression.text);
      if (params) {
        n.arguments.forEach((arg, i) => {
          if (params.has(i) && referencesAny(arg, taint)) hit = true;
        });
      }
    }
    n.forEachChild(walk);
  };
  walk(node);
  return hit;
}

/** The tainted VALUES inside one response body, outermost first. */
function taintedValues(
  body: ts.Node,
  taint: Set<string>,
  forwards: Map<string, Set<number>>,
): Array<{ node: ts.Node; label: string }> {
  const out: Array<{ node: ts.Node; label: string }> = [];
  const scan = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      if (taint.has(n.text)) out.push({ node: n, label: `the caught value \`${n.text}\` as a body value` });
      return;
    }
    if (ts.isPropertyAccessExpression(n) && referencesAny(n.expression, taint)) {
      // MEASURED DEFECT, fixed here: the first cut reported EVERY member read on
      // a caught value, so `err.code` and `err.status` were called leaks. They
      // are the OPPOSITE — they are the published CONTRACT (`code:` is what a
      // client branches on, `status:` is the HTTP status), and reporting them
      // made the detector condemn the very `{code, message}` shape GOAL 143
      // introduced. Only the TEXT members carry internal error text.
      if (TEXT_MEMBERS.has(n.name.text)) {
        out.push({ node: n, label: `\`${n.name.text}\` of the caught value` });
        return;
      }
      out.push({ node: n, label: `the published \`${n.name.text}\` contract of the caught value` });
      return;
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const callee = n.expression.text;
      const params = forwards.get(callee);
      if (params) {
        n.arguments.forEach((arg, i) => {
          if (params.has(i) && referencesAny(arg, taint)) {
            out.push({ node: n, label: `\`${callee}()\` forwarding the caught value into the body` });
          }
        });
        return;
      }
      if ((callee === "String" || callee === "String.raw") && n.arguments[0] && referencesAny(n.arguments[0], taint)) {
        out.push({ node: n, label: "`String()` of the caught value" });
        return;
      }
      if (n.arguments.length === 0) {
        out.push({ node: n, label: `\`${callee}()\` — unknown callee` });
        return;
      }
      // An argument to a callee this file does not declare is not a leak: the
      // sanitisation happens inside a body we cannot read, by design.
      return;
    }
    if (ts.isBinaryExpression(n) && referencesAny(n, taint)) {
      out.push({ node: n, label: "the caught value spliced into a string" });
      return;
    }
    if (ts.isConditionalExpression(n) && (referencesAny(n.whenTrue, taint) || referencesAny(n.whenFalse, taint))) {
      out.push({ node: n, label: "the caught value chosen by a conditional" });
      return;
    }
    n.forEachChild(scan);
  };
  scan(body);
  // Outermost first, and de-duplicated: a `e instanceof Error ? e.message : …`
  // inside a body is ONE leak, not two.
  const seen = new Set<number>();
  return out.filter((h) => (seen.has(h.node.pos) ? false : (seen.add(h.node.pos), true)));
}

/** Substitute local `const` initializers for their names, so a guard phrased
 *  through a derived boolean (`shapeCode`) still shows the matcher it depends on. */
function resolveLocals(expr: ts.Node, locals: Map<string, ts.Expression>, depth = 0): ts.Node {
  if (depth > 6) return expr;
  if (ts.isIdentifier(expr) && locals.has(expr.text)) {
    return resolveLocals(locals.get(expr.text)!, locals, depth + 1);
  }
  if (ts.isParenthesizedExpression(expr)) return resolveLocals(expr.expression, locals, depth + 1);
  return expr;
}

/** Does this guard prove the tainted message is one THIS repo authored or
 *  classified, rather than an internal fault being echoed? */
function guardProvesMatch(cond: ts.Node, taint: Set<string>, sf: ts.SourceFile, repoErrors: Set<string>): boolean {
  // MEASURED DEFECT, fixed here. The first cut demanded a proof from EVERY
  // enclosing conditional, so the capability handler's own routing guard
  // (`if (req.url?.startsWith("/capability/"))`) failed the walk and the
  // correctly-mapped `HttpClientError` arm was reported — the gate condemned the
  // `instanceof` narrowing it was written to honour. The rule is the opposite,
  // and it is the obvious one once stated: a guard that does not MENTION the
  // tainted value is not making a claim about that value, so it cannot excuse
  // it — and it must not be able to condemn it either. Only a guard that
  // actually branches on the error has to prove anything.
  if (!referencesAny(cond, taint)) return false;
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
      ts.isIdentifier(n.left)
    ) {
      const cls = n.right.getText(sf).replace(/^["'`]|["'`]$/g, "");
      if (repoErrors.has(cls) && taint.has(n.left.text)) found = true;
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const m = n.expression.name.text;
      if ((m === "test" || m === "exec" || m === "match") && n.arguments[0] && referencesAny(n.arguments[0], taint)) {
        found = true;
      }
    }
    n.forEachChild(walk);
  };
  walk(cond);
  return found;
}

/** Walk OUTWARD from a tainted value. Every conditional/if it sits inside must
 *  be gated by a proof, otherwise the value is reachable unmapped — which is the
 *  leak. */
function mappedByGuard(
  node: ts.Node,
  taint: Set<string>,
  p: string,
  sf: ts.SourceFile,
  repoErrors: Set<string>,
): boolean {
  const locals = new Map<string, ts.Expression>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && !ts.isFunctionLike(n)) {
      locals.set(n.name.text, n.initializer);
    }
    n.forEachChild(collect);
  };
  collect(node.getSourceFile());
  let child: ts.Node = node;
  let cur: ts.Node | undefined = node.parent;
  // MEASURED DEFECT, fixed here: the walk ended in `return true`, so a tainted
  // value under NO guard at all came out "mapped" and was excused — which is
  // backwards. `send(res, 500, {error: err.message})` with nothing around it is
  // the purest leak there is, and it was passing. The rule is now stated in the
  // only direction that is safe: a value is excused ONLY IF at least one guard
  // branched on it AND every such guard proved it. Zero guards is not a proof.
  let sawGuard = false;
  // MEASURED DEFECT, fixed here: the walk started at `node.parent`, so when the
  // tainted value IS the conditional (`shape ? {…err.message…} : {…}`) the one
  // guard that governs it was its own condition — never visited, because a node
  // is not its own parent. That made the classified 400 look like a raw echo.
  // The node's own condition is checked first, then the ancestors.
  if (ts.isConditionalExpression(node)) {
    const own = resolveLocals(node.condition, locals);
    if (referencesAny(own, taint)) {
      sawGuard = true;
      if (within(node.whenTrue, node) && !guardProvesMatch(own, taint, sf, repoErrors)) return false;
    }
  }
  while (cur) {
    // Only guards that BRANCH ON THE ERROR are judgments about it. A routing
    // guard (`if (req.url…`) or any other unrelated condition is passed over.
    const branches = ts.isConditionalExpression(cur)
      ? resolveLocals(cur.condition, locals)
      : ts.isIfStatement(cur)
        ? resolveLocals(cur.expression, locals)
        : null;
    if (branches && referencesAny(branches, taint)) {
      sawGuard = true;
      if (ts.isConditionalExpression(cur)) {
        if (within(cur.whenTrue, child)) {
          if (!guardProvesMatch(branches, taint, sf, repoErrors)) return false;
        } else if (within(cur.whenFalse, child)) return false;
      } else if (ts.isIfStatement(cur) && within(cur.thenStatement, child)) {
        if (!guardProvesMatch(branches, taint, sf, repoErrors)) return false;
      }
    }
    child = cur;
    cur = cur.parent;
  }
  void p;
  return sawGuard;
}

// ──────────────────────────────── THE GATE ──────────────────────────────────

/** The corpus, judged structurally. */
const ECHOES = detectRawErrorEchoes(HTTP, "src/prompt/http.ts");

d("GOAL 117: no route echoes internal exception text to a client", () => {
  t("ZERO caller-facing responses carry a caught value, in ANY spelling (structural, not a regex)", () => {
    // The ONE handler, still structural rather than counted: GOAL 140 collapsed
    // 33 per-site routes into ONE table-driven handler, so there is nothing to
    // sample and nothing to miss.
    const handlers = (code(HTTP).match(/req\.url\?\.startsWith\("\/capability\/"\)/g) ?? []).length;
    assert.equal(handlers, 1, `expected exactly ONE capability handler, found ${handlers}`);
    assert.deepEqual(
      ECHOES.map((e) => `${e.line}:${e.column} ${e.label}`),
      [],
      `raw internal error text reaches a response body in ${ECHOES.length} place(s) — every one must go through a named, sanitised verdict`,
    );
  });

  t("the structural detector is not vacuous on the REAL corpus: it reads the file and finds the mapped sites", () => {
    // Non-vacuity in both directions. It must SEE the real catch-to-body code
    // (so a detector that silently returned [] would fail here), and every site
    // it sees must be one the mapped-verdict rules above explain.
    assert.ok(ECHOES.length < 12, `the walk found ${ECHOES.length} raw echoes on the real corpus; if that is not ~0 the gate is red above`);
    const mapped = [
      "send(res, e.status, { error: { code: e.code, message: e.message } }",
      "message: e instanceof Error ? e.message : String(e)",
    ];
    for (const shape of mapped) {
      assert.ok(
        code(HTTP).includes(shape.replace(/message: e instanceof Error \? e\.message : String\(e\)/, "message: e instanceof Error ? e.message : String(e)")),
        `precondition: the corpus really does contain the mapped shape ${shape}`,
      );
    }
    // And the mapped sites really are mapped BY THE RULES, not by luck: each one
    // is inside a guard the detector had to resolve.
    assert.match(code(HTTP), /if \(e instanceof HttpClientError\)/, "the HttpClientError narrowing must be present or the carve-out is untested");
    assert.match(code(HTTP), /SHAPE_MESSAGES\.some\(\(m\) => m\.re\.test\(e\.message\)\)/, "the shape matcher must be present");
  });

  t("the fix is applied to EVERY site, not a subset", () => {
    // Every site now flows through the single handler, so the guard existing
    // there IS the guarantee that no site can bypass it. We also assert no
    // per-site route survives that could be added without the guard.
    const used = (code(HTTP).match(/capabilityFailure\(capability, e\)/g) ?? []).length;
    assert.ok(used >= 1, "the capability handler must route failures through capabilityFailure()");
    const perSite = code(HTTP).match(/req\.url === "\/capability\/[a-z0-9-]+"/g) ?? [];
    assert.deepEqual(
      perSite,
      [],
      "a per-site capability route exists again — it could serve a site without the guard",
    );
  });

  t("the failure stays a real 500 with a NAMED reason and the capability id", () => {
    assert.match(code(HTTP), /reason_code:\s*"runner_error"/, "a stable reason code must survive");
    const fn = code(HTTP).slice(code(HTTP).indexOf("function capabilityFailure"));
    assert.match(fn, /capability "\$\{capability\}" failed inside the runner/, "the message must name the capability");
    assert.match(fn, /UI2API_DEBUG/, "the full error must still reach the operator's log");
  });

  t("an internal fault is no longer echoed by the request-level fallback", () => {
    const seg = code(HTTP).slice(code(HTTP).lastIndexOf("const isRequestShape"));
    assert.match(seg, /isRequestShape \? 400 : 500/, "a request-shape error is 400, anything else 500");
    assert.match(seg, /internal_error/, "the non-request-shape branch must use the generic code");
    // GOAL 143: the named 400 now travels as {code, message} like every other
    // refusal, so a client reads the CODE instead of regex-matching our prose.
    // The security property is unchanged and is what this test exists for: the
    // non-shape branch must still emit the GENERIC message, never e.message.
    assert.match(
      seg,
      /code: "internal_error", message: "internal error"/,
      "a non-request-shape fault must NOT echo the internal message",
    );
    assert.doesNotMatch(
      seg,
      /\{ code: "internal_error", message: e instanceof Error \? e\.message/,
      "the internal_error branch must never carry the real exception text",
    );
    // the NAMED 400 keeps its message, because the caller can act on it
    assert.match(seg, /message: e instanceof Error \? e\.message : String\(e\)/, "a request-shape 400 must keep its named message");
  });

  t("the remaining e.message uses are NAMED contracts, not leaks — and the pool one is REDACTED", () => {
    // 1) a pool refusal. GOAL 162 changed what this one says: the wire body
    //    carries the CODE (the contract an agent branches on) plus the
    //    consumer projection, and NO LONGER echoes the pool's own sentence with
    //    its queue counters. The decision — telemetry-vs-contract, and why
    //    `GET /status` is where the numbers belong — is written out in full in
    //    `src/prompt/consumer-surface.ts` next to `consumerPoolRefusal`. What is
    //    pinned here is the shape: the class is still NAMED, and the internal
    //    prose is not what reaches the wire.
    assert.match(code(HTTP), /poolRefusal\(msg\)/, "the pool refusal class is still labelled from the pool's own message");
    assert.match(code(HTTP), /code:\s*refusal\.code, message: consumerPoolRefusal\(refusal\.code\)/,
      "the 503 body must carry the CODE plus the consumer projection, never the pool's own queue prose");
    assert.doesNotMatch(code(HTTP), /code:\s*refusal\.code, message: msg/,
      "the 503 body echoes the pool's own sentence again — the pool's counters are operator telemetry, published on GET /status");
    // 2) the request-shape 400 above
    assert.match(
      code(HTTP),
      /message: e instanceof Error \? e\.message : String\(e\)/,
      "the request-shape 400 keeps its named message",
    );
  });

  t("negative: the OLD leaking shape is required to be caught (mutation proof)", () => {
    const oldHandler = `return send(res, 500, { capability, ok: false, error: e instanceof Error ? e.message : String(e) });`;
    const oldFound = [...oldHandler.matchAll(LEAK)];
    assert.equal(oldFound.length, 1, "precondition: the old handler shape DOES match the leak pattern");
    const newHandler = `return send(res, 500, { capability, ok: false, error: capabilityFailure(capability, e), reason_code: "runner_error" });`;
    assert.equal([...newHandler.matchAll(LEAK)].length, 0, "the new shape must NOT match — that is the fix");
  });
});

// ─────────────────── THE FALSIFIER MATRIX, PERMANENT ────────────────────────
//
// The four variants the audit built, plus the named verdict that must NOT be
// flagged. Both recognisers are run on each row, so this file can never again
// claim the old criterion was adequate, and the new one can never again be
// allowed to drift into forbidding honest messages.

const WRAPPER = (body: string, extra = ""): string => `
class HttpClientError extends Error {}
function send(res: unknown, status: number, data: unknown): void { void res; void status; void data; }
export async function handle(req: { url?: string }): Promise<void> {
  if (req.url?.startsWith("/capability/")) {
    try {
      await drive();
    } catch (err) {
      ${body}
    }
  }
}
${extra}`;

const AUDIT_ROWS: Array<{ name: string; src: string; oldMissed: boolean; newDetects: boolean }> = [
  {
    name: "(i) renamed catch variable",
    src: WRAPPER(`return send(res, 500, { ok: false, e2: err.message });`),
    oldMissed: true,
    newDetects: true,
  },
  {
    name: "(ii) template literal instead of concatenation",
    src: WRAPPER("return send(res, 500, { ok: false, e2: `${err.message}` });"),
    oldMissed: true,
    newDetects: true,
  },
  {
    name: "(iii) indirection through a helper that forwards the message",
    src: WRAPPER(
      `return send(res, 500, { ok: false, e2: msg(err) });`,
      "function msg(x: unknown): string { return (x as Error).message; }",
    ),
    oldMissed: true,
    newDetects: true,
  },
  {
    name: "(iv) reordered fields in the response object",
    src: WRAPPER(`return send(res, 500, { reason_code: "runner_error", error: err.message, ok: false, capability: "x" });`),
    oldMissed: true,
    newDetects: true,
  },
  {
    name: "(v) a NAMED sanitised verdict must NOT be flagged",
    src: WRAPPER(`return send(res, 403, { ok: false, e2: "login-gated" });`),
    oldMissed: false,
    newDetects: false,
  },
  {
    name: "(vi) the repo's own FIX (capabilityFailure) must NOT be flagged",
    src: WRAPPER(
      `return send(res, 500, { capability, ok: false, error: capabilityFailure(capability, err), reason_code: "runner_error" });`,
      'function capabilityFailure(capability: string, err: unknown): string { void err; return `capability "${capability}" failed inside the runner`; }',
    ),
    oldMissed: false,
    newDetects: false,
  },
  {
    name: "(vii) a message narrowed by a repo-declared Error subclass must NOT be flagged",
    src: WRAPPER(
      `if (err instanceof HttpClientError) return send(res, err.status, { error: { code: err.code, message: err.message } });`,
    ),
    oldMissed: false,
    newDetects: false,
  },
  {
    name: "(viii) a message that had to MATCH a declared table first must NOT be flagged",
    src: WRAPPER(
      `const shape = SHAPE.some((m) => m.re.test(err.message));
       return send(res, shape ? 400 : 500, shape ? { error: { code: "bad_request", message: err.message } } : { error: { code: "internal_error", message: "internal error" } });`,
      "const SHAPE = [{ re: /unknown site /, code: 'unknown_site' }];",
    ),
    oldMissed: false,
    newDetects: false,
  },
];

d("the falsifier matrix: the OLD recogniser missed all four audit spellings, the structural detector does not", () => {
  const OLD = (s: string): number => [...code(s).matchAll(LEAK)].length;

  for (const row of AUDIT_ROWS) {
    t(`${row.name}`, () => {
      const old = OLD(row.src);
      const now = detectRawErrorEchoes(row.src, row.name);
      const detected = now.length > 0;
      if (row.oldMissed) {
        assert.equal(old, 0, "precondition: the OLD one-spelling recogniser really did MISS this variant");
      }
      if (row.newDetects) {
        assert.ok(detected, `the structural detector must catch ${row.name}; it found ${JSON.stringify(now)}`);
      } else {
        assert.deepEqual(now, [], `${row.name} is a legal message and must not be flagged`);
      }
    });
  }

  t("SUMMARY: OLD misses (i)-(iv), OLD correctly clears (v); NEW catches (i)-(iv) and still clears (v)", () => {
    const old = AUDIT_ROWS.map((r) => OLD(r.src));
    const now = AUDIT_ROWS.map((r) => detectRawErrorEchoes(r.src, r.name).length > 0);
    assert.deepEqual(old.slice(0, 4), [0, 0, 0, 0], "the OLD recogniser must be shown missing all four audit spellings");
    assert.equal(old[4], 0, "the OLD recogniser must be shown correctly clearing the named verdict");
    assert.deepEqual(now.slice(0, 4), [true, true, true, true], "the NEW detector must catch all four audit spellings");
    assert.equal(now[4], false, "the NEW detector must still clear the named verdict");
    assert.deepEqual(now.slice(5), [false, false, false], "the NEW detector must clear the repo's own fix and both mapped shapes");
  });

  t("a doc comment quoting the leak cannot satisfy OR break the detector", () => {
    // The reason this is a PARSE and not a wider regex: prose mentioning the
    // shape is neither a hit nor a miss, because prose is not an expression.
    const commented = WRAPPER(
      "return send(res, 500, { ok: false, e2: err.message });",
      "// e.message: this doc comment QUOTES the shape and must not satisfy the gate\n/* ok: false, error: e instanceof Error ? e.message : String(e) */",
    );
    assert.equal(detectRawErrorEchoes(commented, "commented").length, 1, "precondition: the CODE still trips it");
    const proseOnly = WRAPPER(
      'return send(res, 500, { ok: false, e2: "internal error" });',
      "// ok: false, error: e instanceof Error ? e.message : String(e) — quoted in prose only",
    );
    assert.deepEqual(detectRawErrorEchoes(proseOnly, "prose").length, 0, "prose must not be able to satisfy the gate");
  });

  t("the detector's intercession is scoped to helpers THIS file declares", () => {
    // The honest limit, pinned rather than hidden: an imported callee is
    // assumed to sanitise, which is what lets `capabilityFailure()` — the fix —
    // pass. Guessing at a body we cannot read would forbid the fix.
    const imported = WRAPPER(`return send(res, 500, { ok: false, e2: sanitiseFromElsewhere(err) });`);
    assert.deepEqual(detectRawErrorEchoes(imported, "imported").length, 0, "an undeclared callee is out of scope, by design");
    const local = WRAPPER(
      `return send(res, 500, { ok: false, e2: sanitiseFromElsewhere(err) });`,
      "function sanitiseFromElsewhere(x: unknown): string { return (x as Error).message; }",
    );
    assert.ok(detectRawErrorEchoes(local, "local").length > 0, "the SAME helper declared here IS caught");
  });
});

// ────────────── the named OPERATOR diagnostics, inventoried ────────────────
//
// `/health` and `/status` publish internal state on purpose, under a stable
// class label, for the operator. They are NOT answers to a caller and they are
// NOT swept away silently: every one of them is pinned here by label, so a new
// internal-text diagnostic cannot join that class unnoticed. Found and reported,
// not suppressed.

d("the named operator diagnostics are inventoried, not silently excluded", () => {
  const DIAGNOSTICS: Array<{ label: string; shape: RegExp }> = [
    { label: "vault-root-unresolvable", shape: /block\.error = `vault-root-unresolvable: \$\{/ },
    { label: "vault-unreadable", shape: /block\.error = `vault-unreadable: \$\{/ },
    { label: "host-unreadable", shape: /block\.error = block\.error \?\? `host-unreadable:/ },
    { label: "health-vault-probe-threw", shape: /error: `health-vault-probe-threw: \$\{/ },
    { label: "boot warm THREW", shape: /reason: `boot warm THREW \(\$\{msg\}\)/ },
  ];

  for (const dgn of DIAGNOSTICS) {
    t(`${dgn.label} is still published under its label, on the operator surface`, () => {
      assert.match(code(HTTP), dgn.shape, `the ${dgn.label} diagnostic must stay NAMED — an unlabelled raw message is the leak`);
    });
  }

t("every internal-text site in the corpus is accounted for: a pinned label, or a mapped refusal arm", () => {
    // CLOSED WORLD, derived — never a hand-typed total. The previous version of
    // this test asserted `sites.length === 11`, a number I typed from a reading
    // of the file; it failed at 13 the moment the detector's own fixes changed
    // what the regex could see, which is the exact rot this repo's other gates
    // were bitten by. So there is no count here. Instead each internal-text
    // READ is located, and each one must fall inside either a pinned operator
    // diagnostic label or one of the two mapped refusal arms — which are
    // themselves pinned above. A new internal-text read that belongs to neither
    // is reported by name, not absorbed by a number that moved.
    const src = code(HTTP);
    const READ =
      /(?:\b(?:e|err|input\.thrown)\b(?:\s+instanceof Error \?)?\s*(?:\.message\b)?|\bString\((?:e|err|input\.thrown)\))/g;
    const sites: Array<{ line: number; text: string }> = [];
    for (const m of src.matchAll(READ)) {
      const line = src.slice(0, m.index).split("\n").length;
      // `e`/`err` alone is a bare catch variable, not a text read; only count
      // the spellings that actually carry the internal TEXT.
      if (!/\.message|String\(/.test(m[0])) continue;
      sites.push({ line, text: m[0].replace(/\s+/g, " ") });
    }
    assert.ok(sites.length >= 8, `only ${sites.length} internal-text reads located — the scan itself may have rotted`);

    // The regions that are ALLOWED to read internal text, each located by its
    // own anchor rather than by a line number.
    const regions: Array<{ why: string; anchor: RegExp }> = [
      { why: "operator diagnostic: boot warm THREW", anchor: /const msg = input\.thrown instanceof Error \? input\.thrown\.message : String\(input\.thrown\)/ },
      { why: "mapped: an HttpClientError whose message this repo authored", anchor: /send\(res, e\.status, \{ error: \{ code: e\.code, message: e\.message \} \}/ },
      { why: "mapped: the pool refusal CLASSIFIER, which reads the message to name it and returns only a code", anchor: /const msg = e instanceof Error \? e\.message : String\(e\);/ },
      { why: "operator diagnostic: vault-root-unresolvable", anchor: /block\.error = `vault-root-unresolvable: / },
      { why: "operator diagnostic: vault-unreadable", anchor: /block\.error = `vault-unreadable: / },
      { why: "operator diagnostic: host-unreadable", anchor: /block\.error = block\.error \?\? `host-unreadable:/ },
      { why: "operator diagnostic: health-vault-probe-threw", anchor: /error: `health-vault-probe-threw: / },
      { why: "operator diagnostic: boot warm THREW (label)", anchor: /reason: `boot warm THREW \(/ },
      { why: "mapped: the request-shape arm of the internal_error net", anchor: /message: e instanceof Error \? e\.message : String\(e\)/ },
      { why: "mapped: the request-shape CLASSIFIER, which tests the message against SHAPE_MESSAGES and keeps only the code", anchor: /SHAPE_MESSAGES\.some\(\(m\) => m\.re\.test\(e\.message\)\)/ },
      { why: "mapped: the last-resort HttpClientError net", anchor: /send\(res, e\.status, \{ error: \{ code: e\.code, message: e\.message \} \}\);/ },
    ];
    const allowed = regions.map((r) => src.slice(0, src.search(r.anchor)).split("\n").length);
    const uncovered = sites.filter((s) => !allowed.some((a) => Math.abs(a - s.line) <= 1));
    assert.deepEqual(
      uncovered,
      [],
      `internal text reaches the wire from an UNACCOUNTED site: ${JSON.stringify(uncovered)}. Every internal-text read must be a mapped refusal arm or a pinned operator diagnostic.`,
    );
  });
});