import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RegistryStore, assertSafePackageSegment } from "../src/hub/store.js";

/**
 * GOAL 121: the hub's `RegistryStore.save` had NO path-containment gate on the
 * attacker-supplied `manifest.name` / `manifest.version` (the install seam got
 * one in GOAL 113; the hub never had one). PROVEN over the wire against a real
 * started hub with a real bearer token, before this fix:
 *
 *   name:"../../ESCAPED-DATA-DIR"  -> landed OUTSIDE dataDir
 *   name:"../ESCAPED-PKGS-SUBTREE" -> landed outside the pkgs/ root
 *   version:"/etc/passwd"          -> resolved ABSOLUTE (EACCES only because
 *                                     this box is unprivileged)
 *   name:"..", version:"registry"  -> CLOBBERED registry.json, after which every
 *                                     later publish died with an UNHANDLED
 *                                     TypeError — permanently, across restarts
 *
 * Everything here runs in a self-created temp dir. No real store is touched.
 */

const scratch = () => mkdtempSync(join(tmpdir(), "g121-"));
const VALID_MANIFEST = { name: "ok", version: "1.0.0", id: "ok" };
const MODULE = "export const x = 1;";

d("GOAL 121: the hub store writes only inside pkgs/, and never kills the process", () => {
  t("a legitimate publish still works", () => {
    const dir = scratch();
    const store = new RegistryStore(dir);
    store.save("ok", "1.0.0", VALID_MANIFEST, MODULE);
    assert.ok(existsSync(join(dir, "pkgs", "ok", "1.0.0.json")), "a normal package must still install");
    assert.equal(store.get("ok")?.manifest.id, "ok", "and be readable back");
    rmSync(dir, { recursive: true, force: true });
  });

  t("traversal, absolute and directory-reference names are REFUSED by name", () => {
    const hostile: [string, unknown][] = [
      ["name", "../../ESCAPED-DATA-DIR"],
      ["name", "../ESCAPED-PKGS-SUBTREE"],
      ["name", ".."],
      ["name", "."],
      ["name", "a/b"],
      ["name", "a\\b"],
      ["version", "/etc/passwd"],
      ["version", "../x"],
      ["version", ".."],
    ];
    for (const [field, value] of hostile) {
      assert.throws(
        () => assertSafePackageSegment(field, value),
        new RegExp(`invalid package ${field}`),
        `${field}=${JSON.stringify(value)} must be refused, naming the field`,
      );
    }
  });

  t("the refusals cover EXACTLY the cases proven over the wire", () => {
    const dir = scratch();
    const store = new RegistryStore(dir);
    const before = readdirSync(join(dir, "pkgs"));
    // the two-step index-overwrite attack, replayed
    assert.throws(() => store.save("..", "registry", VALID_MANIFEST, MODULE), /invalid package name/);
    // and the dataDir escape
    assert.throws(() => store.save("../../ESCAPED", "1.0.0", VALID_MANIFEST, MODULE), /invalid package name/);
    // nothing landed anywhere
    assert.deepEqual(readdirSync(join(dir, "pkgs")), before, "a refused publish must write nothing under pkgs/");
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes("ESCAPED")), [], "and nothing outside it either");
    // the index is intact and the store is still usable
    assert.deepEqual(store.readIndex().packages, {}, "the index must NOT be poisoned");
    store.save("later", "1.0.0", VALID_MANIFEST, MODULE);
    assert.ok(store.get("later"), "a publish AFTER two refusals must still succeed — the hub stays serving");
    rmSync(dir, { recursive: true, force: true });
  });

  t("a valid-JSON NON-index can never be served as the index (no poisoning)", () => {
    const dir = scratch();
    const store = new RegistryStore(dir);
    // a package payload clobbered over registry.json — valid JSON, wrong shape
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ manifest: {}, module: "" }));
    const idx = store.readIndex();
    assert.deepEqual(idx.packages, {}, "a wrong-shaped index must read as empty, not as the payload");
    // and saving still works rather than throwing an unhandled TypeError
    assert.doesNotThrow(() => store.save("after", "1.0.0", VALID_MANIFEST, MODULE));
    assert.ok(store.get("after"), "the store must recover from a poisoned index");
    rmSync(dir, { recursive: true, force: true });
  });

  t("a pre-existing victim file outside pkgs/ is NOT clobbered", () => {
    const dir = scratch();
    const store = new RegistryStore(dir);
    const victim = join(dir, "VICTIM.json");
    writeFileSync(victim, "ORIGINAL-SECRET\n");
    assert.throws(() => store.save("..", "VICTIM", VALID_MANIFEST, MODULE), /invalid package/);
    assert.equal(readFileSync(victim, "utf8"), "ORIGINAL-SECRET\n", "the victim's content must be untouched");
    rmSync(dir, { recursive: true, force: true });
  });

  t("the router answers a NAMED 4xx instead of throwing (the process-kill)", () => {
    const api = readFileSync("src/hub/api.ts", "utf8");
    assert.match(api, /try \{\s*store\.save\(/, "the save call must be wrapped");
    assert.match(api, /invalid_package_target/, "and answer a named code");
    assert.match(api, /json\(res, 400/, "with a 400, not an unhandled rejection");
  });

  t("the EARLIEST seam (validateManifest) enforces the same rule", () => {
    const v = readFileSync("scripts/validate-registry.mjs", "utf8");
    assert.match(v, /function validatePublishTarget/, "the validator must gate the publish target");
    assert.match(v, /must be a single path segment/, "with the same rule as the store");
  });

  t("negative: the OLD shapes are required to be the failures (mutation proof)", () => {
    // old save: no gate at all
    const oldSave = (dataDir: string, name: string, version: string) => resolve(dataDir, "pkgs", name, `${version}.json`);
    assert.equal(
      oldSave("/data", "..", "registry"),
      "/data/registry.json",
      "precondition: the old path resolution clobbered registry.json itself",
    );
    assert.equal(
      oldSave("/data", "../../ESCAPED", "1.0.0"),
      "/ESCAPED/1.0.0.json",
      "precondition: and escaped dataDir entirely",
    );
    // the new gate refuses both
    assert.throws(() => assertSafePackageSegment("name", ".."));
    assert.throws(() => assertSafePackageSegment("name", "../../ESCAPED"));
  });
});

// GOAL 122: the hub bound EVERY interface, exposing the package inventory on the LAN.
import { resolveHubBindHost, HUB_BIND_HOST } from "../src/hub/server.js";

d("GOAL 122: the hub is loopback-only unless explicitly opted in", () => {
  t("it defaults to loopback, like promptd", () => {
    assert.equal(HUB_BIND_HOST, "127.0.0.1");
    assert.equal(resolveHubBindHost(undefined), "127.0.0.1");
  });

  t("loopback spellings are accepted without any opt-in", () => {
    for (const h of ["127.0.0.1", "localhost", "::1"]) {
      assert.equal(resolveHubBindHost(h), h, `${h} is loopback and must be allowed`);
    }
  });

  t("a wider bind is REFUSED unless the opt-in env names that exact host", () => {
    const prev = process.env.UI2API_HUB_BIND;
    try {
      delete process.env.UI2API_HUB_BIND;
      assert.throws(() => resolveHubBindHost("0.0.0.0"), /refusing to bind the hub to 0\.0\.0\.0/);
      // explicit, host-matching opt-in
      process.env.UI2API_HUB_BIND = "0.0.0.0";
      assert.equal(resolveHubBindHost("0.0.0.0"), "0.0.0.0", "a matching opt-in must work");
      // and an opt-in for one host must NOT authorise another.
      //
      // The address is 192.168.1.250, not REMOVED. This file ships inside
      // the public copy, and REMOVED is the operator's ACTUAL LAN address —
      // measured in the private corpus and listed in the sanitizer's author-host
      // list. A refusal test exercises identically against any private address,
      // so there is no reason for the real one to be in here. MEASURED
      // 2026-10-01: the publication sanitizer's infra class caught this line,
      // which is the class doing exactly the job it exists for.
      assert.throws(() => resolveHubBindHost("192.168.1.250"), /refusing to bind/);
    } finally {
      if (prev === undefined) delete process.env.UI2API_HUB_BIND;
      else process.env.UI2API_HUB_BIND = prev;
    }
  });

  t("the server passes the resolved host to listen()", () => {
    const src = readFileSync("src/hub/server.ts", "utf8");
    assert.match(src, /server\.listen\(opts\.port, host,/, "listen() must receive the host, not bind every interface");
  });

  t("negative: the host-argument pin has real discriminating power (mutation proof)", () => {
    // This used to be `assert.ok(!/, \s*host,/.test(oldListen))` over a locally
    // declared arrow FUNCTION. `RegExp.prototype.test` coerces its argument, so
    // that asserted against the arrow's own SOURCE TEXT — a tautology about a
    // literal defined two lines above, proving nothing about either the old or
    // the current production call. Worse, it "passed" for the wrong reason: a
    // containment pin that cannot fail is the assert.ok(true) disease.
    //
    // The real question is whether the pin ABOVE can tell a host-passing call
    // from a host-less one. So mutate the ACTUAL source back to the pre-GOAL-122
    // shape and require the pin to go red.
    const pin = /server\.listen\(opts\.port, host,/;
    const src = readFileSync("src/hub/server.ts", "utf8");
    assert.ok(pin.test(src), "precondition: the real source passes the host to listen()");
    const mutated = src.replace("server.listen(opts.port, host,", "server.listen(opts.port,");
    assert.notEqual(mutated, src, "precondition: the host-less mutation actually applied to the real source");
    assert.ok(
      !pin.test(mutated),
      "a host-less server.listen(opts.port) MUST NOT satisfy the containment pin — otherwise the pin is vacuous",
    );
  });
});
