import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measureEmitted, parseDocTable, contractGaps } from "./helpers/error-contract-measure.js";
import { DriverRefusal } from "../src/prompt/driver.js";
import { HttpClientError } from "../src/prompt/http.js";
import { redactInternalError, NO_ANSWER_REFUSAL_RE } from "../src/prompt/error-redaction.js";

/**
 * GOAL 91: the daemon's NAMED error codes are a consumer contract, so the
 * shipped doc and the source must agree — in BOTH directions, with the status.
 *
 * This pin MEASURES the emitted set from the source (it is never a hardcoded
 * list of its own) and fails when a code ships undocumented, when the doc
 * names a code the daemon does not emit, or when a status drifts.
 *
 * Proven able to fail: the last block below runs the same checker against a
 * scratch doc that DROPS a code, and asserts it goes red.
 *
 * THE MEASUREMENT LIVES IN `test/helpers/error-contract-measure.ts`, and
 * `test/production-readiness-gate.test.ts` criterion 3.3 calls the SAME
 * functions. It is a helper rather than an import of this file because importing
 * a `.test.ts` under `node --test` RE-REGISTERS its tests inside the importing
 * run; and it is shared rather than duplicated because the defect being fixed
 * was exactly that the two files could disagree — this one ran a real scan
 * while the readiness gate only asserted the scanner's NAME appeared here, so
 * emptying the scanner left the error contract unmeasured and every gate green.
 */

const README = readFileSync("README.md", "utf8");

d("GOAL 91: the daemon's named error contract is documented and machine-pinned", () => {
  t("the emitted set is measured from source and the shipped doc agrees both ways", () => {
  const emitted = measureEmitted();
  const documented = parseDocTable(README);

  // (1) non-vacuity: the measurement must actually FIND codes, or this pin is a green lie.
  assert.ok(emitted.size >= 5, `expected the source measurement to find >=5 named codes, found ${emitted.size}: ${[...emitted.keys()]}`);
  assert.ok(documented.size >= 5, `expected the doc table to carry >=5 codes, found ${documented.size}`);

  // (2) the three pool refusals really are measured, with their 503.
  for (const code of ["pool_saturated", "pool_queue_timeout", "pool_closed"]) {
    assert.equal(emitted.get(code), 503, `${code} must be measured from poolRefusal as a 503`);
  }
  assert.equal(emitted.get("request_timeout"), 504, "request_timeout is the 504 aggregate-deadline refusal");
  assert.equal(emitted.get("not_found"), 404, "not_found is the 404 unknown-endpoint/refused-model refusal");

  // (3) THE CONTRACT: both directions, statuses included.
  assert.deepEqual(contractGaps(emitted, documented), [], "the shipped error contract and the source must agree");
  });
});

d("negative: a doc that drops a code falls RED (the pin CAN fail)", () => {
  t("a doc that drops a code, or invents one, is reported (the pin CAN fail)", () => {
    const emitted = measureEmitted();
    const full = parseDocTable(README);
    assert.deepEqual(contractGaps(emitted, full), [], "precondition: the real doc is green");

    // Drop one row from a scratch copy of the shipped table.
    const scratch = README.replace(/^\|\s*503\s*\|\s*`pool_closed`\s*\|.*$/m, "");
    const dropped = parseDocTable(scratch);
    assert.equal(dropped.has("pool_closed"), false, "the scratch fixture really dropped the row");

    const gaps = contractGaps(emitted, dropped);
    assert.ok(gaps.some((g) => g.includes("pool_closed") && g.includes("documented nowhere")), `dropping a code must be reported, got ${JSON.stringify(gaps)}`);

    // And a doc entry with no code behind it must fall RED too (the other direction).
    const invented = parseDocTable(`${README}\n| 418 | \`teapot\` | nothing emits this | retry forever |\n`);
    assert.ok(
      contractGaps(emitted, invented).some((g) => g.includes("teapot") && g.includes("never emits")),
      "an invented doc entry must be reported",
    );
  });
});

/**
 * A KNOWN driver fault must reach the caller as its NAMED cause.
 *
 * MEASURED BEFORE THIS PIN, on the deployed daemon (`40f6966`, 127.0.0.1:9797),
 * byte-identical requests against the SAME site in the SAME second:
 *
 *   POST /prompt             {"site":"kimi", …} -> 500 {"code":"internal_error",
 *                                                     "message":"internal error"} (63.7s)
 *   POST /v1/chat/completions {"model":"kimi", …} -> 502 {"code":"ui2api_driver_error",
 *                                                     "message":"kimi did not return an answer
 *                                                     within 60000ms — …"} (67.0s)
 *
 * and the daemon's OWN journal for the first of those read `no answer appeared on
 * kimi within 60000ms. This site requires sign-in…`. So the cause was known,
 * named and CORRECT, and the `/prompt` route erased it: an anonymous
 * `internal_error` tells an integrator nothing and sends them hunting a server
 * fault when the truth is a login-gated site. This repo's own rule — no
 * fabricated results, every failure a NAMED verdict — inverted on one route.
 *
 * WHY A TYPE AND NOT A MESSAGE CONVENTION. A caller mistake, a pool refusal and
 * a driver refusal are three different things; a handler that cannot tell them
 * apart can only answer all three the same way, and that is precisely what
 * happened. `src/prompt/driver.ts` now throws `DriverRefusal` for each named
 * readback verdict, and `src/prompt/http.ts` classifies that type — so an
 * UNKNOWN fault still keeps the anonymous 500 and a caller mistake still keeps
 * its 4xx, which the two negatives below pin.
 *
 * WHY THE PROJECTION IS `redactInternalError` AND NOT `e.message`. The raw
 * message can carry an absolute path, a page title or a Playwright diagnostic.
 * A previous lane projected the caught value straight into the body here and
 * `test/no-internal-error-echo.test.ts` went RED — correctly — and that lane
 * reverted rather than weaken another lane's security gate. The safe idiom is
 * CLASSIFY-TO-A-CODE, then PROJECT through the one seam that owns the consumer
 * wording. So this fix reuses `/v1`'s exact seam and `/v1`'s exact code: the two
 * surfaces cannot spell one cause two ways, and no third spelling is invented.
 */
d("a KNOWN driver fault reaches /prompt as its NAMED cause, not an anonymous 500", () => {
  const http = readFileSync("src/prompt/http.ts", "utf8");
  const driver = readFileSync("src/prompt/driver.ts", "utf8");
  const openai = readFileSync("src/prompt/openai.ts", "utf8");

  // The REAL driver message, as the daemon's own journal produced it. Carrying
  // it verbatim is the point: the pin must fail if the driver's wording changes
  // in a way the redaction seam no longer classifies.
  const NO_ANSWER_RAW =
    "no answer appeared on kimi within 60000ms. This site requires sign-in. Sign in to kimi.ai first.";

  t("the driver throws a TYPED refusal for each named readback verdict, and /prompt classifies that type", () => {
    // The named verdicts, each a real refusal the driver already stated. The
    // count is DERIVED from the source, never typed, so a new refusal that
    // forgets the type is visible as a bare `throw new Error(` at a site the
    // class list already names.
    const namedOpenings = [
      "answer-not-an-answer on ",
      "no fresh answer appeared on ",
      "answer-echo on ",
      "no answer appeared on ",
      "newChat reset not verified on ",
      "no composer found on ",
      "page died reading the composer",
    ];
    // DERIVED from the source, not typed: the opening of every TYPED refusal's
    // own message. Matching the throw sites directly (rather than searching for
    // each sentence) is what keeps a doc comment that QUOTES a refusal — the
    // `DriverRefusal` class comment above quotes the kimi sentence verbatim —
    // from being mistaken for the throw.
    const typedOpenings = [...driver.matchAll(/throw new DriverRefusal\(\s*(?:"([^"]*)"|`([^`]*)`)/g)].map(
      (m) => (m[1] ?? m[2] ?? "").slice(0, 40),
    );
    assert.deepEqual(
      typedOpenings.map((o) => (namedOpenings.find((n) => o.startsWith(n)) ?? `UNRECOGNISED: ${o}`)).sort(),
      [...namedOpenings].sort(),
      `every named driver refusal must be thrown as a DriverRefusal, and nothing else may borrow the type. Typed refusals found: ${JSON.stringify(typedOpenings)}`,
    );
    // …and none of them is left as a bare `Error`, which is the defect itself.
    for (const opening of namedOpenings) {
      assert.ok(
        !new RegExp(`throw new Error\\(\\s*(?:"[^"]*"|\`[^\`]*\`)?\\s*,?\\s*\`?${opening.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(driver),
        `the refusal "${opening}" must not remain a bare Error, or a handler cannot tell it from an unknown fault`,
      );
    }

    // And the route must CLASSIFY it — narrowing on the type, not on a message.
    assert.match(
      http,
      /if \(e instanceof DriverRefusal\) \{[\s\S]{0,400}?send\(res, 502, \{[\s\S]{0,200}?code: "ui2api_driver_error"/,
      "/prompt's route catch must answer a DriverRefusal as 502 ui2api_driver_error — the code /v1 already emits",
    );
  });

  t("the two surfaces spell the cause IDENTICALLY: /prompt reuses /v1's code and its redaction seam", () => {
    // No third spelling. Both files name the same code, and the body /prompt
    // builds is produced by the same function /v1's is.
    assert.match(http, /code: "ui2api_driver_error"/, "precondition: /prompt emits the driver code");
    assert.match(openai, /code: "ui2api_driver_error"/, "precondition: /v1 emits the driver code");
    const sites = [...http.matchAll(/error:\s*\{[\s\S]{0,200}?code:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(
      [...new Set(sites.filter((c) => c.includes("driver") || c.includes("error")))].sort(),
      ["internal_error", "ui2api_driver_error"],
      "the driver-fault vocabulary in a caller-facing error envelope must be exactly these two codes — a third spelling would be a second contract",
    );
    // The projection, on both surfaces, is the ONE seam that owns the wording.
    assert.match(
      http,
      /message: redactInternalError\(\s*e,\s*\{ site: requestIdentity\(req, url\)\.site \?\? undefined \}\)/,
      "precondition: /prompt projects the caught value through redactInternalError, naming the site the caller asked for",
    );
  });

  t("RUNTIME: the kimi no-answer fault projects to the SAME named sentence /v1 sends, with the site named", () => {
    const mine = redactInternalError(new DriverRefusal(NO_ANSWER_RAW), { site: "kimi" });
    const v1s = redactInternalError(NO_ANSWER_RAW, { site: "kimi" });
    assert.equal(mine, v1s, "the typed refusal and the raw message must project identically — the type must not change the verdict");
    assert.match(mine, /^kimi did not return an answer within 60000ms — /, `the named verdict must name the site and the measured wait, got: ${mine}`);
    assert.match(mine, NO_ANSWER_REFUSAL_RE, "the projected message must still match the classifier's own matcher for this class");
    // Non-vacuity: the projection is genuinely redaction, not identity.
    assert.notEqual(mine, NO_ANSWER_RAW);
  });

  t("RUNTIME: the projected 502 body leaks no path, no stack frame and no source reference", () => {
    const body = JSON.stringify({
      error: { code: "ui2api_driver_error", message: redactInternalError(new DriverRefusal(NO_ANSWER_RAW), { site: "kimi" }) },
    });
    for (const [what, re] of [
      ["an absolute path", /(^|[^:\w])\/(?:home|opt|usr|var|etc|tmp)\//],
      ["a node_modules reference", /node_modules/],
      ["a stack frame", /(^|\s)at\s+\S+\s+\(/],
      ["a source reference", /\.ts:\d+|\.js:\d+/],
      ["a Playwright diagnostic", /Target page|locator|waitForSelector|getByRole/i],
      ["the raw driver sentence", /This site requires sign-in/],
    ] as const) {
      assert.ok(!re.test(body), `the 502 body must not carry ${what}: ${body}`);
    }
    // THE SLASH THAT DOES SURVIVE, and why it is not a leak. The remediation
    // sentence names `GET /v1/models`, a route on THIS daemon, and that slash is
    // the whole point of the sentence: it tells the caller where to go next. A
    // blanket "no slash" assertion would fail on the honest answer, so the two
    // assertions above are PATH-shaped instead — and this one pins that the only
    // slash in the body is that route, so a path cannot hide beside it.
    const slashes = [...new Set((body.match(/\/[^\s"]*/g) ?? []).map((s) => s.replace(/[.,;:]+$/, "")))].sort();
    assert.deepEqual(slashes, ["/v1/models"], `only the remediation route may carry a slash, found: ${JSON.stringify(slashes)}`);
  });

  t("NEGATIVE: an UNKNOWN fault is not promoted — it keeps the anonymous 500", () => {
    // The classification is a TYPE, so a fault with no known cause cannot reach
    // the 502 arm. This is the falsifier for "the fix turned every fault into a
    // 502 with a message": it did not, and this is the shape that stays put.
    const unknown = new Error("Cannot read properties of undefined (reading 'foo')");
    assert.equal(unknown instanceof DriverRefusal, false, "precondition: a plain Error is not a driver refusal");
    // And the anonymous arm is still IN the catch, AFTER the typed one, at the
    // status the contract documents — so it is reachable, not dead code.
    const armAt = http.indexOf("if (e instanceof DriverRefusal) {");
    const anonAt = http.indexOf('code: "internal_error", message: "internal error"');
    assert.ok(armAt > 0 && anonAt > armAt, "the anonymous 500 must survive after the typed 502 arm, or an unknown fault has nowhere to go");
    const between = http.slice(armAt, anonAt);
    assert.match(between, /^\s*return send\(res, 502/m, "the typed arm must RETURN, so control cannot fall through into the anonymous 500");
    // And the message an unknown fault would project is still sanitised, so if a
    // future change did route it, it could not leak either.
    const projected = redactInternalError(unknown, { site: "kimi" });
    assert.ok(!/\/home\/|\/opt\/|at \w+ \(/.test(projected), `even the projected unknown fault must leak nothing, got: ${projected}`);
  });

  t("NEGATIVE: a caller mistake still gets its 4xx, never this 502", () => {
    // The shape refusals are decided BEFORE any browser work and are answered by
    // their own arms; the typed 502 arm is narrower than all of them, so it
    // cannot swallow one. Pinned by the table, not by a hand-typed list.
    const table = http.slice(http.indexOf("const SHAPE_MESSAGES"), http.indexOf("const isRequestShape"));
    for (const [re, code] of [
      [/unknown site /, "unknown_site"],
      [/no stored account /, "no_stored_account"],
      [/is installed and serves POST \/capability/, "not_chat"],
      [/unknown capability /, "unknown_capability"],
    ] as const) {
      assert.ok(table.includes(re.source), `precondition: ${code} is still a declared shape refusal`);
    }
    // Every one of them is a 400, and none of them is a DriverRefusal.
    assert.match(http, /send\(res, isRequestShape \? 400 : 500,/, "a shape refusal must answer 400 and a non-shape fault 500");
    assert.equal(new HttpClientError(413, "payload_too_large", "x").status, 413, "precondition: a typed client fault keeps its own 4xx status, not this 502");
    assert.equal(new HttpClientError(413, "payload_too_large", "x") instanceof DriverRefusal, false);
  });
});

/**
 * THE SCANNER MUST BE ABLE TO EXPRESS A REAL SERVED CODE.
 *
 * MEASURED DEFECT, not a style nit. The helper harvested the served vocabulary
 * with `[a-z_]+` — LOWERCASE LETTERS AND UNDERSCORE ONLY, no digit. The daemon
 * serves `ui2api_driver_error`, whose `2` sits inside `ui2**2**api`, so:
 *
 *     "code: \"ui2api_driver_error\"".match(/code: "([a-z_]+)"/)  ->  null
 *     /2/.test("ui2api_driver_error")                             ->  true
 *
 * The contract gate was therefore blind to the exact code `POST /prompt` was
 * changed to answer (0169578 / ca7d62c), where it previously erased a KNOWN
 * driver fault into an anonymous `internal_error` 500. A gate that cannot see a
 * code the server actually serves is not measuring the error contract; it is
 * measuring a vocabulary someone typed. Measured BEFORE the fix: the scanner
 * found 16 codes; AFTER: 17, and the one that appeared is
 * `ui2api_driver_error` (502) — the code the previous lane's own write-up
 * flagged as invisible and left unfixed.
 *
 * WHY THIS BLOCK EXISTS RATHER THAN A COUNT. A hand-typed `=== 17` is the same
 * disease one layer down: it is a number someone typed, and it silently rots
 * the moment a code is added or removed. What is pinned here instead is the
 * PROPERTY — (a) the recogniser's own character class can express a digit, a
 * hyphen and an uppercase letter, (b) it still REFUSES a non-code, and (c) the
 * measured vocabulary really does contain a code the old class could not
 * express. Narrow the class back to `[a-z_]+` and this block goes RED on all
 * three, naming the class.
 */
d("the error-code SCANNER can express a code the daemon really serves", () => {
  const HELPER = "test/helpers/error-contract-measure.ts";

  t("THE ONE harvest class is identifier-shaped: a digit, a hyphen and an uppercase in; prose out", () => {
    const helper = readFileSync(HELPER, "utf8");

    // ONE class, shared. The measured defect was a class that could not express a
    // code the daemon serves; the class-per-pattern shape is what let that happen
    // in one place while a sibling pattern (and a sibling test's own private copy,
    // test/error-contract.test.ts:171 `[a-z0-9_]`) already read differently. So the
    // helper declares the class ONCE and every harvest pattern is built from it.
    const declared = /const CODE_CLASS = "([^"]+)"/.exec(helper);
    assert.ok(declared, `precondition: ${HELPER} declares exactly one harvest character class, so a second copy cannot drift`);
    const cls = declared[1]!;
    // …and no pattern may smuggle a private one back in: every code-literal
    // capture in the file must interpolate the shared class.
    const inline = [...helper.matchAll(/new RegExp\(`((?:[^`\\]|\\.)*)`/g)].map((m) => m[1]!);
    assert.ok(inline.length >= 4, `precondition: the envelope, typed-constructor, poolRefusal and doc-table harvests all go through new RegExp, found ${inline.length}`);
    for (const prefix of inline) {
      assert.ok(
        prefix.includes("[${CODE_CLASS}]"),
        `a harvest pattern hard-codes its own character class instead of the shared CODE_CLASS (${prefix}) — a second copy is the measured defect waiting to happen`,
      );
    }
    const literals = helper.match(/"\[([^\]]+)\]\+"/g) ?? [];
    assert.deepEqual(literals, [], `no harvest pattern may carry an inline code class, found ${JSON.stringify(literals)}`);

    const capture = new RegExp(`^([${cls}]+)$`);
    // THE EXPRESSIVENESS PROPERTY. A digit, a hyphen and an uppercase letter are
    // all legal in a code shape this codebase uses — `ui2api_driver_error` (the
    // `2` sits inside `ui2api`) is SERVED on both routes, `vault-probe-threw` is
    // served on `/status`. A class that cannot express one of them cannot measure
    // a code that uses it.
    for (const real of ["ui2api_driver_error", "vault-probe-threw", "NotFound"]) {
      assert.ok(
        capture.test(real),
        `the harvest class [${cls}] cannot express ${JSON.stringify(real)} — a code this codebase really uses is therefore invisible to the gate (the measured defect: /[a-z_]+/ could not see ui2api_driver_error on either route)`,
      );
    }
    // …and it must NOT have been widened into "anything", which would make it
    // vacuous. A space, a dot, a colon, a slash, a quote and the empty string are
    // not code shapes; a scanner that accepts them accepts prose.
    for (const notCode of ["", " ", "internal error", "bad.request", "code: code", "a/b", "x y"]) {
      assert.ok(
        !capture.test(notCode),
        `the harvest class [${cls}] accepts ${JSON.stringify(notCode)} — a widened-to-vacuum scanner is worse than a narrow one`,
      );
    }
    // A star would be the same vacuity wearing a quantifier: one or more, never zero
    // or unbounded, so the capture can never be an empty string.
    assert.ok(!cls.includes("*") && !cls.includes("+"), `the class must be a plain character set with no quantifier, got [${cls}]`);
  });

  t("the MEASURED vocabulary really contains a code the old [a-z_]+ class could not see", () => {
    const emitted = measureEmitted();
    // The fix must be OBSERVABLE: if every measured code still fit `^[a-z_]+$`
    // then this fix changed nothing and the block above is prose.
    const outsideOldClass = [...emitted.keys()].filter((c) => !/^[a-z_]+$/.test(c));
    assert.ok(
      outsideOldClass.includes("ui2api_driver_error"),
      `the served vocabulary must carry a code the old class could not express; found ${JSON.stringify(outsideOldClass)}`,
    );
  });

  t("ui2api_driver_error is MEASURED as a 502, and BOTH routes emit it — this is the pin the old scanner could not hold", () => {
    const emitted = measureEmitted();
    assert.equal(
      emitted.get("ui2api_driver_error"),
      502,
      `ui2api_driver_error must be measured from source with its status; the vocabulary is ${JSON.stringify([...emitted.entries()])}`,
    );
    // …and it must be measured, not merely counted: the code reaches the wire on
    // BOTH surfaces, from BOTH files, and the gate sees one entry because both
    // spell it identically. A third spelling would be a second contract.
    for (const file of ["src/prompt/http.ts", "src/prompt/openai.ts"]) {
      const src = readFileSync(file, "utf8");
      assert.match(
        src,
        /error:\s*\{[\s\S]{0,300}?code:\s*"ui2api_driver_error"/,
        `${file} must answer the driver refusal as {error:{code:"ui2api_driver_error"}} — the envelope the scanner reads`,
      );
    }
    // The two routes agree ON THE CODE and on the STATUS: one vocabulary entry,
    // produced by both files, at 502 on each.
    const sites = ["src/prompt/http.ts", "src/prompt/openai.ts"].map((f) => {
      const src = readFileSync(f, "utf8");
      const i = src.indexOf('code: "ui2api_driver_error"');
      const before = src.slice(Math.max(0, i - 400), i);
      const st = [...before.matchAll(/send(?:Json)?\(\s*(?:res|w)\s*,\s*(\d{3})/g)];
      return Number(st[st.length - 1]![1]);
    });
    assert.deepEqual(sites, [502, 502], `/prompt and /v1 must answer ui2api_driver_error at the SAME status, measured ${JSON.stringify(sites)}`);
    // And the shipped doc names it, with that status — the bidirectional check.
    assert.equal(parseDocTable(readFileSync("README.md", "utf8")).get("ui2api_driver_error"), 502, "the doc table must carry ui2api_driver_error at 502");
    assert.deepEqual(contractGaps(emitted, parseDocTable(readFileSync("README.md", "utf8"))), [], "doc and source must agree on every code, including the one that was invisible");
  });
});
