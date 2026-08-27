"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServer } from "@/server/supabase/server";
import { rateLimiters } from "@/server/integrations/redis";
import { loginSchema, registerSchema } from "@/lib/validators/auth";
import { getAppUrlEnv } from "@/env";
import { localizedPath, normalizeLocale } from "@/lib/auth-redirect";

export type AuthActionState = { error?: string; message?: string };

/**
 * TEMPORARY staging-only diagnostic logging for the loginAction P1000
 * investigation (2026-08-27). Event name + safe metadata only — never
 * email, password, tokens, cookies, or headers. Remove after the root
 * cause is confirmed, or promote to permanent observability if useful.
 */
function logAuthEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ diag: "login_action", event, ...fields }));
}

function authCallbackUrl(locale: ReturnType<typeof normalizeLocale>, next: `/${string}`): string {
  const { NEXT_PUBLIC_APP_URL } = getAppUrlEnv();
  const callback = new URL("/api/auth/callback", NEXT_PUBLIC_APP_URL);
  callback.searchParams.set("next", localizedPath(locale, next));
  return callback.toString();
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function loginAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  logAuthEvent("login_action_started");

  const { success } = await rateLimiters.auth.limit(`login:${await clientIp()}`);
  logAuthEvent(success ? "rate_limit_allowed" : "rate_limit_blocked");
  if (!success) return { error: "rate_limited" };

  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  let destination: string;
  try {
    const supabase = await createSupabaseServer();
    const { error } = await supabase.auth.signInWithPassword(parsed.data);

    if (error) {
      logAuthEvent("supabase_signin_failure", {
        code: error.code ?? null,
        status: error.status ?? null,
        name: error.name,
      });
      return { error: "invalid_credentials" };
    }

    logAuthEvent("supabase_signin_success");
    destination = localizedPath(normalizeLocale(formData.get("locale")), "/dashboard");
  } catch (e) {
    // Deliberately outside the redirect() call below — Next.js's redirect()
    // throws its own internal control-flow signal, which must never be
    // caught and logged here as an unexpected exception.
    logAuthEvent("unexpected_exception", {
      errorClass: e instanceof Error ? e.constructor.name : typeof e,
      errorName: e instanceof Error ? e.name : undefined,
    });
    throw e;
  }

  logAuthEvent("redirect_attempted", { destination });
  redirect(destination);
}

export async function registerAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { success } = await rateLimiters.auth.limit(`register:${await clientIp()}`);
  if (!success) return { error: "rate_limited" };

  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };
  const locale = normalizeLocale(formData.get("locale"));

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: authCallbackUrl(locale, "/onboarding"),
    },
  });
  if (error) return { error: "signup_failed" };

  return { message: "verify_email_sent" };
}

export async function magicLinkAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { success } = await rateLimiters.auth.limit(`magic:${await clientIp()}`);
  if (!success) return { error: "rate_limited" };

  const email = String(formData.get("email") ?? "");
  if (!email.includes("@")) return { error: "invalid_input" };
  const locale = normalizeLocale(formData.get("locale"));

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: authCallbackUrl(locale, "/dashboard") },
  });
  if (error) return { error: "magic_link_failed" };
  return { message: "verify_email_sent" };
}

export async function logoutAction(): Promise<void> {
  const supabase = await createSupabaseServer();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function forgotPasswordAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { success } = await rateLimiters.auth.limit(`forgot:${await clientIp()}`);
  if (!success) return { error: "rate_limited" };

  const email = String(formData.get("email") ?? "");
  if (!email.includes("@")) return { error: "invalid_input" };
  const locale = normalizeLocale(formData.get("locale"));

  const supabase = await createSupabaseServer();
  // Always report success — do not leak account existence (§13)
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: authCallbackUrl(locale, "/reset-password"),
  });
  return { message: "verify_email_sent" };
}

export async function resetPasswordAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const password = String(formData.get("password") ?? "");
  if (password.length < 12) return { error: "invalid_input" };

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: "reset_failed" };

  redirect(localizedPath(normalizeLocale(formData.get("locale")), "/dashboard"));
}
