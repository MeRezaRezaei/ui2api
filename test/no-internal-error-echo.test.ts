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

// ── GOAL 240 · THE NAMED VERDICTS, AND WHY THEY ARE NO LONGER EXEMPT ────────
//
// The previous version of this file INVENTORIED five sites that publish
// internal text on `/health` + `/status` and declared them out of scope, on the
// reasoning that the operator surface exists to report internal state. That
// reasoning was half right and it hid a real defect.
//
// THE JUDGMENT, which is the whole point of this section: a NAMED LABEL IS NOT
// A SANITISED VALUE. `vault-unreadable` IS an honest, actionable verdict — the
// operator learns their vault path is wrong, and suppressing that would make
// `/health` decoration. But each of those five sites built its VALUE by
// interpolating `e.message`, so the named verdict arrived wearing the thrown
// text: node's fs layer reports `EACCES: permission denied, scandir
// '/home/<user>/.config/…'`, and a page-open failure reports an absolute profile
// path. `/health` and `/status` are readable by ANY process on the box, and by
// anything on a wider bind — the same threat model the daemon's own
// `internal_error` arm already refuses at the request net, where it logs the
// full fault and sends a bare code.
//
// So the labels STAY (pinned below, by their new shape) and the VALUES became
// NAMED CODES. The errno IS the diagnosis: `EACCES` and `ENOTDIR` are exactly
// what an operator acts on, and they are a closed token vocabulary with no path
// and no sentence in them. The rule is "no RAW internals", not "no detail".
const POOL = readFileSync("src/prompt/pool.ts", "utf8");
const BOTH = `${HTTP}\n${POOL}`;
const { probeFaultNote } = await import("../src/prompt/pool.js");

d("the named operator verdicts are still published, as NAMED CODES", () => {
  // Each shape pins the NEW form. The label is what an operator reads and it
  // must never be replaced by an unlabelled message — that is the leak this
  // file exists to prevent — but a label BESIDE a raw `e.message` is the same
  // leak wearing a name, so the value is pinned to a named code too.
  const VERDICTS: Array<{ label: string; src: string; shape: RegExp }> = [
    { label: "vault-root-unresolvable", src: HTTP, shape: /block\.error = \{ code: "vault-root-unresolvable", detail: fault\.detail \}/ },
    { label: "vault-unreadable", src: HTTP, shape: /block\.error = \{ code: "vault-unreadable", detail: fault\.detail \}/ },
    { label: "host-unreadable", src: HTTP, shape: /block\.error = block\.error \?\? \{ code: "host-unreadable", detail: probeFault\(e\)\.detail, host: d\.name \}/ },
    { label: "vault-probe-threw", src: HTTP, shape: /error: \{ code: "vault-probe-threw", detail: fault\.detail \}/ },
    { label: "boot warm THREW", src: HTTP, shape: /reason: `boot warm THREW \$\{fault\}/ },
    { label: "liveness probe threw", src: POOL, shape: /reason: `liveness probe threw \$\{probeFaultNote\(e\)\}/ },
    { label: "warm outcome cause", src: POOL, shape: /out\.reason = probeFaultNote\(e\)/ },
  ];

  for (const v of VERDICTS) {
    t(`${v.label} is published under its label, as a NAMED CODE`, () => {
      assert.match(code(v.src), v.shape, `the ${v.label} verdict must stay NAMED — an unlabelled raw message is the leak`);
    });
  }

  t("no named verdict interpolates a raw e.message beside its label", () => {
    // The falsifier that matters most, because it is the OLD shape. The pins
    // above cannot be the whole guarantee on their own: a site could be ADDED
    // with a raw value and a matching pin. This asks the question directly, in
    // the neighbourhood of each verdict, so the answer does not depend on the
    // pin list staying complete.
    for (const v of VERDICTS) {
      const around = code(v.src);
      const at = around.search(v.shape);
      assert.notEqual(at, -1, `pin for ${v.label} must resolve before its neighbourhood can be judged`);
      const window = around.split("\n").slice(Math.max(0, at - 3), at + 4).join("\n");
      assert.doesNotMatch(
        window,
        /(?:\.message\b|String\()/,
        `${v.label} publishes a raw Error.message beside its named code — the label is the verdict, the value must be a code`,
      );
    }
  });
});

// ── THE INVARIANT: no /health or /status field may carry RAW internals ──────
//
// Spelled structurally (a parse + a taint walk, not a regex over spellings), for
// the reason this file's own header records: a recogniser pinned to one spelling
// of a common idiom is not a gate. It asks ONE question of every value that can
// reach an operator-surface payload — is it derived from a caught exception's own
// text? `probeFault` is the ONE legal way to read a caught value onto these
// surfaces, and it is legal precisely because it returns a closed token
// vocabulary rather than the message.

/** The files that build the `/health` + `/status` payloads. */
const OPERATOR_SURFACES: Array<{ file: string; src: string }> = [
  { file: "src/prompt/http.ts", src: HTTP },
  { file: "src/prompt/pool.ts", src: POOL },
];

/** The declarations that construct an operator-surface value. Located by ANCHOR
 *  rather than by line range, so a re-flow cannot silently move a payload out of
 *  the check — the failure mode a line-numbered region list has, and the one
 *  this file's own header already records as the shape of the GOAL 117 defect. */
const OPERATOR_ANCHORS: Array<{ why: string; anchor: RegExp }> = [
  { why: "healthVaultBlock builds /health's vault block", anchor: /export function healthVaultBlock\(/ },
  { why: "bootWarmBlock builds /health + /status's bootWarm block", anchor: /export function bootWarmBlock\(/ },
  { why: "livenessBlock builds /status + /health's liveness block", anchor: /function livenessBlock\(/ },
  { why: "the /status route assembles the response", anchor: /req\.url === "\/status"/ },
  { why: "the /health route assembles the response", anchor: /req\.url === "\/health"/ },
  { why: "ChatPool.status assembles the pool block on both surfaces", anchor: /get status\(\): PoolStatus \{/ },
  { why: "probeBrowser produces pool.browserProbe, republished on both surfaces", anchor: /probeBrowser\(\): BrowserProbe \{/ },
  { why: "ChatPool.warm produces bootWarm.outcome.reason on both surfaces", anchor: /async warm\(\): Promise<WarmOutcome> \{/ },
];

/**
 * Every value in `src` that carries raw internal text and reaches an
 * operator-surface payload — i.e. a leak the invariant must report.
 *
 * Deliberately ASYMMETRIC about what counts as a leak: a named code, a measured
 * number, an enum and a fixed constant are all legal, and detection fires only
 * on a value derived from a caught exception's own text. That asymmetry is the
 * false-positive guard — falsifier (c) below proves a named code stays clean
 * while a seeded raw value is caught in the same shape.
 */
function detectRawInternalsOnOperatorSurfaces(src: string, file: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
  const found: string[] = [];
  const lines = src.split("\n");

  for (const anchor of OPERATOR_ANCHORS) {
    const start = src.search(anchor.anchor);
    if (start < 0) continue; // the anchor is pinned by its own test below

    // Walk the whole file once per anchor, keeping only nodes at/after `start`
    // and inside the anchored declaration. Scoping by declaration rather than by
    // line count is what makes the region survive an edit that adds lines.
    let decl: ts.Node | undefined;
    (function walk(n: ts.Node): void {
      if (!decl && n.getStart(sf) === start) decl = n;
      if (!decl) n.forEachChild(walk);
    })(sf);
    if (!decl) continue;

    const tainted = new Set<string>();
    const reads: Array<{ line: number; text: string }> = [];
    // One pass, in source order, so a `catch` binding is known before the reads
    // below it are judged. A backward pass would be the same for these shapes
    // but would stop deriving the file from the order it is actually written in.
    (function scoped(n: ts.Node): void {
      if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
        tainted.add(n.variableDeclaration.name.text);
      }
      if (ts.isPropertyAccessExpression(n) && (n.name.text === "message" || n.name.text === "stack")) {
        const root = n.expression;
        if (ts.isIdentifier(root) && tainted.has(root.text)) {
          reads.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf) });
        }
      }
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "String" &&
        n.arguments[0] &&
        ts.isIdentifier(n.arguments[0]) &&
        tainted.has(n.arguments[0].text)
      ) {
        reads.push({ line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: n.getText(sf) });
      }
      n.forEachChild(scoped);
    })(decl);

    for (const r of reads) {
      // THE ONE LEGAL READER: a caught value handed to the redaction seam. The
      // exemption names the FUNCTION, not a shape, and the seam's own closed
      // return vocabulary is pinned separately below — so widening the seam
      // turns every call site red rather than silently legal.
      if ((lines[r.line - 1] ?? "").includes("probeFault")) continue;
      found.push(`${file}:${r.line} ${anchor.why} — ${r.text}`);
    }
  }
  return found;
}

d("no /health or /status field may carry a raw Error.message, an absolute path, or a stack line", () => {
  for (const { file, src } of OPERATOR_SURFACES) {
    t(`${file}: every operator-surface value is a named code, not raw internal text`, () => {
      const leaks = detectRawInternalsOnOperatorSurfaces(src, file);
      assert.deepEqual(
        leaks,
        [],
        `raw internal text reaches an operator-surface payload: ${JSON.stringify(leaks, null, 2)}. A named label is not a sanitised value — publish the code, keep the label.`,
      );
    });
  }

  t("every operator-surface anchor still resolves — the region list cannot rot silently", () => {
    // A region list that silently matches nothing is a gate that passes on an
    // empty set, which is the vacuous-gate failure this file already records for
    // a deleted real field. So the anchors are counted against the source.
    const missing = OPERATOR_ANCHORS.filter((a) => !BOTH.search(a.anchor)).map((a) => a.why);
    assert.deepEqual(missing, [], `an operator-surface anchor no longer resolves: ${JSON.stringify(missing)}`);
  });

  t("probeFault's RETURN values are closed tokens — it may read a message, never return one", () => {
    // The exemption above is only safe while this holds. Pinned on the SHAPE of
    // every RETURN (allow-list tokens, a matched token, or null), never on a
    // hand-typed total that could drift.
    //
    // This arm DOES read `err.message` — deliberately, to recover an errno token
    // that Playwright and node's net layer put there instead of on `code` (a
    // plain `Error("connect ECONNREFUSED 127.0.0.1:9222")` has no `code`). What
    // is forbidden is RETURNING one, and that is what is checked here: every
    // return is either a fixed token, the result of a bounded match, or null.
    const body = code(POOL);
    const fn = /export function probeFault\([\s\S]*?\n\}/.exec(body)?.[0] ?? "";
    assert.ok(fn.length > 0, "probeFault must exist for the operator surfaces to have a legal reader");
    const returns = [...fn.matchAll(/return \{ code: "(\w+)", detail: ([^}]*) \};/g)].map((m) => ({ code: m[1], detail: m[2]!.trim() }));
    assert.ok(returns.length >= 4, `probeFault has ${returns.length} return arms — the check itself may have rotted`);
    for (const r of returns) {
      assert.ok(
        ["errno", "type", "unknown"].includes(r.code),
        `probeFault returned an unlisted code "${r.code}" — the vocabulary is closed, so a new arm must be a deliberate one`,
      );
      assert.ok(
        /^(fault\.detail|errno|inMessage\[1\]|ctor|null)$/.test(r.detail) || r.detail === "null",
        `probeFault's ${r.code} arm returns "${r.detail}" — only a fixed token, a bounded match, or null may leave this function`,
      );
    }
    assert.match(fn, /ERRNO\.test\(errno\)/, "the errno-code arm must be an ALLOW-LIST test, so naming a fault never means maintaining a list of every way the OS can fail");
    assert.match(fn, /NAMED_CLASSES\.has\(ctor\)/, "the class arm must be an ALLOW-LIST test, derived from the prototype and not from a field a thrower controls");
    assert.match(fn, /ERRNO_IN_MESSAGE\.exec\(err\.message\)/, "the in-message errno arm must go through the bounded token match, and publish inMessage[1] — never the whole message");
  });

  t("probeFault classifies every real throw class — 'named code' is measured, not claimed", () => {
    // Driven through the REAL function, not a re-implementation: a re-derived
    // copy would keep passing after the shipped seam broke.
    const cases: Array<{ thrown: unknown; expect: string; why: string }> = [
      {
        thrown: Object.assign(new Error("EACCES: permission denied, scandir '/home/me/.config/x'"), { code: "EACCES" }),
        expect: "(errno:EACCES)",
        why: "an OS errno survives as the token — the diagnosis, without the path",
      },
      { thrown: Object.assign(new Error("nope"), { code: "ENOTDIR" }), expect: "(errno:ENOTDIR)", why: "every errno, not a fixed list" },
      { thrown: new TypeError("Cannot read properties of undefined (reading 'foo')"), expect: "(type:TypeError)", why: "a named error CLASS is a code; its sentence is not" },
      { thrown: new RangeError("x"), expect: "(type:RangeError)", why: "the class arm is a closed set, and RangeError is in it" },
      { thrown: new Error("a sentence with /home/me/secret in it"), expect: "(unknown)", why: "an unclassifiable throw is named UNKNOWN — honest, and never a summary that reads like a cause" },
      { thrown: "a bare string throw", expect: "(unknown)", why: "a non-Error throw carries no class and no errno; it gets a name, not its text" },
    ];
    for (const c of cases) {
      assert.equal(probeFaultNote(c.thrown), c.expect, c.why);
    }
  });

  t("THE FALSIFIER MATRIX: a seeded leak is caught, a named code is not, prose is neither", () => {
    // (a) a probe throws with an ABSOLUTE PATH in its message → caught.
    const pathLeak = `
      export function healthVaultBlock(x: string): { error: unknown } {
        const out: { error: unknown } = { error: null };
        try {
          out.error = { code: "vault-unreadable", detail: readIt(x) };
        } catch (e) {
          out.error = \`vault-unreadable: \${e instanceof Error ? e.message : String(e)}\`;
        }
        return out;
      }
      function readIt(x: string): string { throw new Error("EACCES: permission denied, scandir '/home/me/.config/ui2api/sessions'"); }
    `;
    assert.ok(
      detectRawInternalsOnOperatorSurfaces(pathLeak, "falsifier-a.ts").length > 0,
      "a probe that interpolates the thrown message must be reported, even when the message carries an absolute path",
    );

    // (b) a probe throws a TypeError whose message is the classic one → caught.
    const typeLeak = `
      export function healthVaultBlock(x: string): { error: unknown } {
        const out: { error: unknown } = { error: null };
        try {
          out.error = { code: "vault-unreadable", detail: readIt(x) };
        } catch (e) {
          out.error = \`vault-unreadable: \${e.message}\`;
        }
        return out;
      }
      function readIt(x: string): string { throw new TypeError("Cannot read properties of undefined (reading 'foo')"); }
    `;
    assert.ok(
      detectRawInternalsOnOperatorSurfaces(typeLeak, "falsifier-b.ts").length > 0,
      "a .message read beside a named label is a leak whatever the message says",
    );

    // (c) THE FALSE-POSITIVE GUARD. A named code is legal — this is the
    // assertion that keeps the invariant from decaying into "no detail on
    // /health", which would make /health useless to the operator.
    const namedCode = `
      export function healthVaultBlock(x: string): { error: unknown } {
        const out: { error: unknown } = { error: null };
        try {
          out.error = { code: "vault-unreadable", detail: readIt(x) };
        } catch (e) {
          out.error = { code: "vault-root-unresolvable", detail: probeFault(e).detail };
        }
        return out;
      }
      function readIt(x: string): string { throw new Error("EACCES"); }
      export function probeFault(e: unknown): { detail: string | null } { return { detail: (e as { code?: string })?.code ?? null }; }
    `;
    assert.deepEqual(
      detectRawInternalsOnOperatorSurfaces(namedCode, "falsifier-c.ts"),
      [],
      "a named code beside a named label is EXACTLY the shape this invariant requires — it must never be flagged",
    );

    // (d) THE PROSE TRAP. A doc comment quoting a path and an `e.message` must
    // NEITHER satisfy NOR break the check. `test/install-host-containment.test.ts`
    // was actually bitten by this class, so it is asserted rather than assumed.
    const proseTrap = `
      /**
       * Historically this read \`e.message\` and so published
       * "EACCES: permission denied, open '/home/me/.config/ui2api-chrome/Default'"
       * on /health — see the GOAL 240 seam.
       */
      export function healthVaultBlock(x: string): { error: unknown } {
        const out: { error: unknown } = { error: null };
        try {
          out.error = { code: "vault-unreadable", detail: readIt(x) };
        } catch (e) {
          out.error = { code: "vault-root-unresolvable", detail: probeFault(e).detail };
        }
        return out;
      }
      function readIt(x: string): string { throw new Error("EACCES"); }
      export function probeFault(e: unknown): { detail: string | null } { return { detail: (e as { code?: string })?.code ?? null }; }
    `;
    assert.deepEqual(
      detectRawInternalsOnOperatorSurfaces(code(proseTrap), "falsifier-d.ts"),
      [],
      "a doc comment quoting a path and an e.message must NOT manufacture a finding — the check judges code, not prose",
    );
    // …and the mirror, which is the half that actually bit that file: the same
    // comment must not SATISFY the check and hide a real leak sitting below it.
    const proseTrapHidingALeak = proseTrap.replace("detail: probeFault(e).detail", "detail: e.message");
    assert.ok(
      detectRawInternalsOnOperatorSurfaces(code(proseTrapHidingALeak), "falsifier-d2.ts").length > 0,
      "a doc comment must not SATISFY the check and hide a real leak sitting right below it",
    );
  });
});

t("every internal-text site in the corpus is accounted for: a mapped refusal arm, or the one redaction reader", () => {
  // CLOSED WORLD, derived — never a hand-typed total. The previous version of
  // this test asserted `sites.length >= 8`, a number typed from a reading of the
  // file; it failed the moment GOAL 240 legitimately REMOVED reads, which is the
  // exact rot this repo's other gates were bitten by. So there is no floor here
  // either. Instead each internal-text READ is located, and each one must fall
  // inside either a mapped refusal arm or the one redaction reader — so a new
  // read is reported by NAME rather than absorbed by a count that moved.
  const src = code(BOTH);
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

  // The regions that are ALLOWED to read internal text, each located by its own
  // anchor rather than by a line number.
  const regions: Array<{ why: string; anchor: RegExp }> = [
    { why: "mapped: an HttpClientError whose message this repo authored", anchor: /send\(res, e\.status, \{ error: \{ code: e\.code, message: e\.message \} \}/ },
    { why: "mapped: the pool refusal CLASSIFIER, which reads the message to name it and returns only a code", anchor: /const msg = e instanceof Error \? e\.message : String\(e\);/ },
    { why: "mapped: the request-shape arm of the internal_error net", anchor: /message: e instanceof Error \? e\.message : String\(e\)/ },
    { why: "mapped: the request-shape CLASSIFIER, which tests the message against SHAPE_MESSAGES and keeps only the code", anchor: /SHAPE_MESSAGES\.some\(\(m\) => m\.re\.test\(e\.message\)\)/ },
    { why: "mapped: the last-resort HttpClientError net", anchor: /send\(res, e\.status, \{ error: \{ code: e\.code, message: e\.message \} \}\);/ },
    { why: "internal-only, never published: the pool's retry CLASSIFIER, which tests the message for a restriction wall and returns only a boolean", anchor: /const msg = e instanceof Error \? e\.message : String\(e\);\n\s*const blocked =/ },
    { why: "internal-only, never published: a thrown non-Error rewrapped as an Error so the waiter can be settled with an Error", anchor: /\(e\) => this\.settleWaiter\(waiter, e instanceof Error \? e : new Error\(String\(e\)\)\)/ },
    { why: "internal-only, never published: the same rewrap on the queue-deadline re-acquire path", anchor: /\(e\) => this\.settleWaiter\(waiting, e instanceof Error \? e : new Error\(String\(e\)\)/ },
    { why: "the redaction seam itself: reads a message to recover a BOUNDED errno TOKEN, returns only the token (pinned separately above)", anchor: /ERRNO_IN_MESSAGE\.exec\(err\.message\)/ },
    // ── ADDED BY GOAL (capability-failure-blind) — ONE row, and it is an
    // EXTENSION, not a relaxation. The gate's rule is unchanged and still
    // absolute: every read of internal exception text must be an accounted
    // region. What was added is a capability failure's ONE read, and it was
    // deliberately collapsed from two to one before this row was written — the
    // cause CLASSIFIER takes the text rather than the thrown value precisely so
    // that this file reads a caught message exactly once on that path, and so
    // the widening below is one anchored row rather than two.
    //
    // WHY IT IS SAFE, stated so a reviewer can refuse it if they disagree: the
    // read happens in `capabilityFaultLine`, whose return value is a string it
    // BUILDS — the input is put through `redactFaultCause` (paths, node_modules,
    // stack frames, source refs, DOM selectors and a URL's path+query all
    // removed) and through `faultCauseCode` (a closed token vocabulary) before
    // anything is returned, and the result reaches exactly two sinks: a
    // `console.error` on stderr, and `/status`'s `capabilityFailures.cause`,
    // which carries the CODE only. Neither is a response body, and the response
    // half of the same function still interpolates the capability id and nothing
    // else — the pin below (`the returned sentence interpolates the capability
    // and NOTHING from the error`) is the structural half of that claim, and
    // test/capability-failure-diagnosable.test.ts is the behavioural half.
    { why: "internal-only, never published: the capability-failure JOURNAL line, which reads the message once and returns a redacted, bounded line plus a closed-vocabulary cause code (neither reaches a response body)", anchor: /const text = err instanceof Error \? err\.message : typeof err === "string" \? err : String\(err \?\? ""\);/ },
  ];
  const allowed = regions
    .filter((r) => r.anchor.test(src))
    .map((r) => src.slice(0, src.search(r.anchor)).split("\n").length);
  // The ONE legal reader: a caught value handed to the redaction seam. Derived
  // from the corpus rather than hand-listed, so a new call site needs no edit.
  const legal = [...src.matchAll(/probeFault(?:Note)?\(/g)].map((m) => src.slice(0, m.index).split("\n").length);

  const uncovered = sites.filter((s) => [...allowed, ...legal].every((a) => Math.abs(a - s.line) > 1));
  assert.deepEqual(
    uncovered,
    [],
    `internal text reaches the wire from an UNACCOUNTED site: ${JSON.stringify(uncovered)}. Every internal-text read must be a mapped refusal arm or the one redaction reader.`,
  );
});
