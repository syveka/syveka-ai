import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminEnv, getSupabaseAuthEnv } from "@/env";

/** RSC/Server Action Supabase client bound to the request cookies (RLS enforced). */
export async function createSupabaseServer() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getSupabaseAuthEnv();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — session refresh happens in middleware.
        }
      },
    },
  });
}

/** Route-handler client that writes refreshed PKCE/session cookies to the returned response. */
export function createSupabaseRouteClient(request: NextRequest, response: NextResponse) {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getSupabaseAuthEnv();

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) => {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });
}

/**
 * Vercel Edge Middleware is killed by the platform (MIDDLEWARE_INVOCATION_TIMEOUT,
 * surfaced to the browser as a 504) after ~25s with no way for our own code to
 * intervene. `@supabase/auth-js` issues its `/auth/v1/user` fetch with no
 * AbortController or timeout of its own (see its `_handleRequest`), so any
 * transient slowness reaching Supabase's Auth API — for any reason — hangs the
 * *entire* middleware invocation up to that platform limit instead of failing
 * fast. Bounding the request ourselves, scoped to only this middleware client,
 * turns an unbounded platform-level 504 into a fast, handled "treat as
 * unauthenticated" outcome (fail closed on protected routes, per §4).
 */
const MIDDLEWARE_AUTH_TIMEOUT_MS = 8000;

function timeoutFetch(timeoutMs: number): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  };
}

/**
 * Middleware Supabase client — the documented @supabase/ssr Next.js
 * middleware pattern. Unlike a route handler, middleware must keep the
 * request's own cookie jar in sync too (not just the response), because
 * `setAll` can fire mid-pipeline and any code reading `request.cookies`
 * afterward must see the refreshed values. Each `setAll` call therefore
 * rebuilds `NextResponse.next({ request })` from the mutated request so the
 * refreshed Set-Cookie headers are never lost. Call `auth.getUser()`
 * immediately after creating this client — it revalidates the session
 * against Supabase (unlike `getSession()`, which only decodes the local
 * JWT) — before running any other middleware logic, matching Supabase's
 * own documented warning about this exact ordering.
 */
export function createSupabaseMiddlewareClient(request: NextRequest): {
  supabase: ReturnType<typeof createServerClient>;
  response: { current: NextResponse };
} {
  const response = { current: NextResponse.next({ request }) };
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getSupabaseAuthEnv();

  const supabase = createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response.current = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.current.cookies.set(name, value, options);
        }
      },
    },
    global: {
      fetch: timeoutFetch(MIDDLEWARE_AUTH_TIMEOUT_MS),
    },
  });

  return { supabase, response };
}

/**
 * Service-role client — bypasses RLS. Server-only, used exclusively by
 * infrastructure code (auth admin ops, storage signing, GDPR jobs).
 * Business reads/writes go through Prisma + tenantDb (§4.3).
 */
export function createSupabaseAdmin() {
  const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = getSupabaseAdminEnv();
  return createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
