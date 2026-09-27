# DEPLOYING ui2api on this box — the runbook

**What "deployed" means here:** the running `promptd` serves the code from
`/opt/ui2api`, a directory that **only** `scripts/ops/deploy.sh` writes. Every push to
`main` redeploys it and restarts the service, and the pipeline **fails if the service
does not come back healthy**.

Before this existed, the service ran `npx tsx <checkout>/src/cli.ts promptd` out of a
git working tree. That is the root of the "stale daemon" problem this project kept
hitting: a daemon from an older commit answers `/registry` perfectly while 404ing every
route added since. Code on disk that is not the code you are talking to.

---

## The three units

| unit | runs as | what it is | restarted by a deploy? |
| --- | --- | --- | --- |
| `ui2api-xvfb` | `ui2api` | `Xvfb :99` — without it `UI2API_HEADED=1` is a lie | no |
| `ui2api-chrome` | `ui2api` | the long-lived headed Chrome + its profile | **no** — holds warm anti-bot state and the profile lock |
| `ui2api-api` | `me` (operator) | `promptd` on `127.0.0.1:9797` | **yes** |

### Why the API is not the `ui2api` user — a deliberate, measured decision

Chrome belongs to `ui2api`: that user owns the profile and the warm anti-bot state, and
that is this project's documented point of use.

The **vault** belongs to the operator. The captured sessions are the operator's own login
state, hardened to `0700`/`0600` by the write seam, so they are readable by their owner
and nobody else. **Measured:** with the API running as `ui2api`,
`GET /accounts?site=araprat` returned an **empty** list — the `0700` dirs are unreadable
to it. The two obvious alternatives are both worse:

- **chown the credentials to `ui2api`** — either weakens the `0600`/`0700` pin that
  `test/vault-credential-mode.test.ts` and `test/write-gate-no-auth-snapshot.test.ts`
  hold, or blinds every gate that verifies the vault honestly.
- **run the API as `ui2api` and relax the modes** — defeats the fix for the
  142-of-143 world-readable finding.

So: different users, one browser, **no shared profile access**. The API never touches
the browser directly — it **attaches over CDP** to the `ui2api` Chrome on port 9222,
which is this project's documented attach seam (`UI2API_ATTACH_PORT`).

---

## The runners — and why there are two

| runner | executor | jobs | why |
| --- | --- | --- | --- |
| `shared-baremetal-runner` (id 1) | docker, `alpine`, privileged | `build`, `verify` | isolated; no host access. Correct for tests. |
| `ui2api-deploy-shell` (id 2) | **shell** | `deploy` | a docker job **cannot reach the host's systemd**. A deploy from there could not restart anything, so it would be a no-op with extra steps. |

The shell runner is deliberately constrained:

- `run_untagged: false` — only a job tagged `deploy` can use it
- `tag_list: deploy,shell,host` — nothing untagged can land here by accident
- `locked: true` — no other project can claim it
- it runs as `gitlab-runner`, which has **passwordless sudo** (required for `systemctl`)

---

## The deploy job

`.gitlab-ci.yml`, stage `deploy`, `needs: ["verify"]`.

```
push to main
  └─ build ──▶ verify ──▶ deploy
                  │            ├─ sudo ./scripts/ops/deploy.sh
             (must be green)   │    1. rsync repo → /opt/ui2api   (data/ excluded, asserted)
                             │    2. npm ci + npm run build      (BEFORE the switch)
                             │    3. systemctl restart ui2api-api
                             │    4. poll GET /health, dump journal on failure
                             └─ re-check /health, /registry count, /v1/models count,
                                systemctl is-active
```

Four properties that matter, each of which exists because its absence caused a real bug:

1. **The vault is excluded and then ASSERTED.** `rsync` drops `data/`; the script then
   *fails* if `/opt/ui2api/data` exists. A deploy that silently shipped or replaced
   captured credentials would be far worse than a stale daemon.
2. **Build before the switch.** A compile error fails the deploy instead of leaving a
   service that starts and serves nothing.
3. **Health is part of the exit status**, not a log line. A green pipeline with a dead
   service is the exact failure this eliminates.
4. **`resource_group: ui2api-production`** so two pushes cannot race the same install dir.

`deploy.sh` takes `--repo`, `--target` and `--no-restart`, so the manual path and the CI
path run the *same code* and cannot drift.

---

## First-time setup on a new box (recorded, idempotent)

```bash
# 1. the dedicated chrome user + its profile (touches credentials — run once)
sudo ./scripts/ops/provision-ui2api-user.sh

# 2. the three systemd units, pointed at /opt/ui2api
sudo ./scripts/ops/install-services.sh

# 3. install the code and start the API
sudo ./scripts/ops/deploy.sh
```

Step 1 is deliberately **not** a deploy dependency: a deploy must never need to create
users or touch a Chrome profile. Steps 2 and 3 are what CI re-runs automatically.

## Manual deploys

```bash
sudo ./scripts/ops/deploy.sh                    # install + restart + health-check
sudo ./scripts/ops/deploy.sh --no-restart       # stage the code, leave the service alone
sudo -u ui2api -H ui2api chrome status        # where the browser is
curl -s http://127.0.0.1:9797/health            # is the API alive
sudo journalctl -u ui2api-api -n 50 --no-pager  # when it is not
```

## Checking that a deploy actually took

```bash
systemctl is-active ui2api-xvfb ui2api-chrome ui2api-api   # active active active
curl -s http://127.0.0.1:9797/health                         # ok:true
curl -s http://127.0.0.1:9797/registry | jq '.packages|length'   # 33
curl -s http://127.0.0.1:9797/v1/models  | jq '.data|length'      # 22
curl -s 'http://127.0.0.1:9797/accounts?site=araprat' | jq '.accounts|length'  # vault is visible
```

The last one is the trap worth remembering: a service pointed at the wrong
`UI2API_DATA_DIR` **starts perfectly, serves `/registry`, and replays signed-out on every
site.** It is not an error; it is a silent total failure. That is why the vault is
asserted in the deploy and why the API user was chosen by measurement rather than habit.

## Pipeline

```bash
export GITLAB_HOST=gitlab.pubg-sell.ir
glab api "projects/5/pipelines?per_page=5"
glab api "projects/5/pipelines/<id>/jobs"
glab api "projects/5/jobs/<job>/trace"
```

`glab ci status` misresolves this project (it reads `origin`'s fetch URL, which is
GitHub) — use `glab api`.
