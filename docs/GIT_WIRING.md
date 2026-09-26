# Git wiring — GitHub AND GitLab

> Both remotes carry the project. `.brain/` is the operator's private IP and
> **must only ever reach a PRIVATE remote** — both of these are private, and that
> is verified, not assumed.

## The shape

| remote | role | transport |
| --- | --- | --- |
| `origin` | fetch from GitHub, **push to BOTH** | HTTPS |
| `gitlab` | explicit GitLab remote | HTTPS |

`origin` carries two *push* URLs, so **one `git push origin` lands in both
places** — the muscle memory never has to change:

```bash
git remote get-url --all --push origin
#   https://github.com/MeRezaRezaei/ui2api.git
#   https://gitlab.pubg-sell.ir/MeRezaRezaei/ui2api.git
```

`origin`'s *fetch* URL stays GitHub, so `git pull` behaves normally.

## Why HTTPS and not SSH

**Port 22 is blocked on this box.** An SSH push hangs until it times out
(`git ls-remote` exits 124). HTTPS on 443 works, and the GitLab API works over it.
So the GitLab remote is HTTPS, authenticated with a token in a `0600` credential
file — never in the repo, never in `.git/config`, never printed.

If you ever fix outbound SSH, switching the GitLab remote back to
`git@gitlab.pubg-sell.ir:MeRezaRezaei/ui2api.git` is a one-line change.

## Privacy gate — verify, do not assume

`.brain/` is tracked (it is the real brain of a private project) and holds the
operator's methodology, verbatim goals and prompts. It must never reach a public
remote.

```bash
gh   repo view MeRezaRezaei/ui2api --json isPrivate     # -> true
glab api "projects/MeRezaRezaei%2Fui2api" | jq .visibility   # -> private
```

`data/` (captured sessions and real credentials) is gitignored and must stay so —
it is **not** pushed to either remote.

## Everyday use

```bash
git push origin            # -> GitHub AND GitLab
git push origin --tags     # tags to both
git status --porcelain     # should be empty
```

Verify both landed in sync:

```bash
git rev-parse main
gh   api repos/MeRezaRezaei/ui2api/commits/main --jq .sha
git ls-remote gitlab refs/heads/main        # -> <sha>\trefs/heads/main
```

## CI lives on GitLab

`.gitlab-ci.yml` is the long-run lane: build, the verbatim-completeness gates
(P1..P5), `npm test`, and the full `npm run test:unit`. It runs on
`node:24-bookworm` with a 30-minute cap. That is deliberate — the full suite is
too heavy for a shared box, so local verification stays per-file and bounded.

The historical GitHub Actions workflow is kept as a redundant lane, but **GitLab
is the CI of record**; `test/production-readiness-gate.test.ts` asserts the
GitLab pipeline exists and the readiness state does not cite the GitHub one.

## `glab` gotchas on this box

- Export the host for anything that resolves remotes:
  `export GITLAB_HOST=gitlab.pubg-sell.ir`. Without it, `glab ci status` reports
  *"no GitLab remotes found"* even though the remote is configured — because
  `origin`'s fetch URL is GitHub.
- `glab repo view` (auto-detect) works without it.
- Pipeline state is easiest to read from the API, which never has the ambiguity:

```bash
export GITLAB_HOST=gitlab.pubg-sell.ir
glab api "projects/MeRezaRezaei%2Fui2api/pipelines?ref=main&per_page=5" \
  | python3 -c 'import json,sys; [print(p["id"],p["status"],p["sha"][:8],p["web_url"]) for p in json.load(sys.stdin)]'
```
