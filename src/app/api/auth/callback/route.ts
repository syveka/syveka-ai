import { type NextRequest, NextResponse } from "next/server";
import {
  inviteContinuation,
  localeFromPath,
  localizedPath,
  safeInternalNext,
} from "@/lib/auth-redirect";
import { createSupabaseRouteClient } from "@/server/supabase/server";

export async function GET(request: NextRequest) {
  const next = safeInternalNext(request.nextUrl.searchParams.get("next"));
  const locale = localeFromPath(next);
  const code = request.nextUrl.searchParams.get("code");

  // A link opened in a different browser from the one that requested it (for
  // example a phone's mail app) has no PKCE verifier there, so the exchange
  // fails. An invitation is kept, so signing in on this login page still
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

  if (!code) return failed();

  const response = NextResponse.redirect(new URL(next, request.url));
  const supabase = createSupabaseRouteClient(request, response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) return failed();

  return response;
}
