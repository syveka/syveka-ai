import { type NextRequest, NextResponse } from "next/server";
import { localeFromPath, localizedPath, safeInternalNext } from "@/lib/auth-redirect";
import { createSupabaseRouteClient } from "@/server/supabase/server";

export async function GET(request: NextRequest) {
  const next = safeInternalNext(request.nextUrl.searchParams.get("next"));
  const locale = localeFromPath(next);
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.redirect(
      new URL(`${localizedPath(locale, "/login")}?error=auth_callback_failed`, request.url),
    );
  }

  const response = NextResponse.redirect(new URL(next, request.url));
  const supabase = createSupabaseRouteClient(request, response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`${localizedPath(locale, "/login")}?error=auth_callback_failed`, request.url),
    );
  }

  return response;
}
