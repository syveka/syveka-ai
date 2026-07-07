import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/env";

/** RSC/Server Action Supabase client bound to the request cookies (RLS enforced). */
export async function createSupabaseServer() {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
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

/**
 * Service-role client — bypasses RLS. Server-only, used exclusively by
 * infrastructure code (auth admin ops, storage signing, GDPR jobs).
 * Business reads/writes go through Prisma + tenantDb (§4.3).
 */
export function createSupabaseAdmin() {
  // Lazy import keeps @supabase/supabase-js out of edge bundles that don't need it.
  const { createClient } = require("@supabase/supabase-js") as typeof import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
