"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client — anon key, RLS enforced.
 *
 * Deliberately reads NEXT_PUBLIC_SUPABASE_URL/NEXT_PUBLIC_SUPABASE_ANON_KEY
 * as direct, literal `process.env.NEXT_PUBLIC_X` expressions instead of
 * through getSupabaseAuthEnv() (which parses the *whole* process.env object
 * with zod). Next.js can only inline NEXT_PUBLIC_ vars into the client
 * bundle at build time when they're accessed via that exact literal syntax;
 * handing the whole object to a dynamic consumer resolves to undefined for
 * both values in the browser, since no populated process.env exists there.
 * Confirmed live on staging: every authenticated route crashed with
 * "Invalid Supabase auth environment variables" the moment Topbar's
 * useUnreadBadge (the only client-side caller of this file) mounted.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return createBrowserClient(url, anonKey);
}
