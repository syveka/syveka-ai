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
function generateNonce(): string {
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
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://*.supabase.co https://lh3.googleusercontent.com",
    "font-src 'self'",
    "connect-src 'self' https://*.supabase.co",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  const nonce = generateNonce();
  const csp = buildCsp(nonce);
  // Mutating the incoming request's headers here (rather than only the
  // response) matters: next-intl's middleware clones from `request.headers`
  // when it builds its own rewrite/redirect response below, so this nonce
  // rides along and reaches Server Components via `headers()`.
  request.headers.set("x-nonce", nonce);

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

  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
