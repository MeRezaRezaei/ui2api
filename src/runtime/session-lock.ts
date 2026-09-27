// Session-lock CLAIM verification (GOAL 86) — makes the vault's own readiness
// claim falsifiable instead of decorative.
//
// `capabilities/<site>/session.lock.json` is committed metadata: it declares a
// snapshot path, a sha256 prefix, a cookie count and a NAMED localStorage
// sample. Before this module NOTHING verified a lock against its snapshot, so
// the claim was unfalsifiable — and measured, gemini's was false on two
// checkable fields while every other lock passed.
//
// Honesty contract (the same discipline the restrictionMarkers gate applies —
// conservative patterns, NEVER a false positive, never a silent pass):
//   - a claim is CHECKED only when it is actually measurable here (the declared
//     snapshot is on disk and the field is declared). A claim that cannot be
//     checked is SKIPPED with a NAMED reason, never counted as a pass;
//   - a claim that is checked and DISAGREES is a FAILURE with the measured
//     numbers in the reason. Nothing is inferred, defaulted or repaired here;
//   - `localStorageKeys` is a deliberate SAMPLE (a lock names 4-7 of the 18-36
//     keys a real snapshot holds), so it is NEVER gated as a count — gating it
//     would false-positive on every site;
//   - a missing snapshot is a skip, not a failure: the vault (`data/`) is
//     gitignored, so the snapshot is a per-box capture. Unverifiable here is
//     honestly reported as unverifiable, never dressed up as a pass;
//   - a declared path that escapes the tree being validated is REFUSED (the gate
//     never hashes a file the lock does not legitimately own) — and that refusal
//     is decided on the path's REAL location, not merely on its spelling,
//     because a textual `relative()` check is BLIND TO A SYMLINK. See
//     `realLocationOf` for the measurement that forced this;
//   - every lock file on disk lands in exactly one bucket (checked / skipped /
//     failed) so a gate that silently ignores packages cannot pass.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: `src/runtime/` (and the compiled `dist/runtime/`) → two levels up. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type SessionLockClaimField = "sha256Prefix" | "cookies";

export interface SessionLockSkip {
  /** Package id (the `capabilities/<id>/` directory name). */
  site: string;
  /** NAMED reason — never empty, never "skipped" alone. */
  reason: string;
}

export interface SessionLockFailure {
  site: string;
  /** `sha256 mismatch for <id> …` / `cookie count mismatch for <id> …` + measured values. */
  reason: string;
}

export interface SessionLockClaim {
  field: SessionLockClaimField;
  status: "pass" | "skip";
  /** pass: the measured evidence. skip: the named reason it could not be checked. */
  detail: string;
}

export interface SessionLockDetail {
  site: string;
  /** The host the lock itself declares (`lock.site`) when it declares one. */
  declaredHost: string | null;
  lockPath: string;
  snapshotPath: string | null;
  /** True when at least one claim was MEASURED against the snapshot on disk. */
  checked: boolean;
  claims: SessionLockClaim[];
}

export interface SessionLockReport {
  ok: boolean;
  checked: string[];
  skipped: SessionLockSkip[];
  failures: SessionLockFailure[];
  details: SessionLockDetail[];
}

export interface VerifySessionLockOptions {
  /** Root the declared (relative) snapshot path resolves against. Default: repo root. */
  root?: string;
}

interface LockSnapshotClaim {
  path?: unknown;
  sha256Prefix?: unknown;
  cookies?: unknown;
  snapshotAvailable?: unknown;
  note?: unknown;
}

const SHA_RE = /^[0-9a-f]{4,64}$/;

/** True when `candidate` is `root` itself or lies OUTSIDE it.
 *
 *  Deliberately EXACT, and the difference from the textual guard above is the
 *  point: a file legitimately named `..weird.json` inside the tree is INSIDE
 *  it. `rel === ".."` / `rel.startsWith(".." + sep)` is the precise predicate;
 *  a bare `rel.startsWith("..")` also matches `..weird.json` and would refuse a
 *  file the tree legitimately owns. (The textual guard upstream still uses the
 *  loose form — that is a pre-existing false positive in the SAFE direction and
 *  it is left exactly as it is, because loosening a refusal to make a suite
 *  green is the failure this module exists to prevent.) */
function escapesRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** The REAL, symlink-resolved location of `abs` — the place the bytes would
 *  actually come from.
 *
 *  WHY THIS EXISTS, and the measurement that forced it. The original guard was
 *  purely TEXTUAL (`relative(root, resolve(root, declared))`), and it does stop
 *  the obvious shapes: `../../../etc/passwd`, an absolute `/etc/passwd`, and an
 *  escape-and-come-back all measured as REFUSED. But it is blind to a symlink,
 *  because a symlink's own path is legitimately inside the tree while its
 *  TARGET is not. MEASURED against the real function: a lock declaring
 *  `data/probe.test/link.json`, where that file is a symlink to a JSON file
 *  OUTSIDE the root, was ACCEPTED — `ok:false` with BOTH claims measured
 *  ("sha256 123d… does NOT match declared prefix dead", "cookie count 3
 *  matches the declared count") — and `strace -e trace=openat` shows the
 *  `openat(..., "/…/probe.test/link.json")` that read the outside file. So the
 *  textual check was, in fact, a lock file naming a location outside the tree.
 *
 *  It is computed from the DEEPEST EXISTING ANCESTOR and the remainder
 *  re-appended, not just from the leaf, because that is what catches a hop
 *  through a symlinked DIRECTORY (`data/evil -> /etc`, leaf `state.json` absent)
 *  — a `realpathSync(abs)` alone would simply throw there and let the caller
 *  fall through to the not-on-disk skip, mis-attributing an ESCAPE as a
 *  MISSING FILE. `existed` says whether the leaf itself was resolvable, so the
 *  caller can keep the two causes apart and name the right one. */
function realLocationOf(abs: string): { real: string; existed: boolean } {
  let probe = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(probe);
      return { real: tail.length === 0 ? real : join(real, ...tail), existed: tail.length === 0 };
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return { real: abs, existed: false };
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/** The root's own real location, resolved once per call site. A root that is
 *  itself reached through a symlink (every macOS `/tmp`, many CI workdirs) must
 *  be compared on the same footing as the candidate, or every legitimate file
 *  under it would measure as an escape. */
function realRootOf(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function lockDirName(lockPath: string): string {
  return lockPath.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? lockPath;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function skipReport(site: string, reason: string, detail?: Partial<SessionLockDetail>): SessionLockReport {
  return {
    ok: true,
    checked: [],
    skipped: [{ site, reason }],
    failures: [],
    details: [
      {
        site,
        declaredHost: detail?.declaredHost ?? null,
        lockPath: detail?.lockPath ?? "",
        snapshotPath: detail?.snapshotPath ?? null,
        checked: false,
        claims: detail?.claims ?? [],
      },
    ],
  };
}

/** sha256 of the snapshot's RAW BYTES — computable even when the file is not
 *  valid JSON, so a corrupt snapshot can still falsify the hash claim. */
export function sha256File(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

/**
 * Verify ONE `session.lock.json` against the snapshot it declares. Pure
 * filesystem reads: no network, no browser, no writes, no repair.
 */
export function verifySessionLock(lockPath: string, opts: VerifySessionLockOptions = {}): SessionLockReport {
  const root = opts.root ?? REPO_ROOT;
  const site = lockDirName(lockPath);

  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return {
      ok: false,
      checked: [],
      skipped: [],
      failures: [{ site, reason: `lock unreadable for ${site}: ${lockPath} (${err?.code ?? "read error"})` }],
      details: [
        {
          site,
          declaredHost: null,
          lockPath,
          snapshotPath: null,
          checked: false,
          claims: [],
        },
      ],
    };
  }

  let lock: { site?: unknown; snapshot?: LockSnapshotClaim; note?: unknown; locked?: unknown };
  try {
    lock = JSON.parse(raw) as typeof lock;
  } catch (e) {
    return {
      ok: false,
      checked: [],
      skipped: [],
      failures: [
        { site, reason: `lock is not parseable JSON for ${site}: ${lockPath} (${(e as Error).message.split("\n")[0]})` },
      ],
      details: [{ site, declaredHost: null, lockPath, snapshotPath: null, checked: false, claims: [] }],
    };
  }

  const declaredHost = asNonEmptyString(lock.site);
  const snap = (lock.snapshot ?? {}) as LockSnapshotClaim;
  const declaredPath = asNonEmptyString(snap.path);

  // (a') the lock itself may declare the snapshot unavailable (honest downgrade).
  // Checked BEFORE the missing-path rule: a lock that says "not available here"
  // with a reason is the more specific, more actionable statement, so that named
  // reason is what the report carries.
  if (snap.snapshotAvailable === false) {
    const why = asNonEmptyString(snap.note) ?? asNonEmptyString(lock.note) ?? "no reason recorded in the lock";
    return skipReport(
      site,
      `snapshotAvailable:false declared by ${site}/session.lock.json — the lock itself says the snapshot is not available here: ${why}`,
      { declaredHost, lockPath, snapshotPath: declaredPath }
    );
  }

  // (a) a lock that declares no snapshot path makes no snapshot claim at all.
  if (!declaredPath) {
    return skipReport(
      site,
      `no snapshot path declared in ${site}/session.lock.json — the lock carries no snapshot claim (nothing to verify, not a pass)`,
      { declaredHost, lockPath }
    );
  }

  // (a'') refuse a declared path that escapes the tree being validated — first on
  // its SPELLING, then (below) on its REAL location. The spelling check stops
  // `../` and absolute paths; it cannot see a symlink.
  const abs = isAbsolute(declaredPath) ? resolve(declaredPath) : resolve(root, declaredPath);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || rel.split(sep)[0] === "" || isAbsolute(rel)) {
    return skipReport(
      site,
      `declared snapshot path escapes the repo root and was REFUSED: ${declaredPath} (${site}/session.lock.json)`,
      { declaredHost, lockPath, snapshotPath: declaredPath }
    );
  }

  // (a''') …and refuse it again on its REAL location, so a path that merely
  // LOOKS contained cannot name a file outside the tree. Deliberately placed
  // BEFORE the `statSync` and before any read, so a refused path is never
  // opened at all — the point of a confinement is that the read does not
  // happen, not that it happens and is afterwards reported.
  const realRoot = realRootOf(root);
  const { real: realAbs, existed: leafExists } = realLocationOf(abs);
  if (escapesRoot(realRoot, realAbs)) {
    return skipReport(
      site,
      `declared snapshot path resolves OUTSIDE the tree being validated and was REFUSED: ${declaredPath} ` +
        `-> ${realAbs} (${site}/session.lock.json) — ${leafExists ? "the path is inside the tree only by SPELLING; a symlink points at it" : "a path component is a symlink that points outside the tree"}, ` +
        `and the gate never hashes a file the lock does not legitimately own`,
      { declaredHost, lockPath, snapshotPath: declaredPath }
    );
  }

  // (a) the declared snapshot must exist to be checkable at all.
  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) {
      return skipReport(
        site,
        `declared snapshot is not a regular file: ${declaredPath} (${site}/session.lock.json) — the claim cannot be checked`,
        { declaredHost, lockPath, snapshotPath: declaredPath }
      );
    }
    size = st.size;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return skipReport(
      site,
      `declared snapshot not on disk: ${declaredPath} (${err?.code ?? "stat error"}; the vault data/ is gitignored — a per-box capture, unverifiable here and never a pass)`,
      { declaredHost, lockPath, snapshotPath: declaredPath }
    );
  }

  const claims: SessionLockClaim[] = [];
  const failures: SessionLockFailure[] = [];
  const host = declaredHost ? ` (${declaredHost})` : "";

  // (b) sha256 prefix — measured over the raw bytes.
  const prefix = asNonEmptyString(snap.sha256Prefix)?.toLowerCase() ?? null;
  if (!prefix) {
    claims.push({
      field: "sha256Prefix",
      status: "skip",
      detail: `no sha256Prefix declared in ${site}/session.lock.json — the hash claim cannot be checked`,
    });
  } else if (!SHA_RE.test(prefix)) {
    claims.push({
      field: "sha256Prefix",
      status: "skip",
      detail: `declared sha256Prefix "${prefix}" is not lowercase hex (4-64 chars) — the hash claim cannot be checked`,
    });
  } else {
    const actual = sha256File(abs);
    const shown = actual.slice(0, prefix.length);
    if (actual.startsWith(prefix)) {
      claims.push({
        field: "sha256Prefix",
        status: "pass",
        detail: `sha256 ${shown}… matches declared prefix (${size} bytes, ${declaredPath})`,
      });
    } else {
      claims.push({
        field: "sha256Prefix",
        status: "pass",
        detail: `sha256 ${shown}… does NOT match declared prefix ${prefix} (${size} bytes, ${declaredPath})`,
      });
      failures.push({
        site,
        reason: `sha256 mismatch for ${site}${host}: declared ${prefix}, actual ${shown}… (${declaredPath})`,
      });
    }
  }

  // (c) cookie count — the snapshot's own `cookies` array length.
  const declaredCount = typeof snap.cookies === "number" && Number.isFinite(snap.cookies) ? snap.cookies : null;
  let snapshot: { cookies?: unknown } | null = null;
  let parseReason: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as { cookies?: unknown };
    snapshot = parsed && typeof parsed === "object" ? parsed : null;
    if (!snapshot) parseReason = `snapshot ${declaredPath} is not a JSON object`;
  } catch (e) {
    parseReason = `snapshot ${declaredPath} is not parseable JSON (${(e as Error).message.split("\n")[0]})`;
  }

  if (declaredCount === null) {
    claims.push({
      field: "cookies",
      status: "skip",
      detail: `no cookies count declared in ${site}/session.lock.json — the count claim cannot be checked`,
    });
  } else if (parseReason) {
    claims.push({ field: "cookies", status: "skip", detail: `${parseReason} — the cookie-count claim cannot be checked` });
  } else if (!Array.isArray(snapshot!.cookies)) {
    claims.push({
      field: "cookies",
      status: "skip",
      detail: `snapshot ${declaredPath} has no cookies array — the cookie-count claim cannot be checked`,
    });
  } else {
    const actual = (snapshot!.cookies as unknown[]).length;
    if (actual === declaredCount) {
      claims.push({
        field: "cookies",
        status: "pass",
        detail: `cookie count ${actual} matches the declared count (${declaredPath})`,
      });
    } else {
      claims.push({
        field: "cookies",
        status: "pass",
        detail: `cookie count ${actual} does NOT match the declared count ${declaredCount} (${declaredPath})`,
      });
      failures.push({
        site,
        reason: `cookie count mismatch for ${site}${host}: declared ${declaredCount}, actual ${actual} (${declaredPath})`,
      });
    }
  }

  const measured = claims.some((c) => c.status === "pass");
  const detail: SessionLockDetail = {
    site,
    declaredHost,
    lockPath,
    snapshotPath: declaredPath,
    checked: measured,
    claims,
  };

  // A snapshot on disk with NO measurable claim is a named skip, never a pass.
  if (!measured) {
    return {
      ok: true,
      checked: [],
      skipped: [
        {
          site,
          reason: `declared snapshot present (${declaredPath}) but the lock declares no verifiable claim (no usable sha256Prefix, no cookies count) — nothing was checked`,
        },
      ],
      failures,
      details: [detail],
    };
  }

  return {
    ok: failures.length === 0,
    checked: [site],
    skipped: [],
    failures,
    details: [detail],
  };
}

/** Every `capabilities/<id>/session.lock.json` on disk, sorted by package id. */
export function listSessionLockPaths(capabilitiesDir = join(REPO_ROOT, "capabilities")): string[] {
  let entries: string[];
  try {
    entries = readdirSync(capabilitiesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries
    .map((id) => join(capabilitiesDir, id, "session.lock.json"))
    .filter((p) => existsSync(p))
    .sort();
}

/**
 * Verify EVERY committed session lock. Every lock file lands in exactly one
 * bucket (checked / skipped / failed) — a lock is never silently ignored.
 */
export function verifyCapabilitySessionLocks(opts: VerifySessionLockOptions = {}): SessionLockReport {
  const out: SessionLockReport = { ok: true, checked: [], skipped: [], failures: [], details: [] };
  for (const lockPath of listSessionLockPaths()) {
    const r = verifySessionLock(lockPath, opts);
    out.checked.push(...r.checked);
    out.skipped.push(...r.skipped);
    out.failures.push(...r.failures);
    out.details.push(...r.details);
  }
  out.ok = out.failures.length === 0;
  return out;
}

/** The per-package verdict shape `requirements` reports (mirrors VaultResult). */
export interface SessionLockResult {
  status: "pass" | "fail" | "skip";
  detail?: string;
  reason?: string;
}

/**
 * Lift ONE site's outcome out of a scan into a doctor verdict. A measured
 * mismatch is `fail` (the claim is FALSE); anything unmeasurable is `skip`
 * with the named reason (unverifiable is never reported as ready).
 */
export function sessionLockResultFor(site: string, report: SessionLockReport): SessionLockResult {
  const failed = report.failures.filter((f) => f.site === site);
  if (failed.length > 0) {
    return { status: "fail", reason: `session-lock claim is false — ${failed.map((f) => f.reason).join("; ")}` };
  }
  const detail = report.details.find((d) => d.site === site);
  if (!detail) {
    return {
      status: "skip",
      reason: `no capabilities/${site}/session.lock.json — this site declares no session-lock claim to verify`,
    };
  }
  const skipped = report.skipped.filter((s) => s.site === site);
  if (skipped.length > 0) {
    return { status: "skip", reason: `session-lock claim unverified — ${skipped.map((s) => s.reason).join("; ")}` };
  }
  const passed = detail.claims.filter((c) => c.status === "pass");
  return {
    status: "pass",
    detail: `session lock verified against ${detail.snapshotPath} — ${passed.map((c) => c.detail).join("; ")}`,
  };
}
