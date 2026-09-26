import { test as t, describe as d } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertPackageRelPath } from "../src/registry/install.js";

/**
 * GOAL 113: `installPackage` wrote every fetched file to `resolve(dir, file)`
 * where `file` came straight from the manifest's `capabilities[].recipe`
 * strings. `resolve()` collapses `..`, an absolute key wins outright, and the
 * recursive `mkdirSync` creates any parent — so a hostile registry package
 * could write, and silently OVERWRITE, arbitrary files outside its own
 * directory. PROVEN before the fix: with the package dir at
 * `/tmp/tv/root/capabilities/evil`, the key `../../../PWNED.txt` wrote
 * `/tmp/tv/PWNED.txt` and `/tmp/tv/ABS.txt` wrote that absolute path.
 *
 * Everything here runs in a temp dir the TEST creates and removes. No real
 * package, registry, or repo file is ever touched.
 */

const scratch = () => mkdtempSync(join(tmpdir(), "g113-"));

d("GOAL 113: an install may only write inside its own package directory", () => {
  t("legitimate package paths still install", () => {
    const dir = resolve(scratch(), "capabilities", "evil");
    for (const p of ["manifest.json", "profile.json", "recipes/chat.json", "recipes/nested/deep.json", "metadata.json"]) {
      assert.doesNotThrow(() => assertPackageRelPath(p, dir), `${p} is a legitimate package path and must be allowed`);
    }
  });

  t("traversal, absolute, backslash and NUL paths are refused BY NAME", () => {
    const dir = resolve(scratch(), "capabilities", "evil");
    const hostile: [string, RegExp][] = [
      ["../../../PWNED.txt", /\.\./],
      ["../../../../etc/passwd", /\.\./],
      ["a/../../b", /\.\./],
      ["/tmp/escaped.json", /absolute/],
      ["C:\\Windows\\evil", /absolute|backslash/],
      ["a\\b", /backslash/],
      ["", /empty/],
      ["x\u0000y", /NUL/],
    ];
    for (const [p, why] of hostile) {
      assert.throws(
        () => assertPackageRelPath(p, dir),
        why,
        `${JSON.stringify(p)} must be refused, naming the reason ${why}`,
      );
    }
  });

  t("the refusal names BOTH the offending key and the resolved target", () => {
    const dir = resolve(scratch(), "capabilities", "evil");
    // a path that is not caught by the syntactic rules but still escapes must
    // be caught by the CONTAINMENT test, and must say where it landed
    assert.throws(
      () => assertPackageRelPath("../sibling/escape.json", dir),
      (e: Error) => e.message.includes("../sibling/escape.json") && e.message.includes(dir),
      "the refusal must name the key and the resolved target",
    );
  });

  t("a refused install leaves NOTHING written outside the package dir", () => {
    // Reproduce the ORIGINAL write loop verbatim and prove it escaped...
    const root = scratch();
    const dir = resolve(root, "capabilities", "evil");
    const oldWrite = (file: string, text: string) => {
      const out = resolve(dir, file);
      mkdirSync(join(out, ".."), { recursive: true });
      writeFileSync(out, text);
    };
    oldWrite("../../PWNED.txt", "pwned");
    assert.ok(existsSync(join(root, "PWNED.txt")), "precondition: the OLD loop really did escape the package dir");

    // ...and that the NEW gate refuses the same key, writing nothing.
    const before = readFileSync(join(root, "PWNED.txt"), "utf8");
    assert.throws(() => assertPackageRelPath("../../PWNED.txt", dir), /\.\./);
    assert.equal(readFileSync(join(root, "PWNED.txt"), "utf8"), before, "the refusal must not touch the file");
    rmSync(root, { recursive: true, force: true });
  });

  t("an absolute key is refused instead of winning outright", () => {
    const root = scratch();
    const dir = resolve(root, "capabilities", "evil");
    const abs = join(root, "ABS.txt");
    // precondition: the old behaviour wrote the absolute path verbatim
    writeFileSync(abs, "old");
    assert.ok(existsSync(abs));
    assert.throws(() => assertPackageRelPath(abs, dir), /absolute/, "an absolute package path must be refused");
    rmSync(root, { recursive: true, force: true });
  });

  t("negative: the OLD behaviour is required to be the failure (mutation proof)", () => {
    const dir = "/x/capabilities/evil";
    // the old rule had no gate at all: any key was resolved and written
    const oldAccepts = (file: string) => resolve(dir, file);
    assert.equal(oldAccepts("../../PWNED.txt"), "/x/PWNED.txt", "precondition: the old resolve escaped the dir");
    assert.equal(oldAccepts("/tmp/ABS.txt"), "/tmp/ABS.txt", "precondition: an absolute key won outright");
    // the new gate must reject both
    assert.throws(() => assertPackageRelPath("../../PWNED.txt", dir));
    assert.throws(() => assertPackageRelPath("/tmp/ABS.txt", dir));
  });

  t("the gate is applied BEFORE any fetch, and to EVERY key before ANY write", () => {
    const src = readFileSync("src/registry/install.ts", "utf8");
    const fetchIdx = src.indexOf("await fetch(`${pkgBase}/${recipe}`)");
    const guardIdx = src.lastIndexOf("assertPackageRelPath(recipe", fetchIdx);
    assert.ok(guardIdx > 0 && guardIdx < fetchIdx, "the recipe path must be validated BEFORE the fetch");
    // and the write loop must resolve ALL targets before writing ANY
    const loop = src.slice(src.indexOf("const targets = Object.keys(textByFile)"));
    assert.match(loop, /const targets = Object\.keys\(textByFile\)\.map\([\s\S]{0,120}assertPackageRelPath/, "every key must be validated up front");
    const firstWrite = loop.indexOf("writeFileSync");
    const lastGuard = loop.lastIndexOf("assertPackageRelPath");
    assert.ok(lastGuard < firstWrite, "no file may be written before all keys are validated");
  });
});
