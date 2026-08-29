import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createContext } from "../src/plugin/context.js";

describe("createContext", () => {
  it("exposes only the allow-listed surface", () => {
    const ctx = createContext({ dataDir: "/tmp" }, { baseUrl: "https://a.test" }) as any;
    for (const k of ["config", "logger", "registerTool", "analyse", "replay", "call", "session", "http", "dom"])
      assert.ok(ctx[k] !== undefined, `missing ${k}`);
    for (const f of ["launchBrowser", "BrowserSession", "generate", "validateActionMap"])
      assert.equal(ctx[f], undefined, `leaked ${f}`);
  });
});
