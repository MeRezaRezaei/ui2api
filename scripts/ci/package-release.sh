#!/usr/bin/env bash
# scripts/ci/package-release.sh — build ONE immutable, durable build artifact.
#
# WHY THIS EXISTS
#   GitLab is the CI/CD actor. GitHub is the long-term store and the release
#   surface. The reason is not preference: the self-hosted GitLab VPS may be
#   deleted, and when it is, the only durable record of what was deployed must
#   already be somewhere else. This script produces that record — one tarball per
#   green main build, named after the commit it came from, carrying a manifest
#   that says which pipeline built it.
#
# WHAT IT PACKS (exactly this, nothing else)
#   dist/                        the compiled output that actually runs
#   capabilities/                manifests, profiles, recipes, session locks
#   scripts/ops/deploy.sh
#   package.json, package-lock.json
#   RELEASE-MANIFEST.json        written by this script, at the archive root
#
# WHAT IT MUST NEVER PACK
#   node_modules/  data/  wigolo/  .git/  .npm/  .opencode-ci/  .gitlab/
#
#   `data/` is the captured-session vault: REAL login state for REAL accounts.
#   It is already gitignored, and it must never enter an artifact either. A leak
#   there is the one failure this project cannot undo, so the exclusion is
#   STRUCTURAL (only four explicit paths are ever handed to tar — a prefix can
#   never sneak in) and is then PROVEN (the tarball's own listing is scanned and
#   the job dies if a forbidden prefix is present). A tar command that silently
#   includes a prefix is a real and easy failure; an assertion is cheaper than
#   discovering it later.
#
# USAGE
#   scripts/ci/package-release.sh [--out DIR]
#     --out DIR   where to write the tarball + manifest (default: .release)
#
# Everything it records is read from the ENVIRONMENT (CI_*) or computed here.
# Nothing is typed in by hand: a manifest with a hand-typed pipeline id is a
# lie that survives longer than the log that disproves it.
set -euo pipefail

OUT=".release"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    *) echo "package-release: unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

# ---------------------------------------------------------------- provenance --
# Read from the environment; fall back to git so a LOCAL dry run is honest
# about being local (local = empty pipeline id, never a fabricated one).
GIT_SHA="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
GIT_SHORT_SHA="${CI_COMMIT_SHORT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
PIPELINE_ID="${CI_PIPELINE_ID:-}"
PIPELINE_URL="${CI_PIPELINE_URL:-}"
NODE_VERSION="$(node --version)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# EXPORTED, not merely assigned. The manifest is written by a `node -e` child,
# which can only see what reached its environment — an unexported shell variable
# is invisible there and JSON.stringify silently DROPS the undefined key. (That
# is how the first dry run produced a manifest with `fileCount`/`totalBytes` and
# no `gitSha`, `pipelineId` or `builtAt` at all: provenance is the entire point
# of the manifest, and it had quietly evaporated.) Each value is also written as
# a `null` fallback below so a missing one is visible rather than absent.
export GIT_SHA GIT_SHORT_SHA PIPELINE_ID PIPELINE_URL NODE_VERSION BUILT_AT ASSET_NAME

ASSET_NAME="ui2api-${GIT_SHORT_SHA}.tar.gz"
TARBALL="$OUT/$ASSET_NAME"

# ------------------------------------------------------------- preconditions --
fail() { echo "PACKAGE-FAIL: $*" >&2; exit 1; }

# The four paths. Nothing else is ever passed to tar — this list IS the
# allow-list, which is the only way the exclusion cannot be forgotten.
PAYLOAD_PATHS=(dist capabilities scripts/ops/deploy.sh package.json package-lock.json)

for p in "${PAYLOAD_PATHS[@]}"; do
  [ -e "$p" ] || fail "payload path missing: $p (did npm run build run?)"
done
[ -f scripts/ops/deploy.sh ] || fail "scripts/ops/deploy.sh is missing or is not a file"

# `data/` is the vault. Refuse to proceed loudly if it is somehow tracked, rather
# than trusting .gitignore alone to have been correct forever.
if git ls-files --error-unmatch data >/dev/null 2>&1; then
  fail "data/ is TRACKED in git — the session vault must never be"
fi

# ------------------------------------------------------------------ staging --
# Stage into a clean directory so the tar is built from a known tree, not from
# whatever the CI workspace happened to contain. This is also what makes the
# "exactly these" claim checkable.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/root"
cp -R dist "$STAGE/root/dist"
cp -R capabilities "$STAGE/root/capabilities"
mkdir -p "$STAGE/root/scripts/ops"
cp scripts/ops/deploy.sh "$STAGE/root/scripts/ops/deploy.sh"
cp package.json package-lock.json "$STAGE/root/"

# Belt and braces: even though the stage dir only ever receives the four
# allow-listed paths, sweep it for the forbidden prefixes anyway.
#
# THE LIST IS NOT TYPED HERE. It is read from the single owner
# `scripts/ci/forbidden-release-paths.txt`. This sweep used to carry its own
# hand-written `for bad in data node_modules wigolo .git .npm .opencode-ci
# .gitlab` — which was MISSING `.brain/`, so it would not have stripped the
# operator's transcripts had they reached the stage dir. The stage dir only ever
# receives four allow-listed paths, so the sweep is belt-and-braces; a belt that
# lists fewer braces than the braces it is meant to cover is worse than no belt,
# because it reads as coverage.
FORBIDDEN_PATHS_FILE="$(dirname "$0")/forbidden-release-paths.txt"
[ -f "$FORBIDDEN_PATHS_FILE" ] || fail "forbidden-path list missing: $FORBIDDEN_PATHS_FILE"
while IFS= read -r bad; do
  [ -n "$bad" ] || continue
  # The list is written with PREFIXES (`data/`), the stage sweep needs a bare
  # directory name, so strip the trailing slash rather than duplicating the list.
  d="${bad%/}"
  if [ -e "$STAGE/root/$d" ]; then
    rm -rf "${STAGE:?}/root/$d"
    echo "PACKAGE-NOTE: stripped forbidden path that reached the stage dir: $d"
  fi
done < "$FORBIDDEN_PATHS_FILE"

# ----------------------------------------------------------------- manifest --
# Hashes are computed INSIDE the stage dir, so the manifest describes the
# archive that is about to be written, not a source tree that might drift.
MANIFEST="$STAGE/root/RELEASE-MANIFEST.json"
(
  cd "$STAGE/root"
  node -e '
    const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
    const root = ".";
    const skip = new Set(["RELEASE-MANIFEST.json"]); // cannot hash itself
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (e.isFile() && !skip.has(rel.replace(/^\.\//, ""))) {
          const buf = fs.readFileSync(rel);
          files.push({
            path: rel.replace(/^\.\//, ""),
            sha256: crypto.createHash("sha256").update(buf).digest("hex"),
            bytes: buf.length,
          });
        }
      }
    })(root);
    const m = {
      gitSha: process.env.GIT_SHA ?? null, gitShortSha: process.env.GIT_SHORT_SHA ?? null,
      pipelineId: process.env.PIPELINE_ID || null, pipelineUrl: process.env.PIPELINE_URL || null,
      nodeVersion: process.env.NODE_VERSION ?? null, builtAt: process.env.BUILT_AT ?? null,
      assetName: process.env.ASSET_NAME ?? null, fileCount: files.length,
      totalBytes: files.reduce((a, f) => a + f.bytes, 0),
      files,
    };
    fs.writeFileSync("RELEASE-MANIFEST.json", JSON.stringify(m, null, 2) + "\n");
  '
)
[ -s "$MANIFEST" ] || fail "RELEASE-MANIFEST.json was not written"

# ------------------------------------------------------------------- tarball --
mkdir -p "$OUT"
# The stage dir is removed by the EXIT trap, so the manifest is copied OUT of it
# before release.env is written — a MANIFEST_PATH into a deleted temp dir would
# be a pointer to nothing.
cp "$MANIFEST" "$OUT/RELEASE-MANIFEST.json"
# Deterministic-ish flags where the toolchain supports them; irrelevant to
# correctness, nice for reproducibility.
tar -czf "$TARBALL" -C "$STAGE/root" .
[ -s "$TARBALL" ] || fail "tarball was not written"

# ------------------------------------------------------------- PROVE IT ------
# The whole point: read the ARCHIVE back and assert the exclusions, instead of
# asserting that a tar command was written correctly.
LIST="$(tar -tzf "$TARBALL")"

# `.brain/` was MEASURED absent from the archive on 2026-10-01, but it was absent
# by omission rather than by rule, which is not a property worth relying on: the
# operator's raw transcripts are the single most damaging thing this repository
# could ship in a publicly downloadable asset, and a release tarball is exactly
# that. It is asserted now so a future change to the file list cannot leak it
# silently. The vault (`data/`) is here for the same reason and has always been.
#
# THE LIST IS NOT TYPED HERE EITHER — it is read from the single owner, the same
# `forbidden-release-paths.txt` the stage sweep above reads. This copy was the
# ONLY one of the three that carried `.brain/`, which is the whole point: a fact
# with one owner is a rule, and a fact typed into whichever file you happened to
# be editing is a hope. `publish-github-release.sh` re-checks the SERVED bytes
# against the same file, so the last line of defence on the public asset cannot
# drift away from this one.
FORBIDDEN_PREFIXES=()
while IFS= read -r bad; do
  [ -n "$bad" ] || continue
  FORBIDDEN_PREFIXES+=("$bad")
done < "$FORBIDDEN_PATHS_FILE"
for bad in "${FORBIDDEN_PREFIXES[@]}"; do
  # The `./` is OPTIONAL in the pattern and this is load-bearing. `tar -czf x .`
  # lists every entry as `./data/sessions/...`, so an anchored `^data/` matches
  # NOTHING and the assertion passes vacuously on exactly the archive it was
  # written to catch. (Measured: that is exactly what happened the first time.)
  if printf '%s\n' "$LIST" | grep -qE "^\./?${bad}"; then
    echo "PACKAGE-FAIL: forbidden path '$bad' IS in the archive. Refusing to ship." >&2
    printf '%s\n' "$LIST" | grep -E "^\./?${bad}" | head -5 >&2
    exit 1
  fi
done
echo "PACKAGE-OK: exclusions asserted absent: ${FORBIDDEN_PREFIXES[*]}"

# The required half of the contract, asserted positively. (`^\./?` for the same
# reason as above — the two must not disagree about the listing format.)
for req in RELEASE-MANIFEST.json package.json package-lock.json scripts/ops/deploy.sh; do
  printf '%s\n' "$LIST" | grep -qxE "\./?${req}" || { echo "PACKAGE-FAIL: $req is not in the archive" >&2; exit 1; }
done
printf '%s\n' "$LIST" | grep -qE '^\./?dist/' || { echo "PACKAGE-FAIL: dist/ missing from the archive" >&2; exit 1; }
printf '%s\n' "$LIST" | grep -qE '^\./?capabilities/' || { echo "PACKAGE-FAIL: capabilities/ missing from the archive" >&2; exit 1; }
echo "PACKAGE-OK: required paths asserted present (dist, capabilities, deploy.sh, package*.json, manifest)"

# The manifest's own view of the archive must match the archive's real contents.
node -e '
  const fs = require("node:fs"), cp = require("node:child_process");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const names = cp.execSync("tar -tzf " + process.argv[2], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n").map(s => s.trim())
    // DIRECTORY entries carry a trailing slash and are not hashed files, so they
    // are excluded from the comparison. Skipping them is not a loosening: the
    // manifest only ever claims `files`, and a directory is not one.
    .filter(s => s && s !== "./" && !s.endsWith("/"))
    .map(s => s.replace(/^\.\//, "")).sort();
  const want = m.files.map(f => f.path).sort();
  const missing = want.filter(p => !names.includes(p));
  const extra = names.filter(p => p !== "RELEASE-MANIFEST.json" && !want.includes(p));
  if (missing.length || extra.length) {
    console.error("MANIFEST-FAIL: manifest and archive disagree",
      "\n  in manifest only:", missing.slice(0, 5),
      "\n  in archive only:", extra.slice(0, 5));
    process.exit(1);
  }
  console.log(`PACKAGE-OK: manifest matches the archive exactly (${want.length} files, ${m.totalBytes} bytes of payload)`);
' "$MANIFEST" "$TARBALL"

ASSET_SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"

# Machine-readable result for the publish step, which reads it back rather than
# re-deriving anything.
cat > "$OUT/release.env" <<EOF
# Quoted: RELEASE_NAME contains spaces ("ui2api build <sha>") and this file is
# SOURCED by the publish step, so an unquoted value would be read as a command.
RELEASE_TAG='build-$GIT_SHORT_SHA'
RELEASE_NAME='ui2api build $GIT_SHA'
ASSET_NAME='$ASSET_NAME'
ASSET_PATH='$TARBALL'
ASSET_SHA256='$ASSET_SHA'
MANIFEST_PATH='$OUT/RELEASE-MANIFEST.json'
GIT_SHA='$GIT_SHA'
GIT_SHORT_SHA='$GIT_SHORT_SHA'
PIPELINE_ID='$PIPELINE_ID'
EOF

echo "TAG:      build-$GIT_SHORT_SHA"
echo "NAME:     ui2api build $GIT_SHA"
echo "ASSET:    $ASSET_NAME"
echo "SHA256:   $ASSET_SHA"
echo "BYTES:    $(wc -c < "$TARBALL")"
echo "FILES:    $(printf '%s\n' "$LIST" | grep -vc './$')"
