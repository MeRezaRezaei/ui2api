#!/usr/bin/env bash
# scripts/ci/assert-repo-visibility.sh
#
# PROVE a push destination's REAL visibility before anything is pushed to it.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS, AND WHY IT IS NOT THE HANDED-OVER FIX
# ---------------------------------------------------------------------------
# The handover said: "assert `api.github.com/repos/$GITHUB_REPO -> .private ==
# true` before pushing". That instruction is REFUSED HERE, and the refusal is
# the content of this script's design rather than a disagreement about style.
#
# `GITHUB_REPO` is `MeRezaRezaei/ui2api`, which is DELIBERATELY PUBLIC. An
# assertion of `private == true` against it is not a safety check; it is an
# assertion of the OPPOSITE of the intended steady state, and a gate that cannot
# open is not a gate. This repository already paid for that lesson once: the
# `public-verified` marker was, for two pipelines, a condition that could never
# be satisfied ("a gate that cannot open is not a gate" — `.gitlab-ci.yml:392`).
# Shipping a second cannot-open gate, on the same push, would be the same defect
# in a new costume.
#
# So the probe is asked the question whose answer is LOAD-BEARING, which is not
# "is the public repo private" but:
#
#   - is the destination the repo this job configured?   (identity)
#   - is its visibility the one this job DECLARES it to be? (declared topology)
#   - and can that be ESTABLISHED at all, right now, over a real API call?
#
# The third is the one that does the protecting. Every refusal below is a
# FAIL-CLOSED refusal: an unreachable API, a non-200, an unparseable body, a
# missing field, a self-contradictory body, or a repo we cannot name all REFUSE.
# None of them continue. That is deliberate and it is the crux of the design: a
# probe that fails OPEN on a network error manufactures exactly the false
# confidence it exists to prevent — worse than having no probe, because a green
# probe is evidence. So the rule of this file is one line:
#
#     AN UNKNOWN VISIBILITY IS NOT A PRIVATE ONE.  IT REFUSES.
#
# ---------------------------------------------------------------------------
# WHERE IT LIVES, and why it is NOT inside scripts/ci/make-public-repo.sh
# ---------------------------------------------------------------------------
# `make-public-repo.sh` is a MEASUREMENT INSTRUMENT. Its own header says "THIS
# SCRIPT PUSHES NOTHING", it builds a hermetic sandbox outside the repo, and its
# value is that it answers one question — is this tree free of corpus? — with no
# network, no token and no GitHub dependency. Making it fetch api.github.com
# would couple the ability to PROVE A TREE IS CLEAN to the reachability of a
# third party, so a GitHub outage would stop you being able to prove your tree
# is clean at all. The instrument and the network policy are different concerns
# and they stay in different files. This file is the policy; the sanitizer stays
# the instrument. A pin in test/brain-publication-gate.test.ts asserts that the
# sanitizer remains network-free, so this separation cannot quietly rot.
#
# ---------------------------------------------------------------------------
# USAGE
#   scripts/ci/assert-repo-visibility.sh --repo OWNER/NAME --expect private|public
#                                        [--label NAME]
#
#     --repo    the destination, exactly as CI configured it (owner/name)
#     --expect  the visibility this job REQUIRES the destination to have
#     --label   a short name for the refusal message (default: dest)
#
# ENVIRONMENT
#   GH_TOKEN               REQUIRED (by NAME only; its value is never printed,
#                          never logged, never written to a file). A probe with
#                          no token cannot distinguish "private" from "gone",
#                          because the unauthenticated API 404s private repos.
#   UI2API_GH_API_BASE     the API base URL. Defaults to https://api.github.com.
#                          It exists so the contract can be proven against a
#                          controllable endpoint instead of a live one.
#
# EXIT: 0 only when the destination was reached, identified, and found to have
#       exactly the declared visibility. ANY other outcome is non-zero with a
#       named reason. There is no code path that continues on an unknown.

set -euo pipefail

T_API="${UI2API_GH_API_TIMEOUT:-60}"

REPO=""
EXPECT=""
LABEL="dest"
API_BASE="${UI2API_GH_API_BASE:-https://api.github.com}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)   REPO="${2:-}";   shift 2 ;;
    --expect) EXPECT="${2:-}"; shift 2 ;;
    --label)  LABEL="${2:-}";  shift 2 ;;
    -h|--help)
      echo "usage: assert-repo-visibility.sh --repo OWNER/NAME --expect private|public [--label NAME]"
      exit 0 ;;
    *)
      echo "VIS-FAIL[$LABEL]: unknown argument '$1' — refusing to push to an unexamined destination" >&2
      exit 1 ;;
  esac
done

# THE ONLY EXIT THAT MEANS "PUSH". Every refusal below funnels here, so there is
# exactly one place to audit for whether an unproven visibility can pass.
refuse() {
  echo "VIS-FAIL[$LABEL]: $1" >&2
  echo "VIS-FAIL[$LABEL]: refusing. An UNKNOWN visibility is NOT a private one, and no push follows this refusal." >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || refuse "jq is not on PATH, so the API answer cannot be read. A visibility that cannot be parsed is UNKNOWN, not private."
command -v curl >/dev/null 2>&1 || refuse "curl is not on PATH. A visibility that cannot be asked for is UNKNOWN, not private."

[ -n "$REPO" ] || refuse "no --repo was given. There is no destination to examine, so there is nothing that could authorise a push."
case "$REPO" in
  */*/*) refuse "--repo '$REPO' is not owner/name; refusing to guess a destination" ;;
esac
case "$EXPECT" in
  private|public) : ;;
  *) refuse "--expect must be 'private' or 'public'; got '${EXPECT:-<unset>}'. Refusing rather than accepting an unstated expectation." ;;
esac
# The token is required BY NAME. Its value is never echoed and never written.
[ -n "${GH_TOKEN:-}" ] || refuse "GH_TOKEN is unset (the variable NAME is all that is inspected here). An unauthenticated probe cannot tell a private repo from a deleted one, so it refuses."

BODY="$(mktemp "${TMPDIR:-/tmp}/vis-body.XXXXXX")"
cleanup() { rm -f "$BODY"; }
trap cleanup EXIT

# NO `-k` / `--insecure`. The superseded kit probe carried `curl -skfL`: `-k`
# disables TLS verification, which is precisely the control that stops a
# man-in-the-middle from answering "private: true" for a corpus-bearing repo.
# A visibility probe that can be answered by an attacker is worse than none.
# `-f` is deliberately NOT used either: it suppresses the body, and a named HTTP
# status is what lets the refusal say WHAT went wrong instead of "curl failed".
code="$(timeout -k 5 "$T_API" curl -sS -o "$BODY" -w '%{http_code}' \
        -H 'Accept: application/vnd.github+json' \
        -H 'X-GitHub-Api-Version: 2022-11-28' \
        -H "Authorization: Bearer ${GH_TOKEN}" \
        "${API_BASE}/repos/${REPO}" 2>/dev/null)" \
  || refuse "the visibility API could not be reached (DNS, TLS, connection refused, or no answer within ${T_API}s). UNREACHABLE IS NOT PROVEN."

case "$code" in
  200) : ;;
  404) refuse "the API answered HTTP 404 for $REPO. It does not exist, or this token cannot see it — and an unseen private repo is indistinguishable from a missing one." ;;
  401|403) refuse "the API answered HTTP $code for $REPO: the token was rejected or lacks access. A destination we cannot read is a destination we cannot vouch for." ;;
  *)   refuse "the API answered HTTP $code for $REPO where 200 was required. A non-200 carries no visibility, and no visibility means no authorisation." ;;
esac

# From here the answer EXISTS but may still be unreadable. Every field is read
# with an explicit NULL CHECK and an explicit TYPE check, because a body that
# parses but carries `.private: "true"` (a string) or omits the key entirely is
# the shape that turns a probe into a lie.
#
# jq's key-existence test is NOT used, deliberately.
# `test/probe-leak.test.ts` derives the project's "mechanism nouns" — the things
# the daemon really executes, from which `consumerProse()` must never leak a name
# — by scanning every file under `src/` and `scripts/` for one particular shape:
# a `has(` call whose argument is a QUOTED PROGRAM NAME. That is how
# `src/runtime/requirements.ts` declaring that it probes Xvfb becomes an
# obligation. A jq key-existence test written with that same spelling is the same
# PATTERN and a completely different thing: a key lookup on a JSON object, not a
# program probe. Writing it here made the abstraction-leak gate derive `private`
# and `visibility` as mechanism vocabulary, and that gate went red. The right
# repair is on THIS side of the boundary — not to silence the gate, and not to
# make `consumerProse()` redact the ordinary English words "visibility" and
# "private" out of consumer messages — but to stop writing an expression that is
# textually indistinguishable from an exec-probe. MEASURED: the leak gate failed
# with a leak report naming `private` and `visibility` derived from this file,
# and passes again once the spelling is gone. Note that this explanation is also
# carefully worded: the derivation is a regex over raw file text with no comment
# awareness, so documenting the collision in the very spelling that triggers it
# re-creates the leak. (Ironically that is the same self-reference trap
# `mechanismTermsIn` guards against by excluding its own module.)
#
# Note also `// "absent"` is NOT usable for the boolean: in jq `false // x`
# yields `x`, because `//` treats `false` and `null` alike. `.private // "absent"`
# would therefore report the repo as "absent" on exactly the answer that matters
# most. An explicit `if ... == null` is used instead.
priv_type="$(jq -r 'if .private == null then "absent" else (.private | type) end' "$BODY" 2>/dev/null || echo unreadable)"
[ "$priv_type" = "boolean" ] || refuse "the API answer carries no boolean .private (got type '$priv_type'). UNKNOWN is NOT private, so the push is refused."

priv="$(jq -r 'if .private == null then "absent" else .private end' "$BODY" 2>/dev/null || echo unreadable)"
vis="$(jq -r 'if .visibility == null then "absent" else .visibility end' "$BODY" 2>/dev/null || echo unreadable)"
full="$(jq -r 'if .full_name == null then "absent" else .full_name end' "$BODY" 2>/dev/null || echo unreadable)"

# IDENTITY. `owner/name` is case-insensitive on GitHub, so the comparison is too;
# a DIFFERENT repo is still caught, and that is the case that matters — a
# repointed $GITHUB_REPO would otherwise sail past a marker gate that measured a
# tree destined for somewhere else entirely.
[ "$(printf '%s' "$full" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$REPO" | tr 'A-Z' 'a-z')" ] \
  || refuse "the API answered for '$full' while '$REPO' was requested. The push would not have gone where this job believes it goes, so it is refused."

# SELF-CONSISTENCY. `private` and `visibility` are two spellings of one fact and
# they disagree during GitHub's org-repository migration transitions. A body that
# disagrees with itself is not evidence of anything, so it refuses rather than
# picking the convenient field.
case "$vis" in
  private) vis_private=true ;;
  public)  vis_private=false ;;
  *) refuse "the API answer carries no usable visibility (got '$vis'). UNKNOWN is NOT private, so the push is refused." ;;
esac
[ "$priv" = "$vis_private" ] \
  || refuse "the API disagrees with itself: private=$priv but visibility=$vis. A body that contradicts itself authorises nothing."

# THE DECLARED TOPOLOGY. This is the assertion that replaces the handover's
# `private == true`: the destination must hold EXACTLY the visibility this job
# declares. For the corpus-bearing repo that is `private`, and a public answer is
# the exposure direction. For the sanitized repo it is `public`, so the check is
# a drift detector rather than an exposure detector — and it is still not
# vacuous, because it also proves the destination EXISTS, is IDENTIFIED, and was
# REACHED on this run.
case "$EXPECT" in
  private) want=true ;;
  public)  want=false ;;
esac
# The condition is on `false`, not on `true`: `$priv` is the repo's own answer, so
# `priv=false` is the PUBLIC case. (Written the other way round it printed "the
# destination is private, but this job requires it to be private" for a repo that
# had just answered `private:false` — a refusal whose reason contradicts the
# measurement is a refusal nobody will believe. The RED 1 assertion caught it.)
[ "$priv" = "$want" ] \
  || refuse "the destination $REPO is $([ "$priv" = false ] && echo PUBLIC || echo private), but this job requires it to be $EXPECT. Refusing: the declared topology no longer matches reality, and a mirror that publishes into a destination nobody re-declared is how unverified content finds a wider audience."

echo "VIS-OK[$LABEL]: $REPO visibility=$vis private=$priv (declared: $EXPECT, measured over the API this run)"