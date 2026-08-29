export function sameOrigin(url: string, base: string): boolean {
  try {
    const u = new URL(url, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.host === new URL(base).host;
  } catch { return false; }
}
