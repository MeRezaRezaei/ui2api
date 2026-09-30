#!/usr/bin/env bash
# scripts/ci/publish-github-release.sh — put the packaged artifact on GitHub, then
# READ IT BACK and prove it is what we built.
#
# GitHub is the release surface because the GitLab VPS may be deleted. A publish
# nobody can trace is a publish nobody can restore, and a publish nobody read back
# is a publish nobody knows happened. So the last step here is a read-back: fetch
# the release, fetch the asset, sha256 it, and compare against the sha of the
# bytes we built. If the read-back does not match, the job FAILS — it does not
# print a URL and hope.
#
# NO `gh` CLI: it is only present in the kit's node agent image, not in every
# image (the mirror job's comment says so explicitly). The REST API is reached
# with curl, which is asserted present by the caller, and the JSON is parsed with
# jq, which the caller also asserts.
#
# TOKEN HANDLING: $GH_TOKEN is read from the `agent-write` environment. It is
# never echoed, never written to a file, never placed in a URL (curl gets it in
# an Authorization header, which does not land in the log).
#
# USAGE: scripts/ci/publish-github-release.sh <release.env> <repo slug>
set -euo pipefail

ENVFILE="${1:?usage: publish-github-release.sh <release.env> <owner/repo>}"
REPO="${2:?usage: publish-github-release.sh <release.env> <owner/repo>}"

command -v curl >/dev/null || { echo "PUBLISH-FAIL: curl missing"; exit 1; }
command -v jq   >/dev/null || { echo "PUBLISH-FAIL: jq missing"; exit 1; }
[ -f "$ENVFILE" ] || { echo "PUBLISH-FAIL: no $ENVFILE — run package-release.sh first"; exit 1; }

# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a

# ---- NO TOKEN: skip loudly, never pretend. Never fail silently either: a
# green pipeline that quietly published nothing is a lie about durability.
if [ -z "${GH_TOKEN:-}" ]; then
  echo "RELEASE-SKIP: no GH_TOKEN in scope. The artifact was built and proven clean,"
  echo "             but NO GitHub Release was published. Nothing was faked."
  echo "             (GH_TOKEN is scoped to the agent-write environment; if this job"
  echo "              declares that environment and the var is still empty, set it there.)"
  exit 0
fi

: "${RELEASE_TAG:?}" "${RELEASE_NAME:?}" "${ASSET_NAME:?}" "${ASSET_PATH:?}" "${ASSET_SHA256:?}"
[ -s "$ASSET_PATH" ] || { echo "PUBLISH-FAIL: asset $ASSET_PATH is missing or empty"; exit 1; }

API="https://api.github.com"
AUTH=(-H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")
ghq() { timeout 60 curl -sSL "${AUTH[@]}" "$@"; }

echo "== publishing $ASSET_NAME to $REPO as tag $RELEASE_TAG =="

# ---- ALREADY EXISTS? Report it. Do NOT overwrite, and do NOT claim success.
# The tag is immutable by design — a tag that moves cannot answer "what was
# deployed on Tuesday". A re-run on the same sha therefore finds its own work
# already there, which is the correct, honest outcome.
EXIST_CODE="$(timeout 60 curl -sS -o /tmp/rel.json -w '%{http_code}' "${AUTH[@]}" \
  "$API/repos/$REPO/releases/tags/$RELEASE_TAG" || true)"
if [ "$EXIST_CODE" = "200" ]; then
  echo "RELEASE-EXISTS: tag $RELEASE_TAG already exists on $REPO (published earlier by this same sha)."
  echo "                Left untouched — the tag is immutable, so an existing release is NOT an error."
  echo "                url: $(jq -r '.html_url // "?"' /tmp/rel.json)"
  # Still run the read-back: the point is to report what is actually there.
else
  BODY="$(jq -n --arg tag "$RELEASE_TAG" --arg name "$RELEASE_NAME" \
      --arg sha "${GIT_SHA:-}" --arg pipe "${PIPELINE_ID:-}" \
      '{tag_name:$tag, name:$name, draft:false, prerelease:false,
        body:("ui2api build for `"+$sha+"`\n\n- pipeline: `"+$pipe+"`\n- packaged by `scripts/ci/package-release.sh`\n- contents: `dist/`, `capabilities/`, `scripts/ops/deploy.sh`, `package.json`, `package-lock.json`, `RELEASE-MANIFEST.json`\n- EXCLUDES `data/` (the session vault), `node_modules/`, `wigolo/`, `.git/`, `.npm/`, `.opencode-ci/`, `.gitlab/`\n")}')"
  CODE="$(timeout 120 curl -sS -o /tmp/create.json -w '%{http_code}' "${AUTH[@]}" \
    -X POST -H 'Content-Type: application/json' -d "$BODY" \
    "$API/repos/$REPO/releases")"
  if [ "$CODE" != "201" ]; then
    echo "PUBLISH-FAIL: GitHub refused to create the release (HTTP $CODE). Nothing was published."
    head -c 400 /tmp/create.json; echo
    exit 1
  fi
  echo "release created: $(jq -r '.html_url' /tmp/create.json)"

  UPURL="$(jq -r '.upload_url' /tmp/create.json | sed 's/{?.*//')"
  CODE="$(timeout 300 curl -sS -o /tmp/upload.json -w '%{http_code}' "${AUTH[@]}" \
    -X POST -H 'Content-Type: application/octet-stream' --data-binary "@$ASSET_PATH" \
    "$UPURL?name=$ASSET_NAME&label=$ASSET_NAME")"
  if [ "$CODE" != "201" ]; then
    echo "PUBLISH-FAIL: asset upload rejected (HTTP $CODE). The release EXISTS but has NO asset."
    head -c 400 /tmp/upload.json; echo
    exit 1
  fi
  echo "asset uploaded: $(jq -r '.browser_download_url' /tmp/upload.json)"
fi

# ---------------------------------------------------------------- READ-BACK --
# A publish you did not read back is not a publish. Re-query the release and
# re-download the asset, then compare the sha to the one we computed from our
# own bytes. Both the tag and the sha must match or the job fails.
echo "== read-back verification =="
RB_CODE="$(timeout 60 curl -sS -o /tmp/rb.json -w '%{http_code}' "${AUTH[@]}" \
  "$API/repos/$REPO/releases/tags/$RELEASE_TAG")"
[ "$RB_CODE" = "200" ] || { echo "PUBLISH-FAIL: read-back could not find tag $RELEASE_TAG (HTTP $RB_CODE)"; exit 1; }

RB_TAG="$(jq -r '.tag_name' /tmp/rb.json)"
RB_URL="$(jq -r '.html_url' /tmp/rb.json)"
RB_ASSET="$(jq -r --arg n "$ASSET_NAME" '.assets[] | select(.name==$n) | .name' /tmp/rb.json | head -1)"
RB_URL_A="$(jq -r --arg n "$ASSET_NAME" '.assets[] | select(.name==$n) | .browser_download_url' /tmp/rb.json | head -1)"

echo "  tag on GitHub : $RB_TAG"
echo "  release name  : $(jq -r '.name' /tmp/rb.json)"
echo "  asset name    : ${RB_ASSET:-<none>}"
echo "  release url   : $RB_URL"

[ "$RB_TAG" = "$RELEASE_TAG" ] || { echo "PUBLISH-FAIL: tag mismatch: built '$RELEASE_TAG', GitHub has '$RB_TAG'"; exit 1; }
[ "$RB_ASSET" = "$ASSET_NAME" ] || { echo "PUBLISH-FAIL: asset '$ASSET_NAME' not on the release (found '${RB_ASSET:-none}')"; exit 1; }
[ -n "$RB_URL_A" ] || { echo "PUBLISH-FAIL: no download URL for $ASSET_NAME"; exit 1; }

TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
timeout 300 curl -sSL "${AUTH[@]}" -o "$TMPD/$ASSET_NAME" "$RB_URL_A"
GOT="$(sha256sum "$TMPD/$ASSET_NAME" | cut -d' ' -f1)"
echo "  sha built     : $ASSET_SHA256"
echo "  sha downloaded: $GOT"
[ "$GOT" = "$ASSET_SHA256" ] || { echo "PUBLISH-FAIL: sha mismatch — what GitHub serves is NOT what we built"; exit 1; }

# The downloaded archive's own exclusions, re-checked on the bytes GitHub holds.
if tar -tzf "$TMPD/$ASSET_NAME" | grep -qE '^\./?(data|node_modules|wigolo|\.git|\.npm|\.opencode-ci|\.gitlab)/'; then
  echo "PUBLISH-FAIL: the SERVED asset contains a forbidden path"; exit 1
fi
echo "  served asset exclusions re-checked: clean"
echo "RELEASE-OK: $RELEASE_TAG verified at $RB_URL"
