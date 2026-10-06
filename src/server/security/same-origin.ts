/**
 * Defense in depth against cross-site requests. The session cookie is
 * SameSite=Lax (not sent on cross-site POSTs), but endpoints that accept
 * multipart form data — a request any site can send without a CORS
 * preflight — and trigger paid work also require a same-origin browser
 * request. Non-browser clients sending neither header still need a
 * valid session.
 */
export function isCrossOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
