import { validateActionMap } from "../src/schema.js";
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

const action = {
  name: "a",
  description: "a",
  execution: "replay" as const,
  parameters: [],
  recipe: { kind: "js-function" as const, target: "x", argsFrom: {} },
  result: { mode: "return" as const },
  verified: true,
};

describe("schema trusted flag", () => {
  test("an explicit trusted:false survives validation as false", () => {
    const m = validateActionMap({
      host: "h",
      url: "https://h",
      capturedAt: new Date().toISOString(),
      trusted: false,
      auth: { required: false },
      actions: [action],
    });
    assert.equal(m.trusted, false);
  });

  test("an explicit trusted:true survives validation as true", () => {
    const m = validateActionMap({
      host: "h",
      url: "https://h",
      capturedAt: new Date().toISOString(),
      trusted: true,
      auth: { required: false },
      actions: [action],
    });
    assert.equal(m.trusted, true);
  });

  test("an ABSENT trusted flag is coerced to false (untrusted by default)", () => {
    const m = validateActionMap({
      host: "h",
      url: "https://h",
      capturedAt: new Date().toISOString(),
      auth: { required: false },
      actions: [action],
    });
    assert.equal(m.trusted, false);
  });
});
