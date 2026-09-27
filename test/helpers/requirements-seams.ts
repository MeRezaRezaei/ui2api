// GOAL 150: the DERIVATION behind the seam-honesty gate.
//
// WHY THIS IS AN AST AND NOT A REGEX. The defect it exists to prevent is a
// source shape (`deps.x ?? defaultX`) that a regex can be defeated by —
// Prettier line-breaking it, a comment naming it, a string containing it. The
// repo has already paid for a line-scanner that under-read: the timeout gate
// shipped reading another gate's string fixtures as subprocess calls. So the
// seam set here comes from TypeScript's own parser: an interface member is a
// member, a `??` is a `??`, and a string that merely LOOKS like either is a
// string. The compiler that must accept a fixture is the same parser.
//
// THE QUESTION THIS FILE EXISTS TO ANSWER, per seam: is it declared REQUIRED,
// is it filled by `defaultRequirementsDeps`, and is it `??`-guarded at its use
// site? Those three answers decide whether a caller that omits it gets a
// COMPILE error (safe) or a silent read of the real host (the pipeline-199
// defect). See test/requirements-seam-honesty.test.ts for the pins.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

/** The module whose seams this file audits. */
export const REQUIREMENTS_MODULE = "src/runtime/requirements.ts";

export function requirementsSource(root: string = ROOT): string {
  return readFileSync(join(root, REQUIREMENTS_MODULE), "utf8");
}

export interface DepsField {
  name: string;
  /** The interface declared it optional (`foo?:`) — a caller need not supply it. */
  optional: boolean;
  line: number;
}

export interface GuardedSeam {
  field: string;
  /** The real implementation a `??` would silently read instead of the seam. */
  fallback: string;
  line: number;
}

function parse(src: string): ts.SourceFile {
  return ts.createSourceFile("requirements.ts", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** Every field of the named interface, with the REQUIRED/optional distinction. */
export function interfaceFields(src: string, name = "RequirementsDeps"): DepsField[] {
  const out: DepsField[] = [];
  for (const st of parse(src).statements) {
    if (!ts.isInterfaceDeclaration(st) || st.name.text !== name) continue;
    for (const m of st.members) {
      if (!ts.isPropertySignature(m)) continue;
      out.push({
        name: m.name.getText(),
        optional: m.questionToken !== undefined,
        line: src.slice(0, m.getStart()).split("\n").length,
      });
    }
  }
  return out;
}

/** The keys the default-deps factory actually supplies. */
export function defaultDepKeys(src: string, fnName = "defaultRequirementsDeps"): string[] {
  const out = new Set<string>();
  for (const st of parse(src).statements) {
    if (!ts.isFunctionDeclaration(st)) continue;
    if (st.name === undefined || st.name.text !== fnName) continue;
    if (!st.body) continue;
    for (const s of st.body.statements) {
      if (!ts.isReturnStatement(s) || !s.expression || !ts.isObjectLiteralExpression(s.expression)) continue;
      for (const p of s.expression.properties) {
        if (ts.isSpreadAssignment(p)) continue; // `...overrides` supplies nothing specific
        const n = p.name;
        if (n) out.add(n.getText());
      }
    }
  }
  return [...out].sort();
}

/** `deps.x ?? fallback` / `|| fallback` — a seam that can be silently skipped. */
export function guardedSeams(src: string): GuardedSeam[] {
  const file = parse(src);
  const lineOf = (n: ts.Node): number => src.slice(0, n.getStart()).split("\n").length;
  const out: GuardedSeam[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "deps") {
      let parent: ts.Node = n.parent;
      while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
      if (ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) && parent.left === n) {
        out.push({ field: n.name.text, fallback: parent.right.getText(), line: lineOf(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}

export interface SeamAudit {
  fields: DepsField[];
  required: string[];
  optional: string[];
  defaultKeys: string[];
  guards: GuardedSeam[];
  /** A guard on a field the interface declares REQUIRED — the pipeline-199 shape:
   *  the type says the caller must supply it, the use site says it need not. */
  guardedRequired: GuardedSeam[];
  /** A guard that cannot fire: `defaultRequirementsDeps` already supplies the
   *  field, so the fallback is unreachable in production and exists only to let
   *  an incomplete fixture through. */
  inertGuards: GuardedSeam[];
  /** A required field the factory does not supply — the guards on it would be
   *  load-bearing rather than inert, and are the honest case (chromeOwner). */
  requiredNotDefaulted: string[];
}

export function auditSeams(src: string): SeamAudit {
  const fields = interfaceFields(src);
  const required = fields.filter((f) => !f.optional).map((f) => f.name);
  const optional = fields.filter((f) => f.optional).map((f) => f.name);
  const defaultKeys = defaultDepKeys(src);
  const guards = guardedSeams(src);
  return {
    fields,
    required,
    optional,
    defaultKeys,
    guards,
    guardedRequired: guards.filter((g) => required.includes(g.field)),
    inertGuards: guards.filter((g) => defaultKeys.includes(g.field)),
    requiredNotDefaulted: required.filter((r) => !defaultKeys.includes(r)),
  };
}

/** Where the real implementation of a probe is NAMED. Every reference outside a
 *  function's own declaration is a second wiring site — the shape that let a
 *  probe be reachable from a use site as well as from the factory. */
export function referencesOutsideDeclaration(
  src: string,
  names: string[],
  fnName = "defaultRequirementsDeps"
): { name: string; line: number }[] {
  const file = parse(src);
  const wanted = new Set(names);
  const lineOf = (n: ts.Node): number => src.slice(0, n.getStart()).split("\n").length;
  const decls: ts.Node[] = [];
  const imports: ts.Node[] = [];
  let factory: ts.FunctionDeclaration | null = null;
  for (const st of file.statements) {
    if (ts.isImportDeclaration(st)) {
      imports.push(st);
      continue;
    }
    if (!ts.isFunctionDeclaration(st) || st.name === undefined) continue;
    if (st.name.text === fnName) factory = st;
    if (wanted.has(st.name.text)) decls.push(st);
  }
  const inside = (n: ts.Node, node: ts.Node | null): boolean =>
    node !== null && n.getStart() >= node.getStart() && n.getEnd() <= node.getEnd();
  const out: { name: string; line: number }[] = [];
  const visit = (n: ts.Node): void => {
    // A declaration's own name token, and anything else inside one, is where the
    // probe is DEFINED, not a second wiring site. An import is how a name becomes
    // available at all, not a use of it.
    const definitional = decls.some((d) => inside(n, d)) || imports.some((i) => inside(n, i));
    if (ts.isIdentifier(n) && wanted.has(n.text) && !definitional && !inside(n, factory)) {
      out.push({ name: n.text, line: lineOf(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return out;
}
