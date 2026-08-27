import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminEnv, getSupabaseAuthEnv } from "@/env";

/**
 * TEMPORARY staging-only diagnostic logging for the BLOCKER A session
 * investigation (2026-08-27). Event name + safe metadata only — never
 * cookie values, tokens, email, or headers. Self-contained per file so
 * each can be reverted independently. Remove after root cause is proven.
 */
function logAuthEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ diag: "supabase_server_client", event, ...fields }));
}

function hasAuthCookie(all: Array<{ name: string }>): boolean {
  return all.some((c) => c.name.startsWith("sb-") && c.name.includes("-auth-token"));
}

/** RSC/Server Action Supabase client bound to the request cookies (RLS enforced). */
export async function createSupabaseServer() {
  const cookieStore = await cookies();
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getSupabaseAuthEnv();

  logAuthEvent(hasAuthCookie(cookieStore.getAll()) ? "auth_cookie_present" : "auth_cookie_absent");

  return createServerClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: Array<{ name: string; value: string; options: CookieOptions }>) => {
        logAuthEvent("cookie_write_attempted", { count: cookiesToSet.length });
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — session refresh happens in middleware.
          logAuthEvent("cookie_write_unavailable");
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
