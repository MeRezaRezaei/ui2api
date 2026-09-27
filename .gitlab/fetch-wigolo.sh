#!/bin/sh
# Fetch the wigolo upstream at an EXACT pinned commit, shallowly.
#
# WHY THIS EXISTS — a real CI outage, measured on pipeline 201 (job 378):
#
#   $ git clone --depth 1 https://github.com/KnockOutEZ/wigolo.git "$DIR"
#   $ cd "$DIR" && git checkout d69bf773be06f29fc1d335f8ba35ec88457ac707
#   fatal: reference is not a tree: d69bf773be06f29fc1d335f8ba35ec88457ac707
#
# `git clone --depth 1` fetches ONLY the tip of the default branch. The pin was
# written when that tip WAS the pin, so the two lines agreed by accident. The
# moment upstream moved on (tip became da59eee) the pinned commit was no longer
# in the clone and the whole BUILD job died at exit 128 — before a single line
# of this project's code was compiled, and the `verify` job was SKIPPED. A pin
# and a shallow clone are only compatible while the pin happens to be the tip,
# which is a coincidence, not a guarantee.
#
# The fix is to fetch the SHA DIRECTLY instead of cloning a branch and hoping the
# SHA is in it. GitHub serves an arbitrary reachable SHA on request
# (uploadpack.allowAnySHA1InWant), so this stays shallow — we still never pull
# wigolo's history, which is what made the artifact upload 413 in pipeline 173.
#
# Usage: fetch-wigolo.sh <dest-dir> <pinned-sha> [repo-url]

set -eu

DEST="${1:?usage: fetch-wigolo.sh <dest-dir> <pinned-sha> [repo-url]}"
SHA="${2:?usage: fetch-wigolo.sh <dest-dir> <pinned-sha> [repo-url]}"
URL="${3:-https://github.com/KnockOutEZ/wigolo.git}"

case "$SHA" in
  [0-9a-f][0-9a-f]*) ;;
  *) echo "fetch-wigolo: '$SHA' is not a commit sha — refusing to check out a moving ref" >&2; exit 2 ;;
esac

rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -q
git remote add origin "$URL"
git fetch -q --depth 1 origin "$SHA"
git checkout -q --detach FETCH_HEAD

GOT="$(git rev-parse HEAD)"
if [ "$GOT" != "$SHA" ]; then
  echo "fetch-wigolo: checked out $GOT but the pin is $SHA — refusing to run against an unpinned tree" >&2
  exit 3
fi
echo "fetch-wigolo: $URL @ $GOT"
