/**
 * True only when `url` is the SAME ORIGIN as `base` — scheme, host and port
 * (GOAL 99). This function previously compared `host` alone, so a protocol
 * downgrade (`http://` url against an `https://` base) passed a function whose
 * name promises same-origin, while `assertChannelUrl` below refused non-https
 * outright. Origin means scheme + host + port, so all three are compared now.
 */
export function sameOrigin(url: string, base: string): boolean {
  try {
    const u = new URL(url, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const b = new URL(base);
    return u.protocol === b.protocol && u.host === b.host;
  } catch { return false; }
}

/**
 * The ONLY cross-host navigation allowance that exists in the origin-pinning
 * guard — an EXPLICIT, per-package host PAIR, never a general "strip `www.` and
 * compare" rule. A generic www-stripping rule would widen the guard for every
 * package at once, and `www` is not a no-op in security terms: an attacker who
 * controls `<host>.example` but not `<host>` gains nothing here, but a site
 * whose bare host and www host are administered by DIFFERENT parties would
 * silently become one origin. So the allowance is a literal table, keyed by the
 * ALLOWED host, and it must be edited deliberately to grow.
 *
 * youtube.com / www.youtube.com: one property, one operator (Google). The
 * package pinned the bare host (`capabilities/youtube/profile.json` url, which
 * is also the VAULT KEY — `data/sessions/<host>/`, so it may not move without
 * repointing a real stored account) while every runner URL is `www.youtube.com`,
 * which is what the site actually serves. This pair is what lets those two
 * facts coexist without weakening anything else.
 */
export const WWW_SIBLING_ALLOWANCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "youtube.com": Object.freeze(["www.youtube.com"]),
  "www.youtube.com": Object.freeze(["youtube.com"]),
});

/**
 * `sameOrigin`, PLUS the one explicit www-sibling pair for the base's host.
 *
 * Deliberately NOT a generalization of `sameOrigin`:
 *   - the scheme must still match exactly, so an `http://` sibling is refused
 *     (protocol downgrade stays closed even across the allowance);
 *   - the allowance only applies when the BASE host is a literal key of
 *     `WWW_SIBLING_ALLOWANCE`, so a caller with a base of `evil.com` gets
 *     nothing;
 *   - the URL host must be one of that key's listed siblings LITERALLY, so
 *     `youtube.com.evil.com`, `notyoutube.com` and `evil.www.youtube.com` are
 *     all still refused (suffix/subdomain tricks do not match a whole-host
 *     equality).
 *
 * Every existing call site keeps using strict `sameOrigin`; this is opt-in.
 */
export function sameOriginAllowingWwwSibling(url: string, base: string): boolean {
  if (sameOrigin(url, base)) return true;
  try {
    const u = new URL(url, base);
    const b = new URL(base);
    if (u.protocol !== b.protocol) return false;
    const siblings = WWW_SIBLING_ALLOWANCE[b.host];
    if (!siblings) return false;
    return siblings.includes(u.host);
  } catch { return false; }
}

/**
 * Parse a caller-supplied channel reference into a safe, fully-qualified
 * `https` navigation URL on `allowedHost` — or throw with an honest message
 * naming the expected input. Never use raw caller input in a `page.goto()`.
 *
 * Accepted shapes (everything else is rejected BEFORE any navigation):
 *   - bare channel id:  /^UC[\w-]{22}$/      -> https://<host>/channel/<id>
 *   - bare handle:      /^@[\w.\-]{1,64}$/   -> https://<host>/@handle
 *   - full URL:         https://<host>/@handle or https://<host>/channel/<id>
 *
 * The returned URL is always REBUILT from validated path components, so query
 * strings / fragments / host tricks can never smuggle a cross-origin target in.
 */
export function assertChannelUrl(input: string, allowedHost = "www.youtube.com"): string {
  const value = String(input ?? "").trim();
  const channelIdRe = /^UC[\w-]{22}$/;
  const handleRe = /^@[\w.\-]{1,64}$/;

  if (channelIdRe.test(value)) return `https://${allowedHost}/channel/${value}`;
  if (handleRe.test(value)) return `https://${allowedHost}/${value}`;

  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(
      `invalid channel reference "${value}": expected a channel id (UC + 22 chars), an @handle, or an https://${allowedHost}/channel/<id> / https://${allowedHost}/@handle URL`
    );
  }
  if (u.protocol !== "https:") {
    throw new Error(
      `invalid channel reference "${value}": URL protocol must be https (got ${u.protocol}//${u.host}) — expected https://${allowedHost}/channel/<id> or https://${allowedHost}/@handle`
    );
  }
  if (u.host !== allowedHost) {
    throw new Error(
      `invalid channel reference "${value}": URL host must be ${allowedHost}, got ${u.host} — origin pinning refuses cross-origin navigation`
    );
  }
  const bare = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (handleRe.test(bare)) return `https://${allowedHost}/${bare}`;
  const id = (u.pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/) ?? [])[1];
  if (id) return `https://${allowedHost}/channel/${id}`;
  throw new Error(
    `invalid channel reference "${value}": URL path must be /@handle or /channel/<id> (got ${u.pathname})`
  );
}
