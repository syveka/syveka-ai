import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

const PROTECTED_PREFIXES = [
  "/dashboard",
  "/chat",
  "/voice",
  "/crm",
  "/calendar",
  "/analytics",
  "/knowledge",
  "/prompts",
  "/workflows",
  "/notifications",
  "/settings",
  "/onboarding",
  "/admin",
];

const AUTH_PAGES = ["/login", "/register", "/forgot-password", "/reset-password"];

function stripLocale(pathname: string): string {
  const seg = pathname.split("/")[1];
  if (seg && (routing.locales as readonly string[]).includes(seg)) {
    return pathname.slice(seg.length + 1) || "/";
  }
  return pathname;
}

function hasSupabaseSessionCookie(request: NextRequest): boolean {
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("-auth-token"));
}

/** Per-request nonce (Web Crypto only — Buffer is unavailable on the Edge runtime). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Nonce-based CSP (§13.2). No third-party script/style/font origins are used
 * by this app (Stripe Checkout is a server-side redirect, not embedded JS;
 * Supabase Storage/Google avatars are images only) — see next.config.ts's
 * image `remotePatterns` for the same two origins reflected in `img-src`.
 */
function supabaseCspOrigins(): { https: string; wss: string } | null {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (url.protocol !== "https:") return null;
    return { https: url.origin, wss: `wss://${url.host}` };
  } catch {
    return null;
  }
}

export function buildContentSecurityPolicy(nonce: string): string {
  const supabase = supabaseCspOrigins();
  const imageOrigins = ["'self'", "data:", "https://lh3.googleusercontent.com"];
  const connectionOrigins = ["'self'"];
  if (supabase) {
    imageOrigins.push(supabase.https);
    connectionOrigins.push(supabase.https, supabase.wss);
  }

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    // Several UI components use React style attributes for data-driven widths
    // and heights. Nonces cannot authorize style attributes, so this is the
    // narrow compatibility exception; no third-party style origin is allowed.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imageOrigins.join(" ")}`,
    "font-src 'self'",
    `connect-src ${connectionOrigins.join(" ")}`,
    // Vapi recording URLs arrive dynamically in webhook payloads and are
    // rendered by the existing call-details audio player. Their host is not a
    // stable configured origin, so HTTPS is the narrowest portable allowance.
    "media-src 'self' https:",
    "worker-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/**
 * Preserve the response produced by next-intl while forwarding request
 * headers to Next's renderer. This is the header protocol used internally by
 * NextResponse.next({ request: { headers } }).
 */
function forwardRequestHeaders(response: NextResponse, headers: Headers): void {
  const existingOverrides = response.headers.get("x-middleware-override-headers");
  const keys = new Set(
    existingOverrides
      ? existingOverrides
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean)
      : [],
  );

  for (const [key, value] of headers) {
    response.headers.set(`x-middleware-request-${key}`, value);
    keys.add(key);
  }
  response.headers.set("x-middleware-override-headers", [...keys].join(","));
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildContentSecurityPolicy(nonce);

  const response = intlMiddleware(request);
  const path = stripLocale(request.nextUrl.pathname);
  const isProtected = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  const isAuthPage = AUTH_PAGES.some((p) => path === p || path.startsWith(`${p}/`));
  const hasSession = hasSupabaseSessionCookie(request);

  if (isProtected && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  if (isAuthPage && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  forwardRequestHeaders(response, requestHeaders);
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
