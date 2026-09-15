# Troubleshooting

Hard-won field notes. Read this before assuming a browser bug — two of the
longest debugging sessions in this repo ended *outside* the code.

## Browser processes die "cleanly" (exit code 0, page closes mid-flight)

### Symptom

Wrapped Chrome instances exit with **code 0** (not a crash, no crashpad dump,
no OOM, no sandbox trap) a few seconds after "DevTools listening". Playwright
calls fail with `Target page, context or browser has been closed`. The daemon
recovers, but nothing ever completes. Meanwhile ordinary long-running
processes (`sleep 25`) survive fine — so it is *not* an environment reaper or
a cgroup/load killer.

### Root cause (2026-09-15, host with systemd Chrome service)

A leftover **systemd unit was pkill-ing every Chrome that carries a
`--remote-debugging` flag — including its own**:

```
/etc/systemd/system/chrome-cdp.service
ExecStartPre=/bin/sh -c "/usr/bin/pkill -f \"chrome.*remote-debugging\" >/dev/null 2>&1 || true"
ExecStart=/usr/bin/google-chrome-stable --remote-debugging-port=9222 --headless=new ...
Restart=always   RestartSec=3
```

The pkill pattern `chrome.*remote-debugging` **matches the service's own
ExecStart** command line. Every ~3 s the service killed its own child, which
made systemd restart it, which pkill'd again: a self-eating loop that SIGTERM'd
any Chrome with a debug flag. Chrome handles SIGTERM gracefully → clean exit 0.

### Whodunit — how it was caught (diagnostic recipe)

1. `strace -e trace=signal -f -p <chrome-pid>` → `SIGTERM {si_signo=SIGTERM,
   si_code=SI_USER, si_pid=<killer>, si_uid=<uid>}` — a *signal*, not a trap.
2. `bpftrace -e 'tracepoint:signal:signal_generate { printf("%s %d -> %d\n", comm, pid, args->pid); }'`
   → caught the killer red-handed: `/usr/bin/pkill -f chrome.*remote-debugging`
   spawned from a detached `sh` (ppid 1).
3. `pgrep -af chrome` + `systemctl --user` / `systemctl list-units | grep -i chrome`
   → the `chrome-cdp.service` unit.

### Fix

```bash
sudo systemctl stop chrome-cdp.service
sudo systemctl disable chrome-cdp.service
```

Verify:

```bash
systemctl is-enabled chrome-cdp.service   # disabled
systemctl is-active chrome-cdp.service    # inactive
```

Spawn a bare Chrome with a debug port and watch it live past 12 s — previously
it died in 3–8 s:

```bash
google-chrome-stable --headless=new --remote-debugging-port=39996 --user-data-dir=/tmp/probe about:blank &
sleep 12; curl -s http://127.0.0.1:39996/json/version && echo " ALIVE"
```

> **General lesson:** on shared hosts, check for `pkill -f` based systemd
> units before debugging browser lifecycle. `pkill -f <pattern>` also matches
> the *shell running pkill itself* — use `pkill -x` (exact process name) in
> your own scripts, or you will kill your own command line mid-run.

## Running signed-in sites headfully (the winning route)

`promptd` is headless by default; freshly-spawned headless Chromium on a busy
host is the *unstable* configuration for heavy SPAs (Gemini). The proven
stable route: a **headed pool on a virtual display** with the captured session
snapshot injected.

```bash
# 1. Start a virtual display once (survives daemon restarts)
Xvfb :99 -screen 0 1920x1080x24 -auth /tmp/xvfb-run.p1iHwW/Xauthority &

# 2. Run the daemon headed against it
DISPLAY=:99 XAUTHORITY=/tmp/xvfb-run.p1iHwW/Xauthority \
  UI2API_HEADED=1 UI2API_POOL_MIN=1 \
  node --import tsx src/cli.ts promptd --port 9797 --site gemini

# 3. Probe the pool, then send
curl -s http://127.0.0.1:9797/health        # browser: up, warm: 1
curl -s -X POST http://127.0.0.1:9797/prompt \
  -H 'content-type: application/json' \
  -d '{"prompt":"Reply with ONLY the number 42.","site":"gemini"}'
```

Result (2026-09-15): `ok: true`, live chat URL `gemini.google.com/app/<id>`,
auto-titled by Gemini — i.e. a **real conversation in the account's history**,
not a stubbed answer. Headed + a client actually attached to CDP keeps the
browser alive where headless died at renderer start.

Notes:

- `UI2API_HEADED=1` is honored by both `driver.ts` and `promptd`'s pool
  (`src/prompt/pool.ts`).
- The captured session (`data/<host>/.session/state.json` — cookies +
  localStorage + sessionStorage + IndexedDB) is injected automatically for
  non-default contexts, so the spawned page runs as the logged-in user.
- If the daemon suddenly can't reach X: the Xvfb died with its parent
  terminal. Start it detached (`setsid nohup ... &`) so it outlives PTY/SSH
  resets, then relaunch the daemon.
- If `promptd` exits with `EADDRINUSE 127.0.0.1:9797`: a previous daemon is
  still bound to the port — kill it (`kill <pid>`) or the new process will
  exit instead of serving.
- Pool reuse means a second prompt on the same warm page continues the *same*
  conversation thread. Use `"newChat":true` in the POST body for a fresh chat.

## `npx vitest` finds "No test suite" and runs nothing

This repo's test runner is **not vitest** — it's `npm test` →
`tsx test/integration.ts`. Running bare `npx vitest` downloads a random
vitest into the npx cache, which then reports `No test suite found in file`
for every suite. Use:

```bash
npm test          # the actual suite
npx tsc --noEmit  # the actual typecheck
```