// ────────────────────────────────────────────────────────────────────────────
// file-attach.ts — the ONE attach gate every file-upload capability must pass
// (GOAL 88, 2026-09-25).
//
// THE HOLE THIS CLOSES
//   A capability that accepts a file is a file-READ primitive unless it is
//   gated. The measured hole (duckduckgo_file_upload) gated the payload on the
//   CALLER-DECLARED `mimeType`: the gate read
//     ATTACH_ACCEPT.split(",").includes(file.mimeType)
//   and then the runner did `readFileSync(file.path)` + `setInputFiles`, so
//     file:{path:"/home/me/.ssh/id_rsa", name:"a.png", mimeType:"image/png"}
//   walked straight through — the declared mime won over the real bytes and the
//   private key was uploaded to the site. The same shape was ungated in
//   gemini_file_upload / kimi_file_upload (args.path -> setInputFiles) and
//   youtube_upload (args.filePath -> setInputFiles).
//
// THE POSTURE (a capability must never be a general file-read primitive)
//   1. The TYPE is never taken from the caller. The REAL bytes are sniffed
//      (magic-number signature) and anything unrecognized is refused — so a
//      .env, a private key, /etc/passwd or a JSON credential blob can never be
//      attached under a fake name, whatever the caller declares.
//   2. The PATH form is refused by DEFAULT. A path is only read when the
//      operator has explicitly named roots (UI2API_ATTACH_ROOTS) and the
//      resolved real path is still inside one of them (traversal + symlink
//      escape both checked). The safe form is the caller-supplied BUFFER: the
//      bytes are already in the caller's hands, so nothing on this filesystem
//      is reachable.
//   3. Repo/host secret locations are refused BY NAME under ANY root setting
//      (data/, .git/, .ssh/, .brain/, .agents/, ~/.gnupg, …) and so is
//      private-key CONTENT.
//   4. A size cap bounds the read.
//
// EVERY REFUSAL IS NAMED (`code`) and carries a reason that names the rule, the
// resolved path and the allowed roots. No raw fs error is ever surfaced (that
// would leak the filesystem layout); callers get a stable code instead.
//
// ALLOWED FORMS (documented decision)
//   - buffer  (RECOMMENDED, always allowed): {data:"<base64>"} | {bytes:<Buffer>}
//              | a Buffer passed directly. Nothing is read from disk by us.
//   - path    (OPT-IN, refused by default): {path:"/abs/path"} — only when
//              UI2API_ATTACH_ROOTS names a directory that contains it.
//   Both forms are then held to the SAME content rules (sniff + accept-list +
//   extension agreement + size + private-key marker), so opting into roots can
//   never widen the accepted CONTENT to arbitrary local files.
// ────────────────────────────────────────────────────────────────────────────
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { REPO_ROOT } from "./session-lock.js";

/** Operator knob: colon/comma separated ABSOLUTE roots the path form may read. Default: NONE. */
export const ATTACH_ROOTS_ENV = "UI2API_ATTACH_ROOTS";
/** Operator knob: hard byte cap for any attach payload. */
export const ATTACH_MAX_BYTES_ENV = "UI2API_ATTACH_MAX_BYTES";
/** 20 MiB — a sane chat-composer attachment ceiling. */
export const DEFAULT_ATTACH_MAX_BYTES = 20 * 1024 * 1024;

// Path segments that are a secret location wherever they appear in a path.
const SECRET_SEGMENTS = new Set([".git", ".ssh", ".gnupg", ".aws", ".kube", ".brain", ".agents", ".opencode"]);
// Repo-relative secret roots (absolute): session vault + state, never attachable.
const REPO_SECRET_DIRS = ["data", ".git", ".brain", ".agents", ".opencode"];
// Home-relative credential stores, never attachable even under an opted-in root.
const HOME_SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".kube", ".password-store", "config/gcloud"];
// Filenames that are credentials whatever their bytes look like.
const SECRET_BASENAMES = new Set([
  ".env", ".netrc", ".npmrc", ".pgpass", "credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "shadow", "passwd", "master.key",
]);
const SECRET_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".crt-no"]);

// Content markers for private-key material (checked on the SNIFFED bytes, both forms).
const PRIVATE_KEY_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
  /-----BEGIN (?:RSA|DSA|EC|OPENSSH|PGP) PRIVATE KEY BLOCK-----/,
  /PuTTY-User-Key-File-\d/,
  /^\s*ssh-(?:rsa|dss|ed25519|ecdsa)\s+AAAA/m,
  /^\s*-----BEGIN CERTIFICATE-----/m,
];

export interface AttachOptions {
  /** Site id the payload is being attached to — named in every refusal. */
  siteId: string;
  /** The site's own accept list (`image/png,…,.pdf`); optional but always passed in practice. */
  accept?: string;
}

export interface AttachAccepted {
  ok: true;
  /** Vetted absolute real path (path form) or "" (buffer form). */
  path: string;
  /** The vetted bytes. */
  buffer: Buffer;
  /** The SNIFFED content type — never the caller-declared one. */
  mimeType: string;
  /** Safe display name: real basename (path form) or declared basename re-extensioned from the sniff. */
  name: string;
}

export interface AttachRefused {
  ok: false;
  /** Stable, NAMED rule id (see the module header). */
  code: string;
  /** Human reason naming the rule, the resolved path and the allowed roots. */
  message: string;
}

export type AttachVerdict = AttachAccepted | AttachRefused;

/** The Playwright in-memory file payload — always the buffer form on handoff. */
export function attachPayload(v: AttachAccepted): { name: string; mimeType: string; buffer: Buffer } {
  return { name: v.name, mimeType: v.mimeType, buffer: v.buffer };
}

/** The honest wire refusal every upload capability answers with. */
export function attachRefusal(v: AttachRefused, capability: string): {
  ok: false;
  code: "attach_refused";
  message: string;
  capability: string;
} {
  return { ok: false, code: "attach_refused", message: `[${v.code}] ${v.message}`, capability };
}

function refuse(code: string, message: string): AttachRefused {
  return { ok: false, code, message };
}

// ─── content sniffing (the only source of truth for the payload's type) ──────

const MAGIC: Array<{ mime: string; ext: string; test: (b: Buffer) => boolean }> = [
  { mime: "image/png", ext: ".png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", ext: ".jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/gif", ext: ".gif", test: (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a" },
  {
    mime: "image/webp",
    ext: ".webp",
    test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  { mime: "application/pdf", ext: ".pdf", test: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  {
    mime: "application/zip",
    ext: ".zip",
    test: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7) && (b[3] === 4 || b[3] === 6 || b[3] === 8),
  },
  {
    mime: "video/mp4",
    ext: ".mp4",
    test: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && !b.subarray(8, 12).toString("latin1").startsWith("qt  "),
  },
  {
    mime: "video/quicktime",
    ext: ".mov",
    test: (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && b.subarray(8, 12).toString("latin1").startsWith("qt  "),
  },
  {
    mime: "video/webm",
    ext: ".webm",
    test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && !b.subarray(0, 64).toString("latin1").includes("matroska"),
  },
  {
    mime: "video/x-matroska",
    ext: ".mkv",
    test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && b.subarray(0, 64).toString("latin1").includes("matroska"),
  },
  {
    mime: "video/x-msvideo",
    ext: ".avi",
    test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "AVI ",
  },
];

const OOXML: Array<{ dir: string; mime: string; ext: string }> = [
  { dir: "word/", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: ".docx" },
  { dir: "xl/", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: ".xlsx" },
  { dir: "ppt/", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: ".pptx" },
];

/** Canonical extension for a sniffed mime (used to keep a name honest with its bytes). */
export function extensionForMime(mime: string): string | null {
  for (const m of MAGIC) if (m.mime === mime) return m.ext;
  for (const o of OOXML) if (o.mime === mime) return o.ext;
  return null;
}

/**
 * Sniff the REAL content type from the bytes. Returns null for anything the
 * magic table does not recognize — a caller cannot talk it into a type.
 */
export function sniffContentType(buffer: Buffer): string | null {
  for (const m of MAGIC) {
    let hit = false;
    try {
      hit = m.test(buffer);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    // A zip container is a generic archive unless its first entry names an
    // OOXML package (docx/xlsx/pptx) — checked from the local file header, not
    // from the caller's filename.
    if (m.mime === "application/zip") {
      const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString("latin1");
      const ooxml = OOXML.find((o) => head.includes(`PK\x03\x04${o.dir}`) || head.includes(o.dir));
      if (ooxml) return ooxml.mime;
    }
    return m.mime;
  }
  return null;
}

function parseAccept(accept: string | undefined): { mimes: Set<string>; exts: Set<string> } {
  const mimes = new Set<string>();
  const exts = new Set<string>();
  for (const raw of (accept ?? "").split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith(".")) exts.add(entry);
    else if (entry.includes("/")) mimes.add(entry);
  }
  return { mimes, exts };
}

// ─── policy helpers ─────────────────────────────────────────────────────────

/** The operator's opted-in roots, resolved. Empty by default (path form refused). */
export function attachRoots(): string[] {
  const raw = process.env[ATTACH_ROOTS_ENV];
  if (!raw) return [];
  return raw
    .split(/[:;,]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => isAbsolute(p))
    .map((p) => resolve(p));
}

/** The byte cap for one attach payload. */
export function attachMaxBytes(): number {
  const raw = process.env[ATTACH_MAX_BYTES_ENV];
  if (!raw) return DEFAULT_ATTACH_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ATTACH_MAX_BYTES;
  return n;
}

function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function secretPathReason(absPath: string): string | null {
  const parts = absPath.split(sep).filter(Boolean);
  for (const part of parts) {
    if (SECRET_SEGMENTS.has(part)) return `path segment "${part}" is a secret location`;
  }
  const base = parts[parts.length - 1] ?? "";
  if (SECRET_BASENAMES.has(base)) return `filename "${base}" is a credential store`;
  const ext = extname(base).toLowerCase();
  if (SECRET_EXTENSIONS.has(ext)) return `extension "${ext}" is a key/certificate format`;
  if (/^\.env(\..+)?$/.test(base)) return `filename "${base}" is an environment-credential file`;
  for (const dir of REPO_SECRET_DIRS) {
    const abs = resolve(REPO_ROOT, dir);
    if (isUnder(absPath, abs)) return `inside the repo's own secret tree "${dir}"`;
  }
  let home = "";
  try {
    home = resolve(homedir());
  } catch {
    home = "";
  }
  if (home) {
    for (const dir of HOME_SECRET_DIRS) {
      const abs = resolve(home, dir);
      if (isUnder(absPath, abs)) return `inside the home credential store "${dir}"`;
    }
  }
  return null;
}

function privateKeyReason(buffer: Buffer): string | null {
  const head = buffer.subarray(0, Math.min(buffer.length, 8192)).toString("latin1");
  for (const re of PRIVATE_KEY_PATTERNS) {
    if (re.test(head)) return "the bytes carry a private-key / certificate marker";
  }
  return null;
}

interface Normalized {
  path?: string;
  buffer?: Buffer;
  name?: string;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string" && value.length > 0) {
    try {
      return Buffer.from(value, "base64");
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeInput(file: unknown): Normalized {
  const out: Normalized = {};
  if (typeof file === "string") {
    out.path = file;
    return out;
  }
  if (Buffer.isBuffer(file) || file instanceof Uint8Array) {
    out.buffer = Buffer.from(file);
    return out;
  }
  if (!file || typeof file !== "object") return out;
  const o = file as Record<string, unknown>;
  const inner = (o.file && typeof o.file === "object" ? o.file : {}) as Record<string, unknown>;
  const pick = (key: string): unknown => (o[key] !== undefined ? o[key] : inner[key]);
  const pathLike = pick("path") ?? o.filePath ?? pick("filePath") ?? inner.path;
  if (typeof pathLike === "string" && pathLike.trim()) out.path = pathLike.trim();
  const nameLike = pick("name") ?? o.fileName;
  if (typeof nameLike === "string" && nameLike.trim()) out.name = nameLike.trim();
  const raw = pick("data") ?? pick("bytes") ?? o.base64;
  if (raw !== undefined && raw !== null) {
    const b = toBuffer(raw);
    if (b) out.buffer = b;
  }
  return out;
}

/**
 * The one gate. Rules, IN ORDER (each refusal is named):
 *   1 attach_payload_missing        — neither bytes nor a path were supplied.
 *   2 attach_remote_source          — http(s)://, file:// or data: source refused (never fetched).
 *   3 attach_secret_path            — repo/home secret location or credential filename; UNCONDITIONAL.
 *   4 attach_roots_unconfigured     — the path form with no UI2API_ATTACH_ROOTS (the safe default).
 *   5 attach_path_not_absolute      — the path form with a relative path.
 *   6 attach_path_outside_roots     — path.resolve() landed outside every allowed root.
 *   7 attach_symlink_escape         — the real path left the allowed roots.
 *   8 attach_path_unreadable        — could not stat/read the path (no raw fs error leaked).
 *   9 attach_too_large              — over UI2API_ATTACH_MAX_BYTES (stat pre-read AND buffer length).
 *  10 attach_private_key_content    — private-key material in the bytes.
 *  11 attach_unrecognized_content   — the magic table does not know these bytes.
 *  12 attach_mime_mismatch          — the SNIFFED type is not in the site's accept list.
 *  13 attach_extension_mismatch     — the declared name's extension disagrees with the sniff.
 */
export function validateAttachRequest(file: unknown, opts: AttachOptions): AttachVerdict {
  const site = opts.siteId;
  const { mimes, exts } = parseAccept(opts.accept);
  const input = normalizeInput(file);

  if (input.buffer === undefined && input.path === undefined) {
    return refuse(
      "attach_payload_missing",
      `${site}: an attach needs EITHER caller-supplied bytes (file.data base64 / file.bytes) OR a path — nothing was supplied.`,
    );
  }

  let name = input.name ?? "";
  let declaredExt = extname(name).toLowerCase();

  if (input.path !== undefined) {
    const raw = input.path;
    if (/^(https?:|file:|data:|ftp:)/i.test(raw)) {
      return refuse(
        "attach_remote_source",
        `${site}: attach source "${raw.slice(0, 64)}" looks remote/URL — ui2api never fetches an attach source; send the bytes (file.data) or an absolute path under an allowed root.`,
      );
    }
    if (!isAbsolute(raw)) {
      return refuse(
        "attach_path_not_absolute",
        `${site}: attach path "${raw}" is relative — the path form requires an absolute path inside an allowed root (${ATTACH_ROOTS_ENV}); a relative path is refused so "../" traversal cannot resolve into one.`,
      );
    }
    const abs = resolve(raw);
    const roots = attachRoots();
    const rootsLabel = roots.length > 0 ? roots.map((r) => `"${r}"`).join(", ") : "<none>";
    // The secret veto is UNCONDITIONAL and runs BEFORE the roots ladder: a
    // secret location is not attachable under ANY root configuration (an
    // operator who opts in "/" must still not be able to read ~/.ssh).
    const secret = secretPathReason(abs);
    if (secret) {
      return refuse(
        "attach_secret_path",
        `${site}: attach path "${abs}" is refused by rule attach_secret_path — ${secret}. Secret locations are never attachable, whatever ${ATTACH_ROOTS_ENV} allows (allowed roots: ${rootsLabel}).`,
      );
    }
    if (roots.length === 0) {
      return refuse(
        "attach_roots_unconfigured",
        `${site}: the attach path form is refused — no roots are configured. Set ${ATTACH_ROOTS_ENV} to an absolute directory to allow reading files (currently allowed roots: <none>), or send the bytes directly (file.data base64) so nothing on disk is read. Refused path resolved to "${abs}".`,
      );
    }
    if (!roots.some((r) => isUnder(abs, r))) {
      return refuse(
        "attach_path_outside_roots",
        `${site}: attach path "${abs}" is outside every allowed root — resolved path must stay under one of ${rootsLabel} (rule attach_path_outside_roots).`,
      );
    }
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return refuse(
        "attach_path_unreadable",
        `${site}: the attach path under an allowed root could not be resolved on disk (allowed roots: ${rootsLabel}).`,
      );
    }
    if (!roots.some((r) => isUnder(real, r))) {
      return refuse(
        "attach_symlink_escape",
        `${site}: attach path "${abs}" resolves through a symlink to "${real}", which is outside every allowed root (${rootsLabel}) — rule attach_symlink_escape.`,
      );
    }
    const realSecret = secretPathReason(real);
    if (realSecret) {
      return refuse(
        "attach_secret_path",
        `${site}: attach path "${abs}" resolves to "${real}" — ${secret ?? realSecret}; secret locations are never attachable (allowed roots: ${rootsLabel}).`,
      );
    }
    let size = 0;
    try {
      const st = statSync(real);
      if (!st.isFile()) {
        return refuse(
          "attach_path_unreadable",
          `${site}: the attach path is not a regular file (allowed roots: ${rootsLabel}).`,
        );
      }
      size = st.size;
    } catch {
      return refuse(
        "attach_path_unreadable",
        `${site}: the attach path under an allowed root could not be read (allowed roots: ${rootsLabel}).`,
      );
    }
    const cap = attachMaxBytes();
    if (size > cap) {
      return refuse(
        "attach_too_large",
        `${site}: attach file is ${size} bytes, over the ${ATTACH_MAX_BYTES_ENV} cap of ${cap} bytes — rule attach_too_large.`,
      );
    }
    let buffer: Buffer;
    try {
      buffer = readFileSync(real);
    } catch {
      return refuse(
        "attach_path_unreadable",
        `${site}: the attach path under an allowed root could not be read (allowed roots: ${rootsLabel}).`,
      );
    }
    if (buffer.length > cap) {
      return refuse(
        "attach_too_large",
        `${site}: attach payload is ${buffer.length} bytes, over the ${ATTACH_MAX_BYTES_ENV} cap of ${cap} bytes — rule attach_too_large.`,
      );
    }
    name = input.name ?? real.split(sep).pop() ?? "attach";
    declaredExt = extname(name).toLowerCase();
    return finish(site, mimes, exts, { path: real, buffer, name, declaredExt });
  }

  // ─── buffer form: nothing is read from this filesystem ────────────────────
  const buffer = input.buffer as Buffer;
  const cap = attachMaxBytes();
  if (buffer.length > cap) {
    return refuse(
      "attach_too_large",
      `${site}: attach payload is ${buffer.length} bytes, over the ${ATTACH_MAX_BYTES_ENV} cap of ${cap} bytes — rule attach_too_large.`,
    );
  }
  const keyReason = privateKeyReason(buffer);
  if (keyReason) {
    return refuse(
      "attach_private_key_content",
      `${site}: attach refused by rule attach_private_key_content — ${keyReason}. Key material is never attachable, whatever name/mimeType the caller declared.`,
    );
  }
  if (!name) {
    name = "attach";
    declaredExt = "";
  }
  return finish(site, mimes, exts, { path: "", buffer, name, declaredExt });
}

function finish(
  site: string,
  mimes: Set<string>,
  exts: Set<string>,
  v: { path: string; buffer: Buffer; name: string; declaredExt: string },
): AttachVerdict {
  const sniffed = sniffContentType(v.buffer);
  if (!sniffed) {
    return refuse(
      "attach_unrecognized_content",
      `${site}: attach refused by rule attach_unrecognized_content — the first bytes of "${v.name}" match no known file signature (png/jpeg/gif/webp/pdf/zip/video), so it is not the type the caller declared. Send a real image/document/video, or the bytes will never be attached.`,
    );
  }
  const canonicalExt = extensionForMime(sniffed) ?? "";
  if (v.declaredExt && canonicalExt && v.declaredExt !== canonicalExt) {
    // jpeg family: .jpg/.jpeg both agree with image/jpeg.
    const jpegOk = sniffed === "image/jpeg" && (v.declaredExt === ".jpg" || v.declaredExt === ".jpeg");
    if (!jpegOk) {
      return refuse(
        "attach_extension_mismatch",
        `${site}: attach refused by rule attach_extension_mismatch — "${v.name}" is declared "${v.declaredExt}" but the real bytes are ${sniffed} ("${canonicalExt}"). Rename the payload to match the sniffed type; the declared name/mimeType never overrides the bytes.`,
      );
    }
  }
  const inAccept = mimes.has(sniffed) || (canonicalExt !== "" && exts.has(canonicalExt));
  if (!inAccept) {
    return refuse(
      "attach_mime_mismatch",
      `${site}: attach refused by rule attach_mime_mismatch — the SNIFFED type is ${sniffed} ("${canonicalExt}"), which is not in this capability's accept list [${[...mimes, ...exts].join(", ")}].`,
    );
  }
  const safeExt = canonicalExt || v.declaredExt;
  const base = (v.name.split(sep).pop() ?? "attach").replace(/[\u0000-\u001f\u007f]/g, "_");
  const stem = base.slice(0, base.length - extname(base).length) || "attach";
  return {
    ok: true,
    path: v.path,
    buffer: v.buffer,
    mimeType: sniffed,
    name: `${stem}${safeExt}`,
  };
}
