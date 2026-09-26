import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * GOAL 105: the project's ABSOLUTE rule is no fabricated traffic — never
 * synthesize a request that could look foreign to the site's anti-bot stack.
 * The `replay` execution mode broke it: `page.request.fetch(...)` is
 * Playwright's OUT-OF-PAGE APIRequestContext, so no page JS ran, no page-origin
 * window.fetch was used, and the body was the RECORDED payload with a hardcoded
 * content-type. A comment even claimed it "carries the page's session cookies",
 * which is not what APIRequestContext does.
 *
 * These pins make a synthesized out-of-page call impossible to reintroduce.
 */

const SEAMS = ["src/runtime/browser-session.ts", "src/plugin/context.ts"];
const read = (f: string) => readFileSync(f, "utf8");
/** Comments are stripped: a pin must forbid the CALL, not the word in prose. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

d("GOAL 105: no execution path fabricates site traffic", () => {
  t("no seam issues a request through an out-of-page APIRequestContext", () => {
    for (const f of SEAMS) {
      const c = code(f);
      assert.ok(!/\.request\.fetch\(/.test(c), `${f} must not use page.request.fetch — that is a synthesized out-of-page request`);
      assert.ok(!/APIRequestContext/.test(c), `${f} must not construct an out-of-page APIRequestContext`);
    }
  });

  t("replay goes through the SITE'S OWN fetch, inside the page", () => {
    const bs = code("src/runtime/browser-session.ts");
    const pc = code("src/plugin/context.ts");
    for (const [name, src] of [["browser-session", bs], ["plugin context", pc]] as const) {
      assert.match(src, /window\.fetch\(/, `${name}: the request must be the page's own fetch`);
      assert.match(src, /credentials:\s*"include"/, `${name}: it must carry the page's real credentials`);
      assert.match(src, /\.evaluate\(/, `${name}: it must run inside the page, not outside it`);
    }
  });

  t("the same-origin guard still protects the replay target", () => {
    // removing the synthesize must not remove the SSRF guard that came with it
    assert.match(code("src/runtime/browser-session.ts"), /sameOrigin\(resolved, this\.map\.url\)/, "the replay SSRF guard must remain");
    assert.match(code("src/plugin/context.ts"), /sameOrigin\(resolved, deps\.baseUrl\)/, "the plugin replay SSRF guard must remain");
  });

  t("a GET/HEAD never carries a body or a forced content-type", () => {
    for (const f of SEAMS) {
      assert.match(code(f), /a\.method !== "GET" && a\.method !== "HEAD"/, `${f} must not attach a body to GET/HEAD`);
    }
  });

  t("negative: the OLD synthesized shape is required to be caught (mutation proof)", () => {
    // Reproduce the old call and require the SAME predicates to reject it.
    const old = 'const resp = await this.page.request.fetch(resolved, { method: "POST", data: net.requestBody, headers: { "content-type": "application/json" } });';
    assert.ok(/\.request\.fetch\(/.test(old), "precondition: the old shape uses page.request.fetch");
    assert.ok(!/window\.fetch\(/.test(old), "precondition: the old shape never uses the page's own fetch");
    // the pin's own predicates must reject it
    assert.ok(!/\.request\.fetch\(/.test(old.replace(/\.request\.fetch\(/, "")), "removing the call must clear the first predicate");
  });
});
