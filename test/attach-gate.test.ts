// GOAL 88 (2026-09-25): the attach gate — a file-upload capability must never be
// a general local-file-read primitive. Pins for src/runtime/file-attach.ts, the
// ONE validator every upload capability must pass, plus the integration pin that
// the real runners actually route through it (a gate nobody can bypass).
//
// THE MEASURED HOLE (re-verified, not assumed): duckduckgo_file_upload gated the
// payload on the CALLER-DECLARED mime —
//     ATTACH_ACCEPT.split(",").includes(file.mimeType)
// — and then readFileSync(file.path) + setInputFiles, so
//     file:{path:"…/.ssh/id_rsa", name:"a.png", mimeType:"image/png"}
// passed the gate and uploaded the private key. gemini/kimi (args.path) and
// youtube (args.filePath) had no gate at all.
//
// Node-only, hermetic: every fixture is a temp dir under os.tmpdir(); no
// browser, no network, no repo mutation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTACH_MAX_BYTES_ENV,
  ATTACH_ROOTS_ENV,
  DEFAULT_ATTACH_MAX_BYTES,
  attachMaxBytes,
  attachPayload,
  attachRoots,
  sniffContentType,
  validateAttachRequest,
} from "../src/runtime/file-attach.js";
import { REPO_ROOT } from "../src/runtime/session-lock.js";
import { resolvePackagedProfileFile } from "../src/profile/profile.js";
import { DuckduckgoCapabilities } from "../src/capabilities/duckduckgo.js";
import { GeminiCapabilities } from "../src/capabilities/gemini.js";
import { KimiCapabilities } from "../src/capabilities/kimi.js";
import { YouTubeCapabilities } from "../src/capabilities/youtube.js";

const RUNNER_DIR = fileURLToPath(new URL("../src/capabilities/", import.meta.url));
const PACKAGES_DIR = fileURLToPath(new URL("../capabilities/", import.meta.url));
// The measured duckduckgo accept attribute (the site's own input[type=file]).
const DDG_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf,.pdf";
const GUARD_SETTLE_TIMEOUT_MS = 7000;

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

/** A tiny REAL png: 8-byte signature + an IHDR chunk header (what the sniffer reads). */
function tinyPng(pad = 0): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
    Buffer.alloc(13),
    Buffer.from("IEND", "latin1"),
    Buffer.alloc(pad, 0x41),
  ]);
}

function tinyGif(): Buffer {
  return Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16, 0x42)]);
}

/** A private-key body — the exact payload the measured hole exfiltrated. */
const PRIVATE_KEY_BODY = [
  "REMOVED",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz",
  "c2gtZWQyNTUxOQAAACDrX3JI4G1yT7CV6z8G2oRxoAAAJgvUvXOO3Jm7MPFMAAAA",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

type Outcome<T> = { kind: "settled"; value: T } | { kind: "timeout" };

/** Race a runner call against a timeout: a browser launch would never settle in time. */
function settleWithinMs<T>(promise: Promise<T>, ms: number): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "settled", value });
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "timeout" });
      },
    );
  });
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function refused(v: unknown, expectedCode: string, label: string): void {
  const verdict = v as { ok: boolean; code?: string; message?: string };
  assert.equal(verdict.ok, false, `${label}: expected a refusal, got ok:true`);
  assert.equal(verdict.code, expectedCode, `${label}: expected code ${expectedCode}, got ${String(verdict.code)} — ${String(verdict.message)}`);
  assert.ok(String(verdict.message).length > 0, `${label}: a refusal must carry a named reason`);
}

// ─── 1. The exfiltration shape, refused ──────────────────────────────────────

test("exfiltration shape: a .ssh private key declared as image/png is REFUSED by the attach gate", () => {
  const dir = tempDir("attach-exfil-");
  try {
    mkdirSync(join(dir, ".ssh"), { recursive: true });
    const keyPath = join(dir, ".ssh", "id_rsa");
    writeFileSync(keyPath, PRIVATE_KEY_BODY, { mode: 0o600 });
    withEnv({ [ATTACH_ROOTS_ENV]: undefined }, () => {
      const v = validateAttachRequest(
        { file: { path: keyPath, name: "a.png", mimeType: "image/png" } },
        { siteId: "duckduckgo", accept: DDG_ACCEPT },
      );
      refused(v, "attach_secret_path", "exfiltration shape");
      assert.match(String((v as { message: string }).message), /attach_secret_path/);
      assert.match(String((v as { message: string }).message), /\.ssh/, "the message names the offending location");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exfiltration shape: private-key CONTENT is refused even when the caller sends it as bytes", () => {
  const v = validateAttachRequest(
    { file: { data: b64(Buffer.from(PRIVATE_KEY_BODY, "utf8")), name: "notes.png", mimeType: "image/png" } },
    { siteId: "duckduckgo", accept: DDG_ACCEPT },
  );
  refused(v, "attach_private_key_content", "key bytes over base64");
  assert.match(String((v as { message: string }).message), /private-key/i);
});

test("repo's own secrets are refused BY NAME with no root configured (data/, .git/, .brain/)", () => {
  // Path-based rule — no file is created or read, the repo is only named.
  for (const rel of [join(REPO_ROOT, ".git", "config"), join(REPO_ROOT, "data", "sessions"), join(REPO_ROOT, ".brain", "verbatim.md")]) {
    const v = validateAttachRequest({ path: rel }, { siteId: "gemini", accept: DDG_ACCEPT });
    refused(v, "attach_secret_path", `repo secret ${rel}`);
  }
});

// ─── 2. The declared type never wins over the real bytes ─────────────────────

test("a caller-declared image/png over NON-image bytes is refused quoting the SNIFFED type", () => {
  // Real GIF bytes, declared as image/png: the gate must answer with the type it
  // actually found (image/gif), never the caller's claim.
  const v = validateAttachRequest(
    { file: { data: b64(tinyGif()), name: "payload", mimeType: "image/png" } },
    { siteId: "duckduckgo", accept: "video/mp4" },
  );
  refused(v, "attach_mime_mismatch", "gif declared as png, accept=video");
  const msg = String((v as { message: string }).message);
  assert.match(msg, /image\/gif/, "the message quotes the SNIFFED type");
  assert.doesNotMatch(msg, /the SNIFFED type is image\/png/, "the caller's declared type is never echoed as the verdict");
});

test("a caller-declared image/png over magic-less text is refused as unrecognized content", () => {
  const v = validateAttachRequest(
    { file: { data: b64(Buffer.from("root:x:0:0::/root:/bin/bash\n", "utf8")), name: "passwd.png", mimeType: "image/png" } },
    { siteId: "duckduckgo", accept: DDG_ACCEPT },
  );
  refused(v, "attach_unrecognized_content", "passwd bytes declared as png");
});

test("a name whose extension disagrees with the bytes is refused (attach_extension_mismatch)", () => {
  const v = validateAttachRequest(
    { file: { data: b64(tinyGif()), name: "a.png", mimeType: "image/png" } },
    { siteId: "duckduckgo", accept: DDG_ACCEPT },
  );
  refused(v, "attach_extension_mismatch", "gif bytes named a.png");
  assert.match(String((v as { message: string }).message), /image\/gif/);
});

test("a legit PNG buffer IS accepted — the gate discriminates, it is not always-refusing", () => {
  const v = validateAttachRequest(
    { file: { data: b64(tinyPng()), name: "diagram.png", mimeType: "image/png" } },
    { siteId: "duckduckgo", accept: DDG_ACCEPT },
  );
  assert.equal(v.ok, true, `a real png must pass: ${JSON.stringify(v)}`);
  const ok = v as unknown as { ok: true; mimeType: string; name: string; buffer: Buffer; path: string };
  assert.equal(ok.mimeType, "image/png", "the reported type is the SNIFFED one");
  assert.equal(ok.name, "diagram.png");
  assert.equal(ok.path, "", "the buffer form reads nothing from disk");
  assert.ok(ok.buffer.length > 8);
  // The Playwright handoff payload carries the sniffed type, not the declared one.
  const payload = attachPayload(ok);
  assert.equal(payload.mimeType, "image/png");
  assert.equal(payload.buffer.length, ok.buffer.length);
});

test("an empty attach request is refused by name (attach_payload_missing)", () => {
  refused(validateAttachRequest({}, { siteId: "duckduckgo", accept: DDG_ACCEPT }), "attach_payload_missing", "no payload");
  refused(validateAttachRequest(undefined, { siteId: "kimi", accept: DDG_ACCEPT }), "attach_payload_missing", "undefined payload");
});

test("a URL attach source is refused by name — ui2api never fetches an attach", () => {
  refused(
    validateAttachRequest({ path: "https://example.com/x.png" }, { siteId: "gemini", accept: DDG_ACCEPT }),
    "attach_remote_source",
    "https source",
  );
});

// ─── 3. The path form: refused by default, confined when opted in ────────────

test("SAFE DEFAULT: with NO roots configured the path form is refused even for a file inside a temp dir", () => {
  const dir = tempDir("attach-noroot-");
  try {
    const png = join(dir, "ok.png");
    writeFileSync(png, tinyPng());
    withEnv({ [ATTACH_ROOTS_ENV]: undefined }, () => {
      assert.deepEqual(attachRoots(), [], "no roots are configured by default");
      refused(
        validateAttachRequest({ path: png }, { siteId: "duckduckgo", accept: DDG_ACCEPT }),
        "attach_roots_unconfigured",
        "path form with no roots",
      );
      // …while the buffer form for the very same file still passes (the safe form).
      assert.equal(
        validateAttachRequest({ data: b64(readFileSync(png)), name: "ok.png" }, { siteId: "duckduckgo", accept: DDG_ACCEPT }).ok,
        true,
        "caller-supplied bytes are always allowed",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an opted-in root accepts a real image inside it", () => {
  const dir = tempDir("attach-root-");
  try {
    const png = join(dir, "ok.png");
    writeFileSync(png, tinyPng());
    withEnv({ [ATTACH_ROOTS_ENV]: dir }, () => {
      const v = validateAttachRequest({ path: png }, { siteId: "duckduckgo", accept: DDG_ACCEPT });
      assert.equal(v.ok, true, `a png under an allowed root must pass: ${JSON.stringify(v)}`);
      assert.equal((v as { mimeType: string }).mimeType, "image/png");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("traversal (../../) out of an allowed root is refused with its own named reason", () => {
  const dir = tempDir("attach-traversal-");
  try {
    writeFileSync(join(dir, "ok.png"), tinyPng());
    withEnv({ [ATTACH_ROOTS_ENV]: dir }, () => {
      const traversal = resolve(join(dir, "..", "..", "etc", "hosts"));
      const v = validateAttachRequest({ path: join(dir, "..", "..", "etc", "hosts") }, { siteId: "duckduckgo", accept: DDG_ACCEPT });
      refused(v, "attach_path_outside_roots", "traversal out of the root");
      assert.match(String((v as { message: string }).message), new RegExp(traversal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a RELATIVE path is refused with its own named reason", () => {
  withEnv({ [ATTACH_ROOTS_ENV]: "/tmp" }, () => {
    refused(
      validateAttachRequest({ path: "../etc/passwd" }, { siteId: "gemini", accept: DDG_ACCEPT }),
      "attach_path_not_absolute",
      "relative path",
    );
  });
});

test("a symlink escaping an allowed root is refused with its own named reason", () => {
  const root = tempDir("attach-symlink-root-");
  const outside = tempDir("attach-symlink-out-");
  try {
    const secret = join(outside, "loot.png");
    writeFileSync(secret, tinyPng());
    const link = join(root, "innocent.png");
    symlinkSync(secret, link);
    withEnv({ [ATTACH_ROOTS_ENV]: root }, () => {
      const v = validateAttachRequest({ path: link }, { siteId: "duckduckgo", accept: DDG_ACCEPT });
      refused(v, "attach_symlink_escape", "symlink out of the root");
      assert.match(String((v as { message: string }).message), /symlink/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a symlink that hides a .ssh key behind an innocent name is refused by the realpath secret rule", () => {
  const root = tempDir("attach-symlink-secret-");
  try {
    mkdirSync(join(root, ".ssh"), { recursive: true });
    writeFileSync(join(root, ".ssh", "id_rsa"), PRIVATE_KEY_BODY, { mode: 0o600 });
    const link = join(root, "cute.png");
    symlinkSync(join(root, ".ssh", "id_rsa"), link);
    withEnv({ [ATTACH_ROOTS_ENV]: root }, () => {
      // The link itself lives inside the allowed root and carries an innocent
      // name — only the RESOLVED target is a secret location, and the gate
      // re-runs the secret rule on the realpath for exactly this case.
      const v = validateAttachRequest({ path: link }, { siteId: "duckduckgo", accept: DDG_ACCEPT });
      refused(v, "attach_secret_path", "symlink into .ssh");
      assert.match(String((v as { message: string }).message), /\.ssh/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── 4. The size cap ────────────────────────────────────────────────────────

test("an over-size payload is refused with its own named reason", () => {
  withEnv({ [ATTACH_MAX_BYTES_ENV]: "64" }, () => {
    const v = validateAttachRequest({ data: b64(tinyPng(4096)), name: "big.png" }, { siteId: "duckduckgo", accept: DDG_ACCEPT });
    refused(v, "attach_too_large", "over the cap");
    assert.match(String((v as { message: string }).message), new RegExp(ATTACH_MAX_BYTES_ENV));
  });
});

test("the size cap defaults to 20 MiB and a bogus value falls back to it", () => {
  withEnv({ [ATTACH_MAX_BYTES_ENV]: undefined }, () => {
    assert.equal(attachMaxBytes(), DEFAULT_ATTACH_MAX_BYTES);
    assert.equal(DEFAULT_ATTACH_MAX_BYTES, 20 * 1024 * 1024);
  });
  withEnv({ [ATTACH_MAX_BYTES_ENV]: "not-a-number" }, () => {
    assert.equal(attachMaxBytes(), DEFAULT_ATTACH_MAX_BYTES);
  });
  withEnv({ [ATTACH_MAX_BYTES_ENV]: "1024" }, () => {
    assert.equal(attachMaxBytes(), 1024);
  });
});

// ─── 5. Sniffer unit pins ────────────────────────────────────────────────────

test("the sniffer reads the REAL bytes only, and returns null for anything unknown", () => {
  assert.equal(sniffContentType(tinyPng()), "image/png");
  assert.equal(sniffContentType(tinyGif()), "image/gif");
  assert.equal(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffContentType(Buffer.from("%PDF-1.7\n", "latin1")), "application/pdf");
  assert.equal(sniffContentType(Buffer.from("PK\u0003\u0004rest-of-zip", "latin1")), "application/zip");
  assert.equal(sniffContentType(Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1")), "image/webp");
  assert.equal(sniffContentType(Buffer.from("just some text, no signature at all", "utf8")), null);
  assert.equal(sniffContentType(Buffer.alloc(0)), null);
  assert.equal(sniffContentType(Buffer.from(PRIVATE_KEY_BODY, "utf8")), null);
});

// ─── 6. INTEGRATION: the real runners cannot bypass the gate ────────────────
//
// Two proofs, because a gate is only real if the runners actually pass through
// it: (a) a source-level pin on every upload runner, and (b) the runner's own
// exported handler invoked with the measured exfiltration payload, asserted to
// settle FAST (no browser) with the named refusal. A future edit that routes a
// runner back to a raw setInputFiles(path) fails BOTH.

const UPLOAD_RUNNERS: Array<{ id: string; capability: string; file: string; make: (p: never) => { run: (c: string, a?: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }> } }> = [
  { id: "duckduckgo", capability: "duckduckgo_file_upload", file: "duckduckgo.ts", make: (p) => new DuckduckgoCapabilities(p) },
  { id: "gemini", capability: "gemini_file_upload", file: "gemini.ts", make: (p) => new GeminiCapabilities(p) },
  { id: "kimi", capability: "kimi_file_upload", file: "kimi.ts", make: (p) => new KimiCapabilities(p) },
  { id: "youtube", capability: "youtube_upload", file: "youtube.ts", make: (p) => new YouTubeCapabilities(p) },
];

for (const runner of UPLOAD_RUNNERS) {
  test(`${runner.id}: ${runner.capability} routes through the shared attach gate (source pin)`, () => {
    const src = readFileSync(join(RUNNER_DIR, runner.file), "utf8");
    assert.match(src, /from "\.\.\/runtime\/file-attach\.js"/, `${runner.id} must import the shared gate`);
    assert.match(src, /validateAttachRequest\(/, `${runner.id} must call the shared validator`);
    assert.match(src, /attachPayload\(/, `${runner.id} must hand over the gated bytes via attachPayload()`);
    assert.doesNotMatch(src, /readFileSync\(/, `${runner.id} must not read an attach path itself`);
    assert.doesNotMatch(
      src,
      /ATTACH_ACCEPT\.split\([^\n]*includes\(/,
      `${runner.id} must not gate on the caller-declared mime (the measured hole)`,
    );
  });

  test(`${runner.id}: ${runner.capability} REFUSES the exfiltration payload without launching a browser`, async () => {
    const dir = tempDir(`attach-runner-${runner.id}-`);
    try {
      mkdirSync(join(dir, ".ssh"), { recursive: true });
      const keyPath = join(dir, ".ssh", "id_rsa");
      writeFileSync(keyPath, PRIVATE_KEY_BODY, { mode: 0o600 });
      const profile = resolvePackagedProfileFile(join(PACKAGES_DIR, runner.id, "profile.json"));
      const caps = runner.make(profile as never);
      const outcome = await settleWithinMs(
        caps.run(runner.capability, { file: { path: keyPath, name: "a.png", mimeType: "image/png" } }),
        GUARD_SETTLE_TIMEOUT_MS,
      );
      assert.equal(outcome.kind, "settled", `${runner.id} did not settle in ${GUARD_SETTLE_TIMEOUT_MS}ms — it opened a browser before gating`);
      if (outcome.kind !== "settled") return;
      assert.equal(outcome.value.ok, false, `${runner.id} must refuse the exfiltration payload`);
      const err = String(outcome.value.error ?? "");
      assert.match(err, /attach_(secret_path|roots_unconfigured|path_outside_roots)/, `${runner.id} must answer with a NAMED gate refusal, got: ${err}`);
      assert.match(err, /attach_refused/, `${runner.id} must name the refusal code attach_refused, got: ${err}`);
      assert.doesNotMatch(err, /ENOENT|EACCES|stack/i, `${runner.id} must not leak a raw fs error`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
