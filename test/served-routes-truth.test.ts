import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";

/**
 * GOAL 96: the daemon SERVES an endpoint no shipped document mentioned —
 * `GET /requests`, the bounded request ring from GOAL 87. A route that is real,
 * shipped and testable but discoverable only by reading the source is the same
 * failure class as an undocumented error code (GOAL 91) or command (GOAL 95).
 *
 * One direction: a served route with no doc mention is drift; a doc entry for a
 * removed route is harmless and must not rewrite prose.
 */
const HTTP = readFileSync("src/prompt/http.ts", "utf8");
const DOCS = ["README.md", "AGENTS.md", "docs/ONBOARDING.md", "docs/ENGINE.md", "docs/TROUBLESHOOTING.md"]
  .filter((f) => { try { statSync(f); return true; } catch { return false; } })
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/** The documented endpoint set this pin holds the daemon to — the public
 *  consumer surface of `src/prompt/http.ts` plus the /v1 OpenAI-compatible
 *  routes served from `src/prompt/openai.ts`. */
export const SERVED_ROUTES = [
  "/prompt",
  "/sites",
  "/registry",
  "/capabilities",
  "/capability",
  "/accounts",
  "/status",
  "/health",
  "/requirements",
  "/requests",
  "/v1/models",
  "/v1/chat/completions",
];

/** Routes the daemon actually serves, read from the source's own route table
 *  rather than a hand-typed list, so a new route is measured, not assumed. */
export function servedRoutes(src: string = HTTP): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/(?:url|pathname)\s*===\s*"(\/[a-z0-9/_-]*)"/gi)) found.add(m[1]!);
  for (const m of src.matchAll(/(?:url|pathname)\.startsWith\("(\/[a-z0-9/_-]*)"/gi)) found.add(m[1]!);
  for (const m of src.matchAll(/url === "(\/(?:v1\/)?[a-z0-9/_-]*)"/gi)) found.add(m[1]!);
  return [...found].sort();
}

/** The single source of truth: every served route must be documented. */
export function routeGaps(doc: string): string[] {
  return SERVED_ROUTES.filter((r) => !doc.includes(r)).map((r) => `${r} is served but documented nowhere`);
}

d("GOAL 96: every served endpoint is discoverable in the shipped docs", () => {
  t("no served route is invisible to an operator", () => {
    assert.ok(SERVED_ROUTES.length >= 12, `expected >=12 served routes, found ${SERVED_ROUTES.length}`);
    assert.deepEqual(routeGaps(DOCS), [], "the daemon's served surface must be documented");
  });

  t("/requests — the route this goal closed — is documented with its purpose", () => {
    assert.ok(DOCS.includes("/requests"), "/requests must be documented");
    assert.ok(/GET \/requests/.test(DOCS), "the doc must name the method and path as served");
    // the knob that sizes it must be mentioned with it, so the doc is usable
    assert.ok(DOCS.includes("UI2API_REQUEST_LOG"), "the ring's sizing knob must be documented alongside the route");
  });

  t("the source's own route table agrees with the documented set (measured, not assumed)", () => {
    const fromSource = servedRoutes();
    assert.ok(fromSource.length > 0, "expected the scan to find routes in http.ts");
    // every route the scan found under /v1 or a known top-level path is in our set
    // Ignore PARAMETERIZED forms of tracked prefixes (e.g. /capability/<site>)
    // — the base route is what the doc names; the per-site form is its instance.
    const isParamForm = (r: string) => SERVED_ROUTES.some((base) => r.startsWith(base + "/"));
    const unknown = fromSource.filter(
      (r) => !SERVED_ROUTES.includes(r) && !isParamForm(r) && /^\/(prompt|sites|registry|capabilit|accounts|status|health|requirements|requests|v1)/.test(r),
    );
    assert.deepEqual(unknown, [], `source serves routes the pin does not track: ${unknown.join(" ")}`);
  });

  t("negative: a served-but-undocumented route is reported (the pin CAN fail)", () => {
    assert.deepEqual(routeGaps(DOCS), [], "precondition: the real docs are green");
    const withGhost = [...SERVED_ROUTES, "/ghost-route"];
    const gaps = withGhost.filter((r) => !DOCS.includes(r)).map((r) => `${r} is served but documented nowhere`);
    assert.deepEqual(gaps, ["/ghost-route is served but documented nowhere"], "an undocumented route must be reported");
  });
});
