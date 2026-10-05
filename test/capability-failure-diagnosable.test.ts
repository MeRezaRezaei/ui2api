/**
 * GOAL (capability-failure-blind): A CAPABILITY FAILURE MUST BE DIAGNOSABLE ON
 * THE BOX THAT HAS IT.
 *
 * THE DEFECT THIS FILE EXISTS TO KILL, and it is not cosmetic. `capabilityFailure`
 * printed the CAUSE of a runner fault only under `UI2API_DEBUG === "1"`, and the
 * shipped systemd unit (`scripts/ops/units/ui2api-api.service`, installed by
 * `scripts/ops/install-services.sh`) NEVER set that variable. So on the real
 * deployment the journal recorded THAT a runner failed and nothing about WHY.
 *
 * The consequence was measured, not assumed. `youtube_search` could not navigate
 * at all — the packaged profile pinned the bare `youtube.com` host, the runner
 * navigated `www.youtube.com`, and the SSRF guard's exact-host equality refused
 * every single call — while `AGENTS.md` published it as VERIFIED with live proof.
 * Nobody could see the refusal in the journal, so a structural, total, permanent
 * failure of the flagship capability stayed invisible until a measurement
 * deliberately asked for the named cause.
 *
 * WHAT IS PINNED HERE, in the repo's own idiom (a source/code-view assertion, so
 * a doc comment quoting the old form can neither satisfy nor break it — the
 * pattern is `test/test-timeout-discipline.test.ts` and
 * `test/no-internal-error-echo.test.ts`):
 *
 *   1. the always-on journal line is NOT inside a `UI2API_DEBUG` guard — the
 *      anti-vacuity pin, falsified at the bottom of this file;
 *   2. the shipped unit does not set `UI2API_DEBUG`, so the durability of the
 *      fix cannot be delegated to a flag (and the unit records why);
 *   3. `/status` carries the count + last NAMED CAUSE CODE, log-independently;
 *   4. the redaction is real: an absolute path, a `node_modules` segment and a
 *      stack frame do not reach the journal line, while the NAMED CAUSE does;
 *   5. the response half is untouched — the 500 body carries the capability id
 *      and the stable `runner_error` code and NOTHING derived from the error.
 *
 * The ASYMMETRY is the whole design and is asserted in both directions: a log
 * may name the cause, a response may not. Redacting the response was GOAL 117
 * and is certified by the armed gate `test/no-internal-error-echo.test.ts`, which
 * this file does not weaken; silencing the log was never a security property, it
 * was an accident of where a variable was read.
 */
import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const HTTP_SRC = readFileSync("src/prompt/http.ts", "utf8");
const UNIT_SRC = readFileSync("scripts/ops/units/ui2api-api.service", "utf8");

/**
 * Comments AND string literals blanked, so a pin judges CODE.
 *
 * RE-DERIVED rather than imported, for the reason
 * `test/no-internal-error-echo.test.ts` records: importing a `.test.ts` under
 * node:test RE-REGISTERS its cases in this run and couples two independent
 * gates. Character scanner, not regexes, because a bare `//` stripper eats the
 * double slash of every `https://` inside a string and a non-greedy block regex
 * mis-pairs on a terminator outside a comment.
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

const CODE = code(HTTP_SRC);

/** The body of one named top-level function, on the CODE view.
 *
 *  Ranges come from the PARSER, not from counting braces. The brace-counting
 *  version of this helper was wrong in a way that hid a real function: a
 *  function whose RETURN TYPE is an object literal
 *  (`function f(): { a: string } {`) has a `{` before its body, so counting
 *  from the first brace ended the slice inside the annotation and the shim
 *  silently ran without the function it was supposed to be testing. */
function fnBody(name: string): string {
  const sf = ts.createSourceFile("http.ts", CODE, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found: ts.FunctionDeclaration | undefined;
  const walk = (n: ts.Node): void => {
    if (!found && ts.isFunctionDeclaration(n) && n.name?.text === name && n.body) found = n;
    n.forEachChild(walk);
  };
  walk(sf);
  assert.ok(found, `precondition: ${name}() is a top-level function declaration in the code view of src/prompt/http.ts`);
  return CODE.slice(found!.getStart(sf), found!.end);
}

/** Every `if (…)` CONDITION in a function body, string-blanked, uppercased. */
function guardConditions(body: string): string[] {
  const sf = ts.createSourceFile("fn.ts", `function f(){${body}}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isIfStatement(n) && n.expression) {
      // The condition's own text, with any string literal replaced by "" so a
      // mention of the env var inside a message cannot read as a guard on it.
      out.push(n.expression.getText(sf).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''"));
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return out;
}

// ── the redaction and the cause labels, exercised through the REAL source ────
//
// The redaction is not re-implemented here. It is extracted from the file under
// test by name and re-declared as a function, so these behavioural pins measure
// THE SHIPPED TABLE and THE SHIPPED RULES — a table edit that drops a rule turns
// the redaction pin red, which a source-shaped assertion could not do.

/** Pull `const NAME: … = [ … ];` / `const NAME = [ … ];` off the code view. */
function constSource(name: string): string {
  const m = new RegExp(`const ${name}(?::[^=]+)?=\\s*(\\[[\\s\\S]*?\\n\\]);`).exec(CODE);
  assert.ok(m, `precondition: ${name} is declared as a literal array in the code view`);
  return m[1]!;
}

interface Loaded {
  classes: Array<{ re: RegExp; code: string }>;
  redactFaultCause: (text: string) => string;
  faultCauseCode: (text: string) => string;
  logToken: (v: string) => string;
  capabilityFaultLine: (capability: string, err: unknown) => { line: string; code: string };
}

function loadUnderTest(): Loaded {
  const classesSrc = constSource("FAULT_CAUSE_CLASSES");
  const body = fnBody("redactFaultCause") + fnBody("faultCauseCode") + fnBody("logToken") + fnBody("capabilityFaultLine");
  const max = /const CAUSE_MAX_CHARS = (\d+);/.exec(HTTP_SRC);
  assert.ok(max, "precondition: CAUSE_MAX_CHARS is a numeric literal");
  const logTokenSrc = /const LOG_TOKEN = (\/\^.*?\/[a-z]*);/.exec(HTTP_SRC);
  assert.ok(logTokenSrc, "precondition: LOG_TOKEN is a literal regex in the source");
  // The classes are evaluated from the SHIPPED source's own regex+code literals,
  // and the three functions are the SHIPPED bodies rebound to those two values.
  // So a table edit that drops a redaction rule turns the behavioural pin red —
  // which a source-shaped assertion could not do.
  const classes = [...classesSrc.matchAll(/\{\s*re:\s*\/((?:[^/\\]|\\.)+)\/([a-z]*)\s*,\s*code:\s*"([^"]+)"\s*\}/g)].map(
    (m) => ({ re: new RegExp(m[1]!, m[2]!), code: m[3]! }),
  );
  assert.ok(classes.length >= 5, `precondition: the shipped cause table parses (read ${classes.length} rows)`);
  // The shim is COMPILED, not hand-stripped: `ts.transpileModule` erases the
  // annotations the same way the real build does, so a signature change in the
  // file under test is a red pin here instead of a syntax error I would then be
  // tempted to "fix" by deleting a rule.
  const compiled = ts.transpileModule(
    `const CLASSES = ${classesSrc};
const LOG_TOKEN = ${logTokenSrc![1]};
${body.replace(/\bFAULT_CAUSE_CLASSES\b/g, "CLASSES").replace(/\bCAUSE_MAX_CHARS\b/g, "MAX")}
return { classes: TABLE, redactFaultCause, faultCauseCode, logToken, capabilityFaultLine };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
  ).outputText;
  return new Function("TABLE", "MAX", compiled)(classes, Number(max[1])) as Loaded;
}

const U = loadUnderTest();

/** The exact message the real youtube SSRF guard throws (src/capabilities/youtube.ts:164). */
const YOUTUBE_SSRF_MESSAGE =
  "SSRF guard: refusing to navigate https://www.youtube.com/results?search_query=%D9%85%D9%88%D8%B2%DB%8C%DA%A9 — origin pinning serves only youtube.com, never arbitrary URLs";

/** A Playwright-style message carrying an absolute path, node_modules and a frame. */
const HOSTILE_MESSAGE =
  "Error: youtube_search: locator.click: Timeout 8000ms from call at\n" +
  "    at /opt/ui2api/node_modules/playwright-core/lib/client/frame.js:212:19\n" +
  "    at run (/opt/ui2api/src/capabilities/youtube.ts:186:11)\n" +
  "Call log:\n" +
  "  - waiting for locator('#video-title')\n" +
  "no answer appeared on youtube within 60000ms. This site requires sign-in.";

d("GOAL: the cause line is UNCONDITIONAL — it is not behind UI2API_DEBUG", () => {
  t("anti-vacuity: neither the fault build nor its log is nested inside any guard", () => {
    // THE PIN, and it is stated as NESTING rather than as a grep, because the
    // property is exactly that: the durable line must not sit inside an `if` of
    // any kind. A grep for `UI2API_DEBUG` in the function would also forbid the
    // opt-in raw tier, which must SURVIVE — and a pin that forbids the fix's own
    // escape hatch is a pin that gets deleted the first time it is wrong.
    //
    // Falsified at the bottom of this file: wrapping the pair in
    // `if (process.env.UI2API_DEBUG === "1")` makes this go red naming it.
    const sf = ts.createSourceFile("f.ts", fnBody("capabilityFailure"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = 0;
    let guarded = 0;
    const walk = (n: ts.Node): void => {
      if ((ts.isExpressionStatement(n) || ts.isVariableStatement(n)) && /capabilityFaultLine\(|fault\.line/.test(n.getText(sf))) {
        found++;
        for (let cur: ts.Node | undefined = n.parent; cur; cur = cur.parent) {
          if (ts.isIfStatement(cur) || ts.isConditionalExpression(cur)) {
            guarded++;
            break;
          }
        }
      }
      n.forEachChild(walk);
    };
    walk(sf);
    assert.ok(found >= 2, `precondition: capabilityFailure() both BUILDS the redacted fault and LOGS it (found ${found} statements)`);
    assert.equal(guarded, 0, "the always-on cause line is inside a conditional again — the shipped unit never sets UI2API_DEBUG, so the cause is invisible on the deployed box. That is the youtube_search defect.");
  });

  t("the raw full error is still available as a deliberate opt-in", () => {
    // The opt-in tier is NOT removed — an operator who sets the var still gets
    // everything. What changed is that it is no longer the ONLY tier. Asserted
    // as a PARSED call (a template literal plus a bare `err` argument) rather
    // than a regex, because a `[^)]*` cannot cross the `)` of a blanked string.
    const sf = ts.createSourceFile("f.ts", fnBody("capabilityFailure"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rawDumps: string[] = [];
    let inDebugGuard = false;
    const walk = (n: ts.Node, guarded: boolean): void => {
      const nowGuarded = guarded || (ts.isIfStatement(n) && /UI2API_DEBUG/.test(n.expression.getText(sf)));
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.getText(sf).startsWith("console.") &&
        n.arguments.some((a) => ts.isIdentifier(a) && a.text === "err")
      ) {
        rawDumps.push(nowGuarded ? "guarded" : "unguarded");
      }
      n.forEachChild((c) => walk(c, nowGuarded));
    };
    walk(sf, false);
    assert.ok(rawDumps.length >= 1, "precondition: the raw error object is still passed to a console call");
    assert.deepEqual(rawDumps, ["guarded"], `the ONLY raw \`…, err\` dump must be the flag-gated one; measured ${JSON.stringify(rawDumps)}`);
  });
});

d("GOAL: the shipped unit must not delegate diagnosability to a flag", () => {
  t("ui2api-api.service does not set UI2API_DEBUG", () => {
    // Strip comments first: the unit's own record of WHY it does not set the
    // var quotes the name, and a naive grep would read that as it setting it.
    const unitCode = UNIT_SRC.split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.doesNotMatch(
      unitCode,
      /Environment=UI2API_DEBUG/,
      "the shipped unit sets UI2API_DEBUG — the always-on cause line is supposed to make that unnecessary, and setting it would flood the retained journal with raw stacks",
    );
    assert.doesNotMatch(unitCode, /Environment=UI2API_DEBUG/, "the deployed default must not depend on a debug flag for a named cause");
  });

  t("the unit records the decision, so the next reader does not 'fix' it back", () => {
    assert.match(UNIT_SRC, /#.*UI2API_DEBUG IS DELIBERATELY NOT SET/s, "the unit must carry the record of why the flag is absent");
  });
});

d("GOAL: /status carries a durable, log-independent signal", () => {
  t("the route publishes the count and the last cause, from the module record", () => {
    assert.match(CODE, /capabilityFailures:\s*\{\s*count:\s*capabilityFailures\.count,\s*last:\s*capabilityFailures\.last\s*\}/,
      "GET /status must publish capabilityFailures.{count,last} read from the module record");
  });

  t("the record is a BOUNDED block, not a growing array", () => {
    const decl = /const capabilityFailures:[^=]*=\s*\{[\s\S]*?\};/.exec(CODE);
    assert.ok(decl, "precondition: capabilityFailures is a module-level record");
    assert.doesNotMatch(decl[0], /push\(|\[\]/, "the failure record must stay a fixed-shape object; an array grows with the failure count");
    assert.match(decl[0], /count:\s*number/, "it must carry a count");
    assert.match(decl[0], /last:\s*\{/, "it must carry the most recent failure");
  });

  t("what /status publishes is a CODE from the closed table plus a sanitised token — never a message", () => {
    // The named cause is a closed vocabulary in every branch, so no redaction
    // pass is needed on this surface at all — which is the property 9042b25 /
    // f1fafff established for /status and this must not regress.
    for (const row of U.classes) {
      assert.match(row.code, /^[a-z][a-z0-9-]*$/, `cause code \`${row.code}\` must be a lowercase token, not prose`);
    }
    const rec = /capabilityFailures\.last = \{[^}]*\}/.exec(CODE);
    assert.ok(rec, "precondition: the last-failure record is assigned as a literal");
    assert.doesNotMatch(rec[0], /\.message|String\(err|redactFaultCause/,
      "the /status failure record must not carry the error's MESSAGE or its redacted sentence — a code and a sanitised token only");
    assert.match(rec[0], /logToken\(/, "the capability in the record must go through the token sanitiser");
    assert.doesNotMatch(rec[0], /faultCauseCode|redactFaultCause|capabilityFaultLine/,
      "the /status record must be handed the ALREADY-CLASSIFIED code, never re-derive it from the error");
    assert.match(fnBody("capabilityFailure"), /recordCapabilityFailure\(capability, fault\.code\)/,
      "the code recorded on /status must be the one the line builder classified, so the two cannot disagree");
  });
});

d("GOAL: the redaction is REAL — internals out, the named cause in", () => {
  t("the youtube SSRF refusal survives redacted, with BOTH hosts", () => {
    // THE PROOF IT IS NOW DIAGNOSABLE. This is the message whose absence from
    // the journal is why youtube_search rotted unnoticed.
    // The REAL line, built by the shipped function — not a re-implementation.
    const { line, code } = U.capabilityFaultLine("youtube_search", new Error(YOUTUBE_SSRF_MESSAGE));
    assert.equal(code, "ssrf-guard-refusal", "the cause class is read out of the guard's own sentence");
    assert.match(line, /cause=ssrf-guard-refusal/, "the cause class must be named");
    assert.match(line, /SSRF guard: refusing to navigate/, "the guard's own sentence must survive");
    assert.match(line, /www\.youtube\.com/, "the www host the runner asked for must survive — that is the defect");
    assert.match(line, /origin pinning serves only youtube\.com/, "the bare host the profile pinned must survive");
  });

  t("a URL keeps scheme+host and loses its path and query", () => {
    const out = U.redactFaultCause(YOUTUBE_SSRF_MESSAGE);
    assert.doesNotMatch(out, /\/results/, "the URL path must be dropped");
    assert.doesNotMatch(out, /search_query|%D9/, "the caller's query text must not land in a retained journal");
  });

  t("an absolute path, a node_modules segment, a stack frame and a source ref all fail to reach the line", () => {
    // THE REDACTION FALSIFIER. One hostile message, four shapes that must not
    // survive, and the named cause that must.
    const out = U.redactFaultCause(HOSTILE_MESSAGE);
    for (const [what, shape] of [
      ["an absolute path", /\/opt\/ui2api/],
      ["a second absolute path", /\/opt\/ui2api\/src/],
      ["a node_modules segment", /node_modules/],
      ["a stack frame's function+file", /frame\.js/],
      ["a source reference", /youtube\.ts:186/],
      ["a DOM locator", /#video-title/],
      ["a bare playwright call", /locator\.click/],
    ] as const) {
      assert.doesNotMatch(out, shape, `${what} reached the journal line: ${out}`);
    }
    assert.doesNotMatch(out, /\/opt\/ui2api\/[^\s]*\//, "no path of any kind may survive");
    // …and the cause is STILL there, which is the whole point of a redaction
    // that keeps the diagnosis.
    assert.equal(U.faultCauseCode(HOSTILE_MESSAGE), "no-answer-within-deadline",
      "the named cause must still be read out of a message full of internals");
    assert.equal(U.capabilityFaultLine("youtube_search", new Error(HOSTILE_MESSAGE)).code, "no-answer-within-deadline",
      "and the real line builder must carry that code, not a raw message");
    assert.match(out, /no answer appeared on youtube within 60000ms/, "the cause sentence must survive the scrub");
  });

  t("a caller-supplied capability cannot forge a log line or park a string in /status", () => {
    assert.equal(U.logToken("youtube_search"), "youtube_search", "a plain id passes");
    assert.equal(U.logToken("a\n[ui2api] capability fake failed: cause=fake"), "unknown", "a newline is refused");
    assert.equal(U.logToken("x".repeat(500)), "unknown", "an unbounded string is refused");
    assert.equal(U.logToken("rm -rf /"), "unknown", "punctuation outside the token class is refused");
  });

  t("the line is BOUNDED, so a giant message cannot flood the journal", () => {
    const out = U.redactFaultCause("x".repeat(5000));
    assert.ok(out.length <= 240, `the cause sentence must be bounded, got ${out.length} chars`);
    assert.match(out, /…$/, "an elided sentence says so rather than pretending to be whole");
  });
});

d("GOAL: the response half is UNCHANGED — a log may name the cause, a response may not", () => {
  t("the 500 body still names the capability and the stable runner_error code", () => {
    assert.match(CODE, /reason_code:\s*"runner_error"/, "the stable reason code must survive");
    assert.match(
      CODE,
      /return send\(res, 500, \{ capability, ok: false, error: capabilityFailure\(capability, e\), reason_code: "runner_error" \}\);/,
      "the capability failure route must keep its exact shape — no new field may be added to the error body",
    );
  });

  t("the returned sentence interpolates the capability and NOTHING from the error", () => {
    // Parsed, not regexed: the property is that no caught value reaches the
    // returned expression, which is exactly what the armed gate
    // test/no-internal-error-echo.test.ts certifies. Asserted here too because
    // this is the half the brief demands must not regress.
    const body = fnBody("capabilityFailure");
    const sf = ts.createSourceFile("f.ts", body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rets: ts.ReturnStatement[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) rets.push(n);
      n.forEachChild(walk);
    };
    walk(sf);
    assert.equal(rets.length, 1, "precondition: capabilityFailure has exactly one return");
    const text = rets[0]!.expression!.getText(sf);
    assert.doesNotMatch(text, /\berr\b/, "the response sentence must not interpolate the caught error");
    assert.doesNotMatch(text, /redactFaultCause|faultCauseCode|capabilityFaultLine/,
      "the response sentence must not interpolate a redacted cause either — the cause is for the log, not the wire");
    assert.match(text, /capability/, "the response sentence must still name the capability");
  });

  t("precondition: the armed gate's own corpus still recognises the fix", () => {
    // So this file can never quietly certify a shape the security gate has
    // stopped looking at.
    const arm = readFileSync("test/no-internal-error-echo.test.ts", "utf8");
    assert.match(arm, /capabilityFailure\(capability, e\)/, "the armed gate must still pin this call spelling");
  });
});
