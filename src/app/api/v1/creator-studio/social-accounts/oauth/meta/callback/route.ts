import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * OAuth callback for Meta (Instagram + Facebook) Creator Studio publishing.
 * Mirrors src/app/api/v1/integrations/calendar/[provider]/callback/route.ts:
 * `state` is HMAC-signed and binds the flow to (org, user, platform) with a
 * 10-minute expiry — no session cookie is trusted here, and the platform
 * comes only from that signed state, never from a query param Meta didn't
 * itself send. On success the user lands back on the social accounts page.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const returnUrl = new URL("/creator-studio/social-accounts", url.origin);

  if (oauthError) {
    returnUrl.searchParams.set("social_error", "authorization_denied");
    return NextResponse.redirect(returnUrl);
  }
  if (!code || !state) {
    returnUrl.searchParams.set("social_error", "missing_code");
    return NextResponse.redirect(returnUrl);
  }

  const { completeMetaOAuthCallback, SocialConnectError } =
    await import("@/server/services/creator-social-accounts");
  const { SocialOAuthStateError } = await import("@/server/social/oauth-state");

  try {
    const result = await completeMetaOAuthCallback({ code, state });
    returnUrl.searchParams.set("social_connected", result.accountId);
    return NextResponse.redirect(returnUrl);
  } catch (e) {
    const code2 =
      e instanceof SocialConnectError || e instanceof SocialOAuthStateError
        ? e.code
        : "connect_failed";
    returnUrl.searchParams.set("social_error", code2);
    return NextResponse.redirect(returnUrl);
  }
}
