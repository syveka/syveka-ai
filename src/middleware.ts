import { type NextRequest, NextResponse } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { createServerClient } from "@supabase/ssr";
import { routing } from "@/i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

/** Paths (locale-stripped) that require an authenticated session. */
const PROTECTED_PREFIXES = [
  "/dashboard", "/chat", "/voice", "/crm", "/calendar", "/analytics",
  "/knowledge", "/prompts", "/workflows", "/notifications", "/settings",
  "/onboarding", "/admin",
];

const AUTH_PAGES = ["/login", "/register", "/forgot-password", "/reset-password"];

function stripLocale(pathname: string): string {
  const seg = pathname.split("/")[1];
  if (seg && (routing.locales as readonly string[]).includes(seg)) {
    return pathname.slice(seg.length + 1) || "/";
  }
  return pathname;
}

export async function middleware(request: NextRequest) {
  // 1. Locale handling (rewrite/redirect + sets the response we build on)
  const response = intlMiddleware(request);

  // 2. Session refresh — keeps the JWT alive on every request (§11.2)
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          for (const { name, value, options } of cookies) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = stripLocale(request.nextUrl.pathname);
  const isProtected = PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
  const isAuthPage = AUTH_PAGES.some((p) => path === p || path.startsWith(`${p}/`));

  // 3. Route guards — authentication only; RBAC lives in layouts/actions (§11.4)
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  if (isAuthPage && user) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // 4. Superadmin gate (allowlist claim re-checked server-side in the layout)
  if (path.startsWith("/admin")) {
    const isSuperadmin = user?.app_metadata?.is_superadmin === true;
    if (!isSuperadmin) {
      const url = request.nextUrl.clone();
      url.pathname = "/dashboard";
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  // Skip static assets and API routes (API auth is handled per-route)
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
