import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { validateActionMap } from "../src/schema.js";
import { buildActionMap } from "../src/mapper/build.js";
import type { DomInteraction, MethodCall } from "../src/types.js";

describe("schema: network URL must be http(s) or a path", () => {
  it("rejects non-http absolute URLs", () => {
    assert.throws(() =>
      validateActionMap({
        host: "x.test",
        url: "https://x.test/",
        actions: [
          {
            name: "do_thing",
            description: "d",
            execution: "replay",
            parameters: [],
            recipe: { kind: "js-function", target: "App.x", network: { method: "GET", url: "ftp://evil/" } },
            result: { mode: "return" },
          },
        ],
      })
    );
  });

  it("accepts relative and http(s) URLs", () => {
    for (const url of ["/api/x", "https://x.test/api", "http://x.test/a"]) {
      assert.doesNotThrow(() =>
        validateActionMap({
          host: "x.test",
          url: "https://x.test/",
          actions: [
            {
              name: "do_thing",
              description: "d",
              execution: "replay",
              parameters: [],
              recipe: { kind: "js-function", target: "App.x", network: { method: "GET", url } },
              result: { mode: "return" },
            },
          ],
        })
      );
    }
  });

  it("rejects an untrusted host that would escape the sites dir", () => {
    assert.throws(() =>
      validateActionMap({
        host: "../../escape",
        url: "https://x.test/",
        actions: [],
      })
    );
  });
});

describe("build: DOM-discovered actions use dom-interaction recipe kind", () => {
  it("marks a button-driven (network-less) action as dom-interaction", async () => {
    const dom: DomInteraction[] = [
      { selector: "#go", label: "Go", domKind: "click", fields: [], network: null, verified: true },
    ];
    const map = await buildActionMap("x.test", "https://x.test/", [] as MethodCall[], dom, false, false);
    assert.equal(map.actions[0].recipe.kind, "dom-interaction");
    assert.equal(map.actions[0].recipe.target, "#go");
  });

  it("marks a network-bearing DOM action as replay", async () => {
    const dom: DomInteraction[] = [
      {
        selector: "#search",
        label: "Search",
        domKind: "click",
        fields: [],
        network: { method: "POST", url: "https://x.test/api/search", requestBody: "{}" },
        verified: true,
      },
    ];
    const map = await buildActionMap("x.test", "https://x.test/", [] as MethodCall[], dom, false, false);
    assert.equal(map.actions[0].execution, "replay");
  });
});
