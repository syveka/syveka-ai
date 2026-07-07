"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServer } from "@/server/supabase/server";
import { rateLimiters } from "@/server/integrations/redis";
import { loginSchema, registerSchema } from "@/lib/validators/auth";
import { env } from "@/env";

export type AuthActionState = { error?: string; message?: string };

async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

export async function loginAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { success } = await rateLimiters.auth.limit(`login:${await clientIp()}`);
  if (!success) return { error: "rate_limited" };

  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: "invalid_credentials" };

  redirect("/dashboard");
}

export async function registerAction(
  _prev: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const { success } = await rateLimiters.auth.limit(`register:${await clientIp()}`);
  if (!success) return { error: "rate_limited" };

  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/onboarding`,
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

  const supabase = await createSupabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${env.NEXT_PUBLIC_APP_URL}/dashboard` },
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

  const supabase = await createSupabaseServer();
  // Always report success — do not leak account existence (§13)
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${env.NEXT_PUBLIC_APP_URL}/reset-password`,
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

  redirect("/dashboard");
}
