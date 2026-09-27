// Types for scripts/measure-function-map.mjs.
//
// The measure script is a MEASUREMENT the docs/function-api-ui-map.md census and
// its truth gate (test/function-doc-truth.test.ts) both depend on, so its
// contract is declared explicitly here rather than inferred as `any`.
// `tsconfig.test.json` sets `allowJs: false`, which is deliberate — src/ and
// test/ are type-checked, and the only reason a `.d.mts` exists is to pin a
// plain-JS module that test/ imports. This file documents the CURRENT shape of
// the .mjs exports; if measure() grows or drops a field, this must change with
// it or the truth gate stops meaning anything.

/** The census `measure()` returns, and the object every doc headline number is
 *  compared against. One field per `KEY: <int>` token in the doc header. */
export interface FunctionMapMeasure {
  /** count of `capabilities/<id>/` dirs that carry a manifest.json */
  packageCount: number;
  /** those package ids, sorted */
  packages: string[];
  /** total manifest capability entries summed across every package */
  capabilityTotal: number;
  /** count of ids in the RUNNERS table in test/capability-dispatch.test.ts */
  realRunnerCount: number;
  /** those real-runner ids */
  realRunners: string[];
  /** count of login-gated-by-design ids */
  gatedCount: number;
  /** those gated-by-design ids */
  gated: string[];
  /** manifest capability total attributable to real-runner packages */
  realCaps: number;
  /** manifest capability total attributable to gated-by-design packages */
  gatedCaps: number;
  /** `req.url === "/capability/<id>"` dispatchers counted in http.ts */
  capabilityRouteCount: number;
  /** number of profiles defaultChatProfiles() actually returns (measured by
   *  spawning the project's own tsx loader) */
  chatProfileCount: number;
}

/** capability totals split by real-runner vs gated-by-design; the two sum to
 *  capabilityTotal(). */
export interface RealGatedSplit {
  realN: number;
  gatedN: number;
}

/** Every `capabilities/<id>/` dir that carries a manifest.json, sorted. */
export declare function packageIds(): string[];

/** Total manifest capability entries across all packages. */
export declare function capabilityTotal(): number;

/** Real-runner ids, read from the `const RUNNERS = [` .. `];` table in
 *  test/capability-dispatch.test.ts.
 *
 *  THROWS (rather than answering a plausible wrong number) when that table
 *  cannot be located — a moved or renamed table is a named failure, not a
 *  silently drifted census. */
export declare function realRunnerIds(): string[];

/** Login-gated-by-design ids, read from test/function-api-ui-closure.test.ts. */
export declare function gatedIds(): string[];

/** Capability totals split by real-runner vs gated-by-design. */
export declare function realGatedSplit(): RealGatedSplit;

/** `req.url === "/capability/<id>"` dispatchers counted in src/prompt/http.ts. */
export declare function capabilityRouteCount(): number;

/** Driveable chat profiles, measured for real by spawning the project's own tsx
 *  loader (pure profile resolution — no pool, no browser).
 *
 *  THROWS if the subprocess fails or yields a non-positive integer. */
export declare function chatProfileCount(): number;

/** The whole census in one call. */
export declare function measure(): FunctionMapMeasure;
