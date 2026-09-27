// GOAL 150: a REQUIRED seam must never be `??`-guarded at its use site.
//
// THE DEFECT THIS GATE CLOSES. GitLab CI went red on two pipelines because a
// test asserted a verdict while silently probing the REAL host. The concrete
// instance was the `display-stack` block in src/runtime/requirements.ts, which
// read four host probes through a dependency-injection pattern that carried
// `??` fallbacks:
//
//     const missingLibs = (deps.missingSharedLibraries ?? defaultMissing…)(libs);
//     const fonts       = (deps.fontCount ?? defaultFontCount)();
//     const has         = deps.hasBinary ?? defaultHasBinary;
//     const display     = (deps.displayUsable ?? defaultDisplayUsable)();
//
// A fixture injected two of the four, so the real shared-library scan and the
// real font inventory ran. It passed on the author's desktop (every GTK/NSS/GBM
// lib, hundreds of fonts) and failed on a bare CI runner — four packages went
// `on-hold`. Two commits were spent fixing the SYMPTOM. The `??` stayed, because
// `RequirementsDeps` declared those fields REQUIRED and the guards read as
// harmless belt-and-braces: a seam nobody is forced to inject is not a seam, and
// nothing in the source said so out loud. The GOAL 149 gate next door finds these
// patterns in `test/`; this one finds the reason they are ATTRACTIVE in `src/`.
//
// THE RULE, which is sharper than "no `??` anywhere":
//
//   A `??`/`||` guard on a seam is honest in exactly one case — the field is
//   OPTIONAL in the interface AND `defaultRequirementsDeps` does not supply it.
//   Then the guard is the field's only wiring: no production caller could work
//   without it, and the interface says so by declaring it optional.
//
//   Every other guard is a defect:
//     * guarded + REQUIRED          → the type says "you must supply this" and
//                                     the use site says "you need not". A
//                                     fixture that omits it gets the real host
//                                     instead of a compile error.
//     * guarded + supplied by the   → the guard can never fire in production, so
//       default factory               it exists ONLY to tolerate an incomplete
//                                     fixture. The worst case: it looks
//                                     intentional and reads the operator's box.
//
// `chromeOwner` is the surviving honest case and is pinned as such: the
// interface marks it optional, the factory deliberately leaves it out, and the
// guard names the real resolver. Its doc comment says all of this, so the
// signature and the fallback agree instead of the code contradicting its own
// comment — which is what it used to do.
//
// The FALSIFICATION proof for the change this gate accompanies is not here (a
// unit test cannot run tsc honestly — see the module header's note on the
// compile-rejection proof in the wave report): what is here is the structural
// derivation, from the TypeScript AST, that a guarded required seam cannot come
// back. Every pin below lives in a real top-level `test(...)`.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  auditSeams,
  guardedSeams,
  interfaceFields,
  referencesOutsideDeclaration,
  requirementsSource,
  type SeamAudit,
} from "./helpers/requirements-seams.js";

const SRC = requirementsSource();
const AUDIT: SeamAudit = auditSeams(SRC);

const fmt = (g: { field: string; fallback: string; line: number }): string =>
  `${g.field} ?? ${g.fallback} (requirements.ts:${g.line})`;

// ------------------------------------------------------------------ the pins ---

test("GOAL150(a): NO required RequirementsDeps field is `??`/`||`-guarded at a use site", () => {
  assert.deepEqual(
    AUDIT.guardedRequired.map(fmt),
    [],
    `these REQUIRED seams are still guardable, so a fixture that omits one silently reads the real host instead of failing to compile: ${AUDIT.guardedRequired
      .map(fmt)
      .join(", ")} — delete the fallback and call deps.<field> directly (defaultRequirementsDeps already supplies it)`,
  );
  // The four the incident lived in, named. A general rule that quietly stopped
  // covering the actual field would be a rule nobody can audit.
  for (const f of ["missingSharedLibraries", "fontCount", "hasBinary", "displayUsable"]) {
    assert.ok(
      AUDIT.required.includes(f),
      `${f} must stay a REQUIRED seam: pipeline 199 was a fixture that omitted it and read the real host`,
    );
    assert.equal(
      AUDIT.guards.some((g) => g.field === f),
      false,
      `${f} is required, so a guard on it is the defect itself — the fallback can only serve a fixture that lies about being complete`,
    );
  }
});

test("GOAL150(b): every REMAINING guard is load-bearing — optional in the signature AND not supplied by the factory", () => {
  assert.deepEqual(
    AUDIT.inertGuards.map(fmt),
    [],
    `these guards can never fire in production (defaultRequirementsDeps already supplies the field), so they exist only to let an incomplete fixture through: ${AUDIT.inertGuards
      .map(fmt)
      .join(", ")} — the signature and the fallback must agree: either mark the field optional and stop supplying it, or drop the guard`,
  );
  for (const g of AUDIT.guards) {
    assert.ok(
      AUDIT.optional.includes(g.field),
      `${g.field} is guarded at its use site but the interface declares it required — remove the guard, or make the field genuinely optional`,
    );
    assert.equal(
      AUDIT.defaultKeys.includes(g.field),
      false,
      `${g.field} is guarded AND supplied by defaultRequirementsDeps, so the guard is dead code that only an incomplete caller can reach`,
    );
  }
});

test("GOAL150(c): every required seam IS supplied by the factory — which is what makes its use site safe to read unguarded", () => {
  // This is the enabling invariant behind (a). A required field the factory did
  // not supply would have to be filled by every caller, and a guard on it would
  // then be load-bearing rather than a trap; the audit must be able to tell those
  // two worlds apart instead of assuming one.
  assert.deepEqual(
    AUDIT.requiredNotDefaulted,
    [],
    `required seams the factory does not supply: ${JSON.stringify(AUDIT.requiredNotDefaulted)} — either supply them here (then the use site is read unguarded) or mark them optional`,
  );
  assert.ok(AUDIT.defaultKeys.length >= 20, `the factory parse yielded only ${AUDIT.defaultKeys.length} keys — the derivation is not reading the real object`);
  assert.ok(AUDIT.required.length >= 20, `the interface parse yielded only ${AUDIT.required.length} required fields — the derivation is not reading the real interface`);
  // The factory must not invent a key the interface does not declare: that is a
  // seam the types cannot see, which is the same ambiguity from the other side.
  const invented = AUDIT.defaultKeys.filter((k) => !AUDIT.fields.some((f) => f.name === k));
  assert.deepEqual(invented, [], `defaultRequirementsDeps supplies fields the interface does not declare: ${JSON.stringify(invented)}`);
});

test("GOAL150(d): each real probe implementation is wired in EXACTLY ONE place — the factory object literal", () => {
  // The other half of "delete the guard at the use site": the real implementation
  // must remain reachable, and from one named place. A second reference is a
  // second wiring site, i.e. the guard creeping back.
  const probes = ["defaultMissingSharedLibraries", "defaultFontCount", "defaultHasBinary", "defaultDisplayUsable"];
  assert.deepEqual(
    referencesOutsideDeclaration(SRC, probes),
    [],
    "a real probe is named outside defaultRequirementsDeps: the fallback is reachable again — wire it in the factory only, and read deps.<field> directly",
  );
  // Non-vacuity: all four still exist AND the factory still names them, so the
  // check above is looking at live wiring rather than at a file that renamed
  // everything away.
  for (const p of probes) {
    assert.ok(SRC.includes(`function ${p}(`), `${p} must remain a real implementation — a seam with no real default is not injectable, it is unreachable`);
    assert.ok(AUDIT.defaultKeys.some((k) => SRC.includes(`${k}: ${p}`)), `defaultRequirementsDeps must still supply ${p}`);
  }
});

test("GOAL150(e): chromeOwner is the ONE documented inline fallback, and it is documented as a fallback", () => {
  // Pinned as the honest case, so "why is this one still guarded?" has an answer
  // a reader can find from the source alone rather than from a commit message.
  const guards = AUDIT.guards;
  assert.ok(guards.length > 0, "the live source exposes no inline fallback at all — if the last one was removed, this gate's premise must be re-derived together with the GOAL 147 seam-coverage gate next door");
  for (const g of guards) {
    assert.equal(g.field, "chromeOwner", `only chromeOwner may keep a use-site fallback; ${g.field} is new to this set and needs the same argument (optional + not factory-supplied) or the guard deleted`);
    assert.ok(
      AUDIT.optional.includes(g.field),
      "chromeOwner's fallback is honest only while the interface marks it optional — a required field with a guard is rule (a)'s defect",
    );
    assert.equal(
      AUDIT.defaultKeys.includes(g.field),
      false,
      "defaultRequirementsDeps must NOT supply chromeOwner: the guard is its only wiring, and a factory-supplied field makes the guard dead code",
    );
    assert.equal(g.fallback, "resolveChromeOwner", "the fallback must be the real resolver, named — an anonymous default is a host read nobody can find");
  }
  // The doc comment must tell the reader the default reads the host. The comment
  // that used to sit there explained why the field is a seam and then the use
  // site read the host anyway, which is how the contradiction survived review.
  const iface = SRC.slice(SRC.indexOf("export interface RequirementsDeps"));
  const chromeOwnerDoc = iface.slice(0, iface.indexOf("chromeOwner?:"));
  assert.match(
    chromeOwnerDoc.slice(Math.max(0, chromeOwnerDoc.length - 1400)),
    /defaultRequirementsDeps does NOT supply|does NOT supply it/i,
    "the chromeOwner field must DOCUMENT that its default is a real host read — an undocumented fallback is the defect this whole file is about",
  );
});

test("GOAL150(f): the derivation is DERIVED — the live parse reads the real interface, the real factory and the real guards", () => {
  // Non-vacuity. A parser that silently matched nothing would satisfy (a)-(e) and
  // prove nothing, so each half of the derivation is asserted to have yielded the
  // real thing, and the two surviving sets are cross-checked against each other.
  const fields = interfaceFields(SRC);
  assert.ok(fields.length >= 20, `interface parse yielded ${fields.length} fields — the derivation is not reading RequirementsDeps`);
  assert.equal(
    fields.length,
    AUDIT.required.length + AUDIT.optional.length,
    "the required/optional split must partition the interface — a field counted in neither is a parse hole",
  );
  for (const f of ["dataDir", "nodeVersion", "fontCount", "displayUsable", "chromeOwner", "registryVerified"]) {
    assert.ok(fields.some((x) => x.name === f), `the interface parse lost field ${f} — this derivation is not reading the real interface`);
  }
  // Every guarded field is a field the interface actually declares: a guard on an
  // undeclared name would be a typo that survives every check above.
  const undeclared = AUDIT.guards.filter((g) => !fields.some((f) => f.name === g.field));
  assert.deepEqual(undeclared.map(fmt), [], "a guard names a field the interface does not declare");
  // And the whole set of guards is a subset of the fields the factory does not
  // supply, which is the same claim as (b) stated in the other direction.
  assert.ok(
    AUDIT.guards.every((g) => !AUDIT.defaultKeys.includes(g.field)),
    "every guard must sit on a field the factory leaves out",
  );
  // The scanner sees a guard when one is there (the non-vacuity the live pins
  // rest on), and reports nothing for a hand-written clean source.
  assert.equal(guardedSeams("const a = deps.fontCount ?? defaultFontCount();").length, 1);
  assert.equal(guardedSeams("const a = deps.fontCount();").length, 0);
});

// ------------------------------------------------------------------ mutation ---

/** A minimal, complete RequirementsDeps-shaped module, so the mutation exercises
 *  the real predicates rather than a paraphrase of them. */
function synthetic(depsBlock: string, extraFactoryKeys: string, useSite: string): string {
  return [
    "export interface RequirementsDeps {",
    depsBlock,
    "  chromeVersion: (exec: string) => string | null;",
    "  now: () => Date;",
    "}",
    "function defaultFontCount(): number { return 0; }",
    "function defaultMissingSharedLibraries(libs: string[]): string[] { return libs; }",
    "export function defaultRequirementsDeps(overrides: Partial<RequirementsDeps> = {}): RequirementsDeps {",
    "  return {",
    "    chromeVersion: () => null,",
    "    now: () => new Date(),",
    extraFactoryKeys,
    "    ...overrides,",
    "  };",
    "}",
    "export function probe(deps: RequirementsDeps): number {",
    `  const fonts = ${useSite};`,
    "  return fonts;",
    "}",
    "",
  ].join("\n");
}

const CLEAN_FACTORY = "    fontCount: defaultFontCount,\n    missingSharedLibraries: defaultMissingSharedLibraries,";
const NO_PROBE_FACTORY = "";

test("MUTATION: a guard on a REQUIRED seam is named, field and fallback — the exact pipeline-199 shape", () => {
  // (a) the defect itself, reintroduced: required field, factory supplies it, and
  //     a `??` at the use site. Both rules must fire, each naming it.
  const reintroduced = synthetic(
    "  fontCount: () => number;",
    CLEAN_FACTORY,
    "deps.fontCount ?? defaultFontCount()"
  );
  const a = auditSeams(reintroduced);
  assert.equal(a.guardedRequired.length, 1, "the guarded required seam must be reported");
  assert.equal(a.guardedRequired[0]?.field, "fontCount");
  // The fallback may be a bare reference or an already-called probe; what the
  // report has to carry is WHICH real implementation the guard would reach.
  assert.match(a.guardedRequired[0]?.fallback ?? "", /^defaultFontCount\b/, "the report must name the real implementation the guard reaches");
  assert.ok(a.guardedRequired[0]!.line > 0, "the report must carry a line, or it cannot be found in the file");
  assert.equal(a.inertGuards.length, 1, "a guard on a factory-supplied field is also inert — both rules must see it");
  // (b) the fixed shape: same field, same factory, no guard. Clean.
  const fixed = auditSeams(synthetic("  fontCount: () => number;", CLEAN_FACTORY, "deps.fontCount()"));
  assert.deepEqual(fixed.guardedRequired.map(fmt), []);
  assert.deepEqual(fixed.inertGuards.map(fmt), []);
  assert.deepEqual(fixed.requiredNotDefaulted, [], "the fixed shape must satisfy the enabling invariant too");
});

test("MUTATION: a guard on a field the factory DOES supply is named even when the field is optional", () => {
  // The subtler trap: mark the field optional so rule (a) cannot see it, but keep
  // the factory supplying it — the guard is then dead code whose only consumer is
  // an incomplete fixture, and the signature hides the hole behind a `?`.
  const optionalButSupplied = synthetic(
    "  fontCount?: () => number;",
    CLEAN_FACTORY,
    "deps.fontCount ?? defaultFontCount()"
  );
  const m = auditSeams(optionalButSupplied);
  assert.deepEqual(m.guardedRequired.map(fmt), [], "an optional field is not rule (a)'s business");
  assert.equal(m.inertGuards.length, 1, "rule (b) MUST catch it — this is the shape that outlives deleting a `?`");
  assert.equal(m.inertGuards[0]?.field, "fontCount");
  // The honest case, unchanged, must stay clean: optional AND not factory-supplied.
  const honest = synthetic("  fontCount?: () => number;", NO_PROBE_FACTORY, "deps.fontCount ?? defaultFontCount()");
  assert.equal(auditSeams(honest).requiredNotDefaulted.length, 0, "the honest case must also satisfy the enabling invariant, or it is not a usable exception");
  assert.deepEqual(auditSeams(honest).inertGuards.map(fmt), [], "the one legitimate guard shape must not be reported");
});

test("MUTATION: the AST cannot be fooled by the shapes a regex would fall for", () => {
  // Prettier line-breaking, a comment that names the pattern, and a string
  // literal that contains it. The first two must be seen (or, for the comment,
  // correctly ignored as prose); the third is data, never a seam.
  const wrapped = synthetic("  fontCount: () => number;", CLEAN_FACTORY, "deps\n    .fontCount\n    ??\n    defaultFontCount()");
  assert.equal(auditSeams(wrapped).guardedRequired.length, 1, "a line-broken guard must still be seen");
  const commented = [
    "export interface RequirementsDeps {",
    "  fontCount: () => number;",
    "  chromeVersion: (e: string) => string | null;",
    "  now: () => Date;",
    "}",
    "export function defaultRequirementsDeps(overrides: Partial<RequirementsDeps> = {}): RequirementsDeps {",
    "  return { fontCount: defaultFontCount, chromeVersion: () => null, now: () => new Date(), ...overrides };",
    "}",
    "export function probe(deps: RequirementsDeps): number {",
    "  // deps.fontCount ?? defaultFontCount — documented, not executed",
    '  const note = "const x = deps.fontCount ?? defaultFontCount();";',
    "  return deps.fontCount();",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(auditSeams(commented).guards, [], "a comment and a string that NAME the pattern are data — only real code is a seam");
});
