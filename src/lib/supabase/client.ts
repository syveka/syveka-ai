"use client";

import { createBrowserClient } from "@supabase/ssr";
import { clientEnv } from "@/env";

/** Browser Supabase client — anon key, RLS enforced. */
export function createClient() {
  return createBrowserClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
