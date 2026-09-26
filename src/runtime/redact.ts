/**
 * GOAL 125: a captured request body can contain the operator's live session
 * credentials. The analyzer records bodies VERBATIM
 * (`src/analyzer/instrument.ts` fetch + XHR), the mapper copies them into the
 * action map, `analyse` runs immediately after an interactive `--login` in the
 * same flow — so the map that lands on disk is the LOGGED-IN one — and that map
 * is then copied into a generated server and `PUT` to the hub (and with
 * `--mirror`, to a public registry). MEASURED: the per-site
 * action-map.json is NOT gitignored, so the leak reaches the git index too.
 *
 * Redaction is a NAMED, VISIBLE marker, never a silent deletion: a reader must
 * be able to see that a field was removed and why. A body with no credential
 * passes through BYTE-IDENTICAL — a redactor that mangles everything is not a
 * fix, it is a different bug.
 */

/** Keys whose VALUE is a credential regardless of shape. */
const CREDENTIAL_KEYS = new Set([
  "authorization",
  "auth",
  "token",
  "access_token",
  "accesstoken",
  "refresh_token",
  "id_token",
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwd",
  "secret",
  "session",
  "sessionid",
  "session_id",
  "cookie",
  "set-cookie",
  "csrf",
  "xsrf",
  "client_secret",
  "private_key",
  "credential",
  "credentials",
]);

/** A bearer/JWT-looking value, wherever it appears. */
function looksLikeCredentialValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (/^bearer\s+\S/i.test(v)) return true;
  if (/^ey[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}$/.test(v)) return true; // JWT
  if (/^sk-[A-Za-z0-9_-]{12,}$/.test(v)) return true; // API key shape
  if (/^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}$/.test(v)) return true; // GitHub token
  if (/^xox[baprs]-[A-Za-z0-9-]{10,}$/.test(v)) return true; // Slack
  return false;
}

export const REDACTED = "[redacted]";

/** Redact a parsed JSON value in place-safe fashion; returns a new value. */
export function redactValue(value: unknown, hits: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => redactValue(v, hits));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CREDENTIAL_KEYS.has(k.toLowerCase()) && v != null && v !== "") {
        out[k] = `[redacted:${k}]`;
        hits.push(k);
        continue;
      }
      if (looksLikeCredentialValue(v)) {
        out[k] = `[redacted:${k}]`;
        hits.push(k);
        continue;
      }
      out[k] = redactValue(v, hits);
    }
    return out;
  }
  return value;
}

/**
 * Redact a request body that may be a JSON string, a form body, or absent.
 * A non-JSON, non-credential body is returned BYTE-IDENTICAL.
 */
export function redactRequestBody(
  body: unknown,
  hits: string[] = [],
): { body: unknown; changed: boolean; hits: string[] } {
  if (typeof body !== "string" || body === "") return { body, changed: false, hits };
  // form-encoded: token=...&session=...
  if (/^[-\w.]+=[^&]*(&|$)/.test(body) && !/^\s*[{[]/.test(body)) {
    let changed = false;
    const next = body
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return pair;
        const key = pair.slice(0, eq);
        const val = pair.slice(eq + 1);
        if (CREDENTIAL_KEYS.has(decodeURIComponent(key).toLowerCase()) && val !== "") {
          changed = true;
          hits.push(key);
          return `${key}=${encodeURIComponent(`[redacted:${key}]`)}`;
        }
        if (looksLikeCredentialValue(decodeURIComponent(val))) {
          changed = true;
          hits.push(key);
          return `${key}=${encodeURIComponent(`[redacted:${key}]`)}`;
        }
        return pair;
      })
      .join("&");
    return { body: next, changed, hits };
  }
  // JSON
  const trimmed = body.trim();
  if (!/^[{[]/.test(trimmed)) {
    if (looksLikeCredentialValue(body)) {
      hits.push("<body>");
      return { body: `[redacted:<body>]`, changed: true, hits };
    }
    return { body, changed: false, hits };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { body, changed: false, hits };
  }
  const redacted = redactValue(parsed, hits);
  if (hits.length === 0) return { body, changed: false, hits };
  return { body: JSON.stringify(redacted), changed: true, hits };
}

/** Redact every network recipe's captured request body in an action map. */
export function redactActionMap(map: unknown): { map: unknown; hits: string[] } {
  const hits: string[] = [];
  const clone: any = JSON.parse(JSON.stringify(map));
  for (const action of clone?.actions ?? []) {
    const net = action?.recipe?.network;
    if (net && typeof net === "object" && "requestBody" in net) {
      const r = redactRequestBody(net.requestBody, hits);
      net.requestBody = r.body;
    }
  }
  return { map: clone, hits };
}
