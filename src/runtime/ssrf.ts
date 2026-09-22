export function sameOrigin(url: string, base: string): boolean {
  try {
    const u = new URL(url, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.host === new URL(base).host;
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
