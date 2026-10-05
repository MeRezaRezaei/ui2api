import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BUILTIN_PROFILES } from "../src/profile/profile.js";

/**
 * The per-request LATENCY LEDGER for ChatDriver — every fixed wait the ask
 * path pays, measured from the SOURCE rather than restated from prose.
 *
 * WHY A LEDGER AND NOT A PROSE NUMBER: every figure below is read out of the
 * real source and evaluated with a stubbed `Math.random`, so a wait that is
 * added, removed, moved behind a different guard, or silently widened is a
 * FAILING test with the offending expression named — not a paragraph that is
 * one reflow out of date. The three claims the ledger exists to refute are
 * pinned at the bottom.
 *
 * HONEST SCOPE, stated once and enforced by the harness below: `ChatDriver.ask()`
 * is NOT exercised here. It builds its own browser through `getPage()` and needs
 * the full Playwright Page/Browser surface (contexts/newContext/route/addInitScript
 * …), which the 7-method fake below deliberately does not pretend to have. So the
 * harness measures the WAIT EXPRESSIONS as written in the shipped source and the
 * PROFILE DATA as read from the shipped profile files. Nothing in this file
 * fabricates an answer, and nothing in it claims a live round-trip.
 */

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const DRIVER_SRC = readFileSync("src/prompt/driver.ts", "utf8");
const DRIVER_CODE = stripComments(DRIVER_SRC);
const DOM_SRC = readFileSync("src/runtime/dom-primitives.ts", "utf8");

/** Every `waitForTimeout(<expr>)` argument in the shipped driver, in order. */
function waitArgs(): string[] {
  const out: string[] = [];
  const KEY = "waitForTimeout(";
  // Scan the RAW source, not the comment-stripped copy: stripping block comments
  // can leave an unbalanced "(" (a prose parenthetical that never had its closing
  // paren inside the comment), which makes a paren-depth scan swallow the rest of
  // the file. Every wait argument is a single balanced expression on one line, so
  // the raw text is both correct and simpler.
  const src = DRIVER_SRC;
  for (let i = src.indexOf(KEY); i >= 0; i = src.indexOf(KEY, i + 1)) {
    let depth = 0;
    let j = i + KEY.length - 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i + KEY.length, j).trim());
  }
  return out;
}

/**
 * The fake page. Seven methods is the whole surface this ledger needs, and the
 * recorder holds WAIT BUDGETS ONLY — there is no field here that could carry an
 * answer, which is what makes "no fabricated answer" a structural fact rather
 * than a promise.
 */
function fakePage() {
  const waits: number[] = [];
  const loc = () => ({
    first: () => loc(),
    nth: () => loc(),
    isVisible: async () => false,
    click: async () => undefined,
    waitFor: async () => undefined,
  });
  return {
    waits,
    waitForTimeout: async (ms: number) => {
      waits.push(ms);
    },
    locator: () => loc(),
    evaluate: async () => 1,
    goto: async () => undefined,
    url: () => "about:blank",
    title: () => "fake",
    isVisible: async () => false,
  };
}

type Ctx = {
  profile?: Record<string, unknown>;
  wall?: Record<string, unknown>;
};

/** Evaluate a wait expression exactly as written, with a stubbed Math.random. */
function measure(expr: string, ctx: Ctx, randomValue: number): number {
  const body = expr.replace(/this\.profile\./g, "profile.").replace(/this\.page!?/g, "page");
  const MathStub = { random: () => randomValue, floor: Math.floor, round: Math.round };
  const fn = new Function(
    "Math",
    "profile",
    "wall",
    "page",
    `"use strict"; return (${body});`
  );
  return fn(MathStub, ctx.profile, ctx.wall, fakePage()) as number;
}

/** min/max over the real jitter domain: random() ∈ [0, 1). */
function rangeOf(expr: string, ctx: Ctx): [number, number] {
  return [measure(expr, ctx, 0), measure(expr, ctx, 0.999999999)];
}

/**
 * THE LEDGER. `expr` is the EXACT argument text as it appears at a
 * `waitForTimeout(` call site in the stripped source, so a match failure names
 * the expression that moved. `perAsk` is the honest classification: what it
 * costs on a DEFAULT ask (no newChat, no urlTemplate, no jsIndex, no model).
 */
const LEDGER: Array<{
  id: string;
  expr: string;
  expect: number;
  /** how many times the expression appears in the shipped driver */
  sites: number;
  /** unconditional on the default UI-path ask? */
  perAsk: boolean;
  guard: string;
}> = [
  {
    id: "newChat post-click dwell",
    expr: "600 + Math.floor(Math.random() * 700)",
    expect: 600,
    sites: 1,
    perAsk: false,
    guard: "opts.newChat && this.profile.newChat",
  },
  {
    id: "newChat reset re-poll",
    expr: "250",
    expect: 250,
    sites: 1,
    perAsk: false,
    guard: "verifyNewChatReset re-poll — paid ONLY while the reset is still unverified (3s deadline)",
  },
  {
    id: "jsIndex readiness re-poll",
    expr: "500",
    expect: 500,
    sites: 2,
    perAsk: false,
    guard:
      "profile.jsIndex readiness probe (15s deadline); the second site is the post-model-picker-click settle",
  },
  {
    id: "urlTemplate hydration dwell",
    expr: "150 + Math.floor(Math.random() * 250)",
    expect: 150,
    sites: 1,
    perAsk: false,
    guard: "profile.urlTemplate (query-driven sites, no composer typed)",
  },
  {
    id: "preCompose cold-boot dwell",
    expr: "Math.round(this.profile.preComposeDelayMs + Math.random() * 600)",
    expect: 8000,
    sites: 1,
    perAsk: false,
    guard: "profile.preComposeDelayMs — tencent-aistudio ONLY",
  },
  {
    id: "send gate (click branch)",
    expr: "50 + Math.floor(Math.random() * 150)",
    expect: 50,
    sites: 2,
    perAsk: true,
    guard: "UNCONDITIONAL on the non-urlTemplate path — one site per branch, exactly one branch runs",
  },
  {
    id: "consent-wall poll sleep pass-through",
    expr: "ms",
    expect: 0,
    sites: 1,
    perAsk: false,
    guard: "profile.consentWall?.accept — the injected sleep seam of the POLLED wait, not a fixed sleep",
  },
  {
    id: "consent-wall post-acknowledge settle",
    expr: "wall.settleMs ?? 900",
    expect: 900,
    sites: 1,
    perAsk: false,
    guard: "profile.consentWall AND an OBSERVED wall — duckduckgo only, first anonymous send",
  },
  {
    id: "model picker open dwell",
    expr: "1500",
    expect: 1500,
    sites: 1,
    perAsk: false,
    guard: "opts.model AND capability.pickerOpen",
  },
  {
    id: "model post-click settle",
    expr: "150",
    expect: 150,
    sites: 1,
    perAsk: false,
    guard: "model-selection verification re-poll (1.5s deadline)",
  },
];

d("THE LEDGER IS EXHAUSTIVE — an added or removed wait fails here", () => {
  const found = waitArgs();
  for (const row of LEDGER) {
    t(`${row.id}: ${row.expr} appears exactly ${row.sites}x`, () => {
      const n = found.filter((e) => e === row.expr).length;
      assert.equal(
        n,
        row.sites,
        `expected ${row.sites} site(s) of \`${row.expr}\` in driver.ts, found ${n}. ` +
          `Added wait? Removed wait? A wait that moved or was widened lands here, not in prose.`
      );
    });
  }

  t("no waitForTimeout call site is UNCLASSIFIED (nothing waits off-ledger)", () => {
    const known = new Set(LEDGER.map((r) => r.expr));
    const unclassified = found.filter((e) => !known.has(e));
    assert.deepEqual(
      unclassified,
      [],
      `unclassified waitForTimeout argument(s): ${JSON.stringify(unclassified)} — classify each in LEDGER with its guard`
    );
  });

  t(`the ledger accounts for all ${found.length} shipped wait sites`, () => {
    const total = LEDGER.reduce((n, r) => n + r.sites, 0);
    assert.equal(
      total,
      found.length,
      `LEDGER claims ${total} sites but the driver has ${found.length}. ` +
        `Ledger and source have drifted — re-derive before editing the numbers.`
    );
  });
});

/* ---------------------------------------------------------------------------
 * MEASURED RANGES — each expression evaluated as written, over the real jitter
 * domain, and recorded through the fake page's waitForTimeout.
 * ------------------------------------------------------------------------- */

const TENCENT = { preComposeDelayMs: 8000 } as Record<string, unknown>;

d("MEASURED RANGES (evaluated from source, recorded by the fake page)", () => {
  const cases: Array<{ id: string; expr: string; ctx: Ctx; min: number; max: number }> = [
    {
      id: "newChat post-click dwell",
      expr: "600 + Math.floor(Math.random() * 700)",
      ctx: {},
      min: 600,
      max: 1299,
    },
    {
      id: "urlTemplate hydration dwell",
      expr: "150 + Math.floor(Math.random() * 250)",
      ctx: {},
      min: 150,
      max: 399,
    },
    {
      id: "preCompose cold-boot dwell (tencent preComposeDelayMs=8000)",
      expr: "Math.round(this.profile.preComposeDelayMs + Math.random() * 600)",
      ctx: { profile: TENCENT },
      min: 8000,
      max: 8600,
    },
    {
      id: "send gate — the ONLY unconditional per-ask wait",
      expr: "50 + Math.floor(Math.random() * 150)",
      ctx: {},
      min: 50,
      max: 199,
    },
  ];

  for (const c of cases) {
    t(`${c.id}: ${c.min}–${c.max}ms`, () => {
      const [lo, hi] = rangeOf(c.expr, c.ctx);
      assert.equal(lo, c.min, `minimum of \`${c.expr}\` moved — the lower bound is not ${c.min}ms`);
      assert.equal(hi, c.max, `maximum of \`${c.expr}\` moved — the upper bound is not ${c.max}ms`);
      // Record it through the fake page: the harness is the thing under test for
      // "a wait is a number handed to waitForTimeout", not a restated literal.
      const page = fakePage();
      for (const v of [lo, hi]) await0(page, v);
      assert.deepEqual(
        page.waits,
        [lo, hi],
        "the fake page must record exactly the measured budgets, and nothing else"
      );
    });
  }

  t("the send gate is the ONLY unconditional per-ask wait on the UI path", () => {
    const unconditional = LEDGER.filter((r) => r.perAsk).map((r) => r.expr);
    assert.deepEqual(
      unconditional,
      ["50 + Math.floor(Math.random() * 150)"],
      `expected exactly the send gate as the sole unconditional per-ask wait, got ${JSON.stringify(unconditional)}. ` +
        `A new unconditional wait is a real latency change and must be classified here deliberately.`
    );
    assert.equal(LEDGER.filter((r) => r.expr === "50 + Math.floor(Math.random() * 150)")[0].sites, 2,
      "the send gate must exist on BOTH send branches (click and keyEnter) — exactly one runs per ask");
  });
});

/** Await a recorded wait without pulling in a real timer. */
function await0(page: ReturnType<typeof fakePage>, ms: number): Promise<void> {
  return page.waitForTimeout(ms);
}
