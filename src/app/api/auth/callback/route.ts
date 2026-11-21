import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import {
  inviteContinuation,
  localeFromPath,
  localizedPath,
  safeInternalNext,
} from "@/lib/auth-redirect";
import { checkRateLimit } from "@/server/integrations/redis";
import { createSupabaseRouteClient } from "@/server/supabase/server";

// Only the email links this app sends: sign-up confirmation ("email", and the
// older "signup"), magic link ("magiclink", older; new templates use "email")
// and password recovery. Invitations are sent by the app itself, not through
// Supabase, so "invite" and "email_change" are refused.
const TOKEN_HASH_TYPES = new Set<EmailOtpType>(["email", "signup", "magiclink", "recovery"]);

function tokenHashType(value: string | null): EmailOtpType | null {
  return value !== null && TOKEN_HASH_TYPES.has(value) ? value : null;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeInternalNext(params.get("next"));
  const locale = localeFromPath(next);
  const code = params.get("code");
  const tokenHash = params.get("token_hash");

  // A PKCE `code` link opened in a different browser from the one that
  // requested it (for example a phone's mail app) has no verifier there, so
  // the exchange fails; `token_hash` links (docs/auth-email-links.md) work in
  // any browser. An invitation is kept, so signing in on this login page still
  // returns to it instead of to "Create your organization".
  const failed = () => {
    const unlocalized = next.startsWith(`/${locale}/`) ? next.slice(locale.length + 1) : next;
    const invitation = inviteContinuation(unlocalized);
    const query = new URLSearchParams({ error: "auth_callback_failed" });
    if (invitation) query.set("next", invitation);
    return NextResponse.redirect(
      new URL(`${localizedPath(locale, "/login")}?${query}`, request.url),
    );
  };

  if (code) {
    const response = NextResponse.redirect(new URL(next, request.url));
    const supabase = createSupabaseRouteClient(request, response);
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) return failed();

    return response;
  }

  const type = tokenHashType(params.get("type"));
  if (!tokenHash || !type) return failed();

  // verifyOtp reaches Supabase from this server's address, so unlimited
  // guessing here would use up Supabase's verification limit for every user.
  // Fails closed, like the other auth limits.
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
  const limited = await checkRateLimit("auth", `auth-callback:${ip}`);
  if (!limited.ok) return failed();

  // A recovery link lands on the reset form, whatever `next` says. This is
  // navigation, not a security boundary: the session is a full session.
  const destination = type === "recovery" ? localizedPath(locale, "/reset-password") : next;
  const response = NextResponse.redirect(new URL(destination, request.url));
  const supabase = createSupabaseRouteClient(request, response);
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });

  if (error) return failed();

  return response;
}
