import { validateActionMap } from "../src/schema.js";
import { strict as assert } from "node:assert";
import { describe as d } from "node:test";
d("schema accepts trusted flag", () => {
  const m = validateActionMap({ host: "h", url: "https://h", capturedAt: new Date().toISOString(), trusted: false, auth: { required: false }, actions: [
    { name: "a", description: "a", execution: "replay", parameters: [], recipe: { kind: "js-function", target: "x", argsFrom: {} }, result: { mode: "return" }, verified: true },
  ] });
  assert.equal(m.trusted, false);
});
