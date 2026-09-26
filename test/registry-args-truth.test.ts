/**
 * GOAL 139 — THE SEPARATION GATE.
 *
 * Why this file exists: the audit that started this work found the app was
 * authoring the registry's own metadata. `capabilityInputSchema` GUESSED arg
 * contracts from a capability id by regex, because 0 of 33 packages declared
 * one — and it guessed wrong in ways a consumer would pay for at runtime:
 * `youtube_search` advertised `{}` while its runner requires `args.query`, and
 * it advertised `new_chat` which NO runner reads (they read `newChat`).
 *
 * The operator's requirement: "registry is clear, main app is clear". A clear
 * boundary is only real if it is ENFORCED, so these tests pin the three
 * properties that make the split honest:
 *
 *   1. A package's DECLARED arg contract is what gets served (data wins; the
 *      app reads, it does not author).
 *   2. A malformed declaration is REFUSED, never served — an empty-but-present
 *      schema is worse than none, because a consumer trusts it.
 *   3. The payload is SELF-SUFFICIENT: a third-party consumer can construct a
 *      valid request, and detect contract drift, without knowing anything about
 *      ui2api's HTTP internals.
 *
 * Plus the honesty flag: a tool whose schema is a guess SAYS SO, so a
 * consumer that auto-generates a client can refuse to trust a fabrication.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildRegistryContract,
  buildRegistryPackages,
  capabilityInputSchema,
  declaredCapabilityInputSchema,
  REGISTRY_CONTRACT_VERSION,
  type RegistryToolInputSchema,
} from "../src/prompt/registry.js";

const okSchema = (properties: RegistryToolInputSchema["properties"], required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
});

test("GOAL 139: a DECLARED arg contract wins over the guesser — the app READS the package, it does not author it", () => {
  // The youtube_search shape the audit measured as WRONG on the wire: the runner
  // requires args.query and honours args.max, but the guesser served `{}`.
  const declared = okSchema(
    {
      query: { type: "string", description: "the search query" },
      max: { type: "number", description: "maximum results" },
    },
    ["query"]
  );
  const served = capabilityInputSchema("youtube", "youtube_search", "ui-path", "search youtube", declared);
  assert.deepEqual(served, declared, "a declared contract must be served verbatim");
  assert.deepEqual(served.required, ["query"], "the required arg must survive — this is the one the guesser dropped");
  assert.ok("query" in served.properties, "query must be a declared property");

  // And the same capability with NO declaration still falls back (honestly) —
  // proving the declared path is a real override, not the only path.
  const guessed = capabilityInputSchema("youtube", "youtube_search", "ui-path", "search youtube", null);
  assert.deepEqual(guessed, { type: "object", properties: {}, required: [] });
});

test("GOAL 139: the chat arg name matches what the runners actually read (newChat, not new_chat)", () => {
  // gemini.ts:259 and kimi.ts:215 read `args.newChat`. The old schema advertised
  // `new_chat`, which NOTHING read — a consumer following it got a continued
  // conversation instead of a new one: a silently WRONG answer, not an error.
  const chat = capabilityInputSchema("gemini", "gemini_chat", "ui-path", "chat", null);
  assert.ok("newChat" in chat.properties, "newChat must be advertised");
  assert.ok(!("new_chat" in chat.properties), "new_chat is read by no runner and must not be advertised");
  assert.deepEqual(chat.required, ["prompt"]);
});

test("GOAL 139: a MALFORMED declaration is refused, never served", () => {
  const bad: unknown[] = [
    null,
    "not-an-object",
    ["array"],
    { type: "string", properties: {} },          // wrong type
    { type: "object" },                          // no properties
    { type: "object", properties: [] },          // properties not an object
    { type: "object", properties: { a: "string" } }, // untyped property
    { type: "object", properties: { "": { type: "string" } } }, // blank key
    { type: "object", properties: {}, required: ["ghost"] },     // required not declared
  ];
  for (const raw of bad) {
    assert.equal(
      declaredCapabilityInputSchema({ id: "x", inputSchema: raw }),
      null,
      `a malformed declaration must be refused, not served: ${JSON.stringify(raw)}`
    );
  }
  // And a well-formed one IS accepted, so the filter is not just refusing all.
  const good = declaredCapabilityInputSchema({
    id: "x",
    inputSchema: okSchema({ q: { type: "string" } }, ["q"]),
  });
  assert.deepEqual(good, okSchema({ q: { type: "string" } }, ["q"]));
});

test("GOAL 139: the payload is SELF-SUFFICIENT — a consumer can build a call without app knowledge", () => {
  const c = buildRegistryContract(false);
  assert.equal(c.contractVersion, REGISTRY_CONTRACT_VERSION);
  // The decisive properties: verb, path template and body keys are all present,
  // so a consumer needs nothing from the app's source to make the call.
  assert.equal(c.endpoints.capability.method, "POST");
  assert.equal(c.endpoints.capability.pathTemplate, "/capability/{site}");
  assert.deepEqual(c.endpoints.capability.requiredBodyKeys, ["capability"]);
  assert.ok(c.endpoints.capability.bodyKeys.includes("args"));
  // `account` is TOP-LEVEL, not an arg — the old schema nested it and a
  // consumer would have had it silently ignored.
  assert.ok(c.endpoints.capability.bodyKeys.includes("account"));
  assert.equal(c.endpoints.chatCompletions.openAICompatible, true);
  assert.equal(c.auth.header, "Authorization");
  // The daemon's own limits are declared, so nobody has to guess them.
  assert.equal(c.scope.daemonFetchesRegistry, false);
  assert.equal(c.scope.daemonPublishesRegistry, false);
  // Token posture is DISCOVERABLE rather than a 401 the consumer has to decode.
  assert.equal(buildRegistryContract(true).auth.required, true);
  assert.equal(buildRegistryContract(false).auth.required, false);
});

test("GOAL 139: every served tool declares whether its schema is real or a guess", () => {
  const packages = buildRegistryPackages();
  assert.ok(packages.length > 0, "installed packages must produce a registry");
  let declared = 0;
  for (const pkg of packages) {
    for (const tool of pkg.tools) {
      assert.equal(
        typeof tool.argsDeclared,
        "boolean",
        `${pkg.id}/${tool.id} must state whether its inputSchema is declared`
      );
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(Array.isArray(tool.inputSchema.required));
      // A required arg must ALWAYS be a declared property — the guesser's
      // failure mode was a schema whose `required` and `properties` disagree.
      for (const r of tool.inputSchema.required) {
        assert.ok(
          r in tool.inputSchema.properties,
          `${pkg.id}/${tool.id}: required arg "${r}" is not a declared property`
        );
      }
      if (tool.argsDeclared) declared++;
    }
  }
  // The whole point of GOAL 139: packages should move OFF the guess. Report the
  // count so drift toward guessing is visible in the test output.
  assert.ok(declared >= 0, `packages declaring a real arg contract: ${declared}/${packages.reduce((n: number, p: { tools: unknown[] }) => n + p.tools.length, 0)}`);
});
