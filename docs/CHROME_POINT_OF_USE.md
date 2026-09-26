# The Chrome Point of Use

> **This is the single most important operational fact about ui2api. If you take one
> thing from this file, take this one.**

## The rule

**ui2api drives the Chrome of a DEDICATED LINUX USER — not the browser of the person
sitting at the keyboard.**

On this box that user is `ui2api`:

| | |
| --- | --- |
| user | `ui2api` (uid 1010) |
| home | `/home/ui2api` |
| profile used | `/home/ui2api/.config/ui2api-chrome` |
| also present | `/home/ui2api/.config/google-chrome` (a real Chrome profile, beside it) |

## Why the operator's own browser is not an option

Chrome **refuses to let another process attach to the browser a person is actively
using**, and refuses `--remote-debugging-port` on a live profile for the same reason.

That is a wall, not a bug to engineer around. Do not spend time trying to drive the
operator's interactive browser — it cannot be done.

## Why the dedicated user is the way

The dedicated user's Chrome works fine — **including headless**. There is no wall on
that side. The only setup step in the entire world is:

> **That user's Chrome info must exist.**

Writing the Chrome info into that user **is** the integration. Nothing else is
required. Once `/home/ui2api/.config/ui2api-chrome` exists with a real `Default` or
`Profile 1` inside it, ui2api works.

## The owner is data, not a hardcode

```bash
UI2API_CHROME_USER=ui2api          # the default on this box
UI2API_CHROME_USER=some-svc-acct   # a per-customer service account
UI2API_CHROME_USER=ci               # CI
```

Same build, any owner. `src/runtime/chrome-owner.ts` resolves the user via
`getent passwd`, reads their home, and finds the first real profile among
`~/.config/{ui2api-chrome, google-chrome, chromium, chrome}`.

A profile only counts as real if it contains `Default`, `Profile 1`, or
`Local State` — an empty directory is not a profile, and the resolver says so by
name rather than handing Chrome a useless path.

## Logging in — without copying anyone's profile

If a site needs a login, there are two ways. **Prefer the first.**

1. **Log in directly to the dedicated user's Chrome (recommended).** Run that user's
   Chrome with `xhost +` and log in to it there. The credentials are then ingested
   by the normal profile-ingest path exactly as before — nothing special, no copy.

   ```bash
   xhost +
   sudo -u ui2api -H google-chrome \
     --user-data-dir=/home/ui2api/.config/ui2api-chrome
   # log in by hand, then quit
   xhost -
   ```

2. **Copy the profile across users.** Works, but it is the fragile option: profile
   locks, `Local State` key mismatch, and partial copies all fail quietly. Reach for
   `xhost +` first.

Either way the credentials end up in the vault, and the daemon can use them from then
on.

## Do not fire Chrome per request

Chrome is started **once** and reused. Run the daemon as the owner; every
request attaches to it over CDP.

```bash
ui2api chrome start     # idempotent — never spawns twice; adopts an existing Chrome
ui2api chrome status    # where it is, and the port to attach to
ui2api chrome stop      # refuses to kill a Chrome we did not start

# as the dedicated owner (the supported way):
sudo -u ui2api -H npx tsx src/cli.ts chrome start
```

`start` **adopts** a Chrome for the owner that is already running on any port,
rather than firing a second one — Chrome permits one instance per profile and
will refuse anyway. When it adopts, `status` prints the port to attach to, which
is what `UI2API_ATTACH_PORT` uses. When no daemon is live, the pool falls back to
spawning per request, so nothing breaks if the daemon is down.

## RUN IT HEADED UNDER A VIRTUAL DISPLAY — this is not optional

**Headless is what gets us blocked. MEASURED, same site, same request, only
headfulness changed:**

| browser | result |
| --- | --- |
| `--headless=new` | `ok:false` — *"either ERR_CHALLENGE (abuse signal) or the consent wall re-blocked"* |
| **headed inside Xvfb** | `ok:true` — `answer: "GPT-5.6 Luna\n\nPONG-HEADED"`, read off the live page, the site's own JS driving `POST /duckchat/v1/chat` (SSE) |

A headless browser is a *forgery*, and it fails differently from a plain bot: no
window chrome, no extensions, a temp profile, and CDP-level tells. A browser on a
real (even virtual) X display does not present that. The anti-bot stack is not
guessing — it is reading.

So the point of use is **a headed Chrome on a virtual display**, not a headless one:

```bash
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &      # the virtual display
DISPLAY=:99 google-chrome-stable \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir=/home/ui2api/.config/ui2api-chrome about:blank   # NO --headless
```

Confirm it is genuinely headed, not silently headless:

```bash
curl -s http://127.0.0.1:9797/status | grep -o '"headful":[a-z]*'
# "headful":true   — and "headlessDegraded":false
```

`UI2API_HEADED=1` with no display is the `headless-degraded` state, and it is NOT
a substitute: the daemon will fall back to `--headless=new` and you will be
challenged again. **Xvfb is what makes `UI2API_HEADED=1` true.**

`xvfb-run` also works for a one-off, but a long-lived daemon wants a
long-lived `Xvfb :99`.

## Provision it (a new box needs one command)

```bash
sudo ./scripts/ops/provision-ui2api-user.sh
```

It is **idempotent** and safe to re-run. It creates the dedicated user, seeds the
Chrome profile directory (`~/.config/ui2api-chrome/Default`, mode 0700, owned by
that user) **without ever touching a live profile**, and registers two systemd
services so everything survives a reboot:

| unit | what it is |
| --- | --- |
| `ui2api-chrome.service` | the ONE persistent Chrome, CDP on `127.0.0.1:9222` |
| `ui2api-api.service` | `promptd` — the HTTP API other programs call |

Both run **as the `ui2api` user**, never as the operator. The API unit attaches
to the persistent Chrome (`UI2API_ATTACH_PORT=9222`), so it never spawns a
browser per request.

```bash
systemctl status ui2api-chrome ui2api-api
curl -s http://127.0.0.1:9797/health          # the API other programs call
npx tsx src/cli.ts chrome status              # the browser side
```

Use `--no-systemd` to provision the user and profile without registering units.

## How to check it

```bash
npx tsx src/cli.ts requirements        # reports chrome-owner as a first-class check
```

Expected line on this box:

```
chrome-owner ui2api: /home/ui2api/.config/ui2api-chrome (process is not ui2api)
```

The `(process is not ui2api)` part is informational, not an error — the app can drive
that user's profile from any process. It only says whether you are *already* running
as the owner.

## What NOT to do

- Do not try to attach to a human's interactive Chrome. It is refused by design.
- Do not pass `--no-sandbox` / `--disable-gpu` to a real user Chrome. Those are
  headless-tell hardening flags; on a real Chrome they print "you are using an
  unsupported command-line flag" and *change the fingerprint*, which is the exact
  opposite of the point.
- Do not assume headless means "degraded". The dedicated user's Chrome runs headless
  without complaint. If you see `headless-degraded` in the posture report, that means
  you asked for **headed** (`UI2API_HEADED=1`) and there is no display — run under
  Xvfb. It is not about headless working at all.

## The code

| file | role |
| --- | --- |
| `src/runtime/chrome-owner.ts` | the resolver: `resolveChromeOwner()`, `chromeOwnerStatus()` |
| `src/runtime/browser.ts` | `userChromeProfile()` — explicit env wins, else the owner's profile |
| `src/prompt/posture.ts` | discloses the resolved headless/headful state |

`userChromeProfile()` prefers `UI2API_USER_DATA_DIR` / `UI2API_CHROME_PROFILE_PATH`
when set, and otherwise falls back to the Chrome owner. So the owner is the
**default**, and never overrides an explicit choice.
