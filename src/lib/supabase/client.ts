"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseAuthEnv } from "@/env";

/** Browser Supabase client — anon key, RLS enforced. */
export function createClient() {
  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY } = getSupabaseAuthEnv();
  return createBrowserClient(NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
