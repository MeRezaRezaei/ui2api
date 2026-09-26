import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { redactRequestBody, redactActionMap } from "../src/runtime/redact.js";
import { validatePublishedModule } from "../src/hub/module-gate.js";

/**
 * GOAL 125: the analyzer recorded every captured request body VERBATIM, and
 * `analyse` runs immediately after an interactive `--login` in the same flow —
 * so the action map written to disk is the LOGGED-IN one. That map is then
 * copied into the generated server, `PUT` to the hub, and with `--mirror` pushed
 * to a public registry. MEASURED: `sites/<host>/action-map.json` was NOT
 * gitignored, so a captured session token reached the git index too.
 *
 * Redaction is a NAMED marker, never a silent deletion, and a body with no
 * credential must pass through BYTE-IDENTICAL — a redactor that mangles
 * everything is a different bug, not a fix.
 */

const SECRET_MAP = {
  host: "example.test",
  url: "https://example.test",
  capturedAt: "2026-09-26T00:00:00.000Z",
  actions: [
    {
      name: "send_prompt",
      execution: "replay",
      parameters: [],
      recipe: { kind: "network", network: { method: "POST", url: "/api/chat", requestBody: '{"access_token":"sk-abcdefghijklmnop","q":"hello"}' } },
    },
  ],
};
const CLEAN_MAP = JSON.parse(JSON.stringify(SECRET_MAP));
CLEAN_MAP.actions[0].recipe.network.requestBody = '{"q":"hello"}';

d("GOAL 125: a captured credential never reaches disk, a generated server, or a package", () => {
  t("a credential-bearing body is redacted with a NAMED marker", () => {
    const r = redactRequestBody('{"access_token":"sk-abcdefghijklmnop","q":"hello"}');
    assert.equal(r.changed, true);
    assert.match(String(r.body), /\[redacted:access_token\]/, "the marker must NAME the field it removed");
    assert.ok(!String(r.body).includes("sk-abcdefghijklmnop"), "the secret must be gone");
    assert.match(String(r.body), /"q":"hello"/, "the non-credential field must survive");
    assert.deepEqual(r.hits, ["access_token"]);
  });

  t("a CLEAN body passes through BYTE-IDENTICAL", () => {
    const body = '{"q":"hello","n":3,"nested":{"deep":[1,2]}}';
    const r = redactRequestBody(body);
    assert.equal(r.changed, false);
    assert.equal(r.body, body, "a clean JSON body must not be reformatted, reordered, or mangled");
  });

  t("bearer / JWT / api-key shaped values are caught even under an innocent key", () => {
    for (const [body, why] of [
      ['{"auth":"Bearer abc123def456"}', "bearer header value"],
      ['{"note":"eyJhbGciOi.eyJzdWIiOi.SflKxwRJ"}', "JWT value under a non-credential key"],
      ['{"x":"sk-abcdefghijklmnopqrst"}', "api-key shape"],
    ] as const) {
      const r = redactRequestBody(body);
      assert.equal(r.changed, true, `${why} must be redacted`);
    }
  });

  t("form-encoded bodies are redacted too", () => {
    const r = redactRequestBody("q=hello&access_token=supersecret&page=2");
    assert.equal(r.changed, true);
    assert.ok(!String(r.body).includes("supersecret"), "the secret must be gone from a form body");
    assert.match(String(r.body), /q=hello/, "the innocent field must survive");
    assert.match(String(r.body), /page=2/, "and so must the other one");
  });

  t("an ABSENT or non-JSON body is left completely alone", () => {
    for (const b of ["", undefined, "not json at all", "plain text"]) {
      const r = redactRequestBody(b as any);
      assert.equal(r.changed, false, `${JSON.stringify(b)} must be untouched`);
      assert.equal(r.body, b);
    }
  });

  t("the whole action map is redacted at its network recipes", () => {
    const { map, hits } = redactActionMap(SECRET_MAP);
    const written = JSON.stringify(map);
    assert.ok(!written.includes("sk-abcdefghijklmnop"), "the action map must not carry the secret");
    assert.ok(written.includes("[redacted:access_token]"), "and must show the named marker");
    assert.deepEqual(hits, ["access_token"]);
  });

  t("the PUBLISH seam REFUSES a map carrying credentials, by name", () => {
    const verdict = validatePublishedModule(JSON.stringify(SECRET_MAP));
    assert.ok(verdict, "publishing a credential-bearing map must be refused");
    assert.match(verdict!, /credentials-in-action-map/, "with the named verdict");
    assert.match(verdict!, /access_token/, "naming the offending field");
  });

  t("a CLEAN map still publishes (the gate is not a blanket ban)", () => {
    // give it a loadable module body so the shape gate passes
    const clean = JSON.stringify(CLEAN_MAP);
    const verdict = validatePublishedModule(`export default ${clean}`);
    assert.ok(
      verdict === null || !/credentials-in-action-map/.test(verdict),
      `a clean map must not be refused for credentials, got: ${verdict}`,
    );
  });

  t("the WRITE seams actually call the redactor", () => {
    for (const f of ["src/cli.ts", "src/generator/generate.ts"]) {
      const src = readFileSync(f, "utf8");
      assert.match(src, /redactActionMap\(/, `${f} must redact the action map it writes`);
    }
    const gate = readFileSync("src/hub/module-gate.ts", "utf8");
    assert.match(gate, /credentialsInActionMap\(/, "the publish gate must inspect content");
  });

  t("the action map is gitignored (the backstop behind redaction)", () => {
    // bounded: a hang here would hang the whole suite (GOAL 102)
    const out = execFileSync("git", ["check-ignore", "-v", "sites/somehost/action-map.json"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.match(out, /action-map\.json/, "the per-site action map must be gitignored");
  });

  t("negative: the OLD behaviour is required to be the failure (mutation proof)", () => {
    // old: write the map verbatim
    const writtenOld = JSON.stringify(SECRET_MAP);
    assert.ok(writtenOld.includes("sk-abcdefghijklmnop"), "precondition: the old write shipped the secret verbatim");
    // and the old gate saw nothing, because a shape gate cannot read a value
    const shapeOnly = (m: unknown) => (m && typeof m === "object" && "actions" in (m as any) ? null : "bad shape");
    assert.equal(shapeOnly(JSON.parse(writtenOld)), null, "precondition: the shape gate passed a credential-bearing map");
    // the new behaviour refuses
    assert.match(validatePublishedModule(writtenOld) ?? "", /credentials-in-action-map/);
  });
});
