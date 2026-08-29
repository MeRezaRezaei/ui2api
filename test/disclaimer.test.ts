import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("disclaimer", () => {
  it("README has a Responsibility section", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf8");
    assert.ok(/## Responsibility/i.test(readme), "README missing ## Responsibility");
    assert.ok(/use (it )?at your own risk/i.test(readme), "README missing use-at-own-risk language");
    assert.ok(/respect.*(terms of service|ToS)/i.test(readme), "README missing respect-ToS language");
  });
  it("generated server template prints a responsibility notice", () => {
    const tpl = readFileSync(resolve(ROOT, "src/generator/generate.ts"), "utf8");
    assert.ok(/use.*at your own risk/i.test(tpl), "server template missing responsibility notice");
  });
});
