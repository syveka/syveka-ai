import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = new Set(["google", "microsoft", "mock"]);

/**
 * OAuth callback for calendar providers. `state` is HMAC-signed and binds
 * the flow to (org, user, provider) with a 10-minute expiry; the org comes
 * only from that state. The browser finishing the flow must also be signed
 * in as the user who started it: otherwise a victim lured to an attacker's
 * authorization URL would attach their calendar to the attacker's org
 * (login CSRF). On success the user lands back in settings.
 */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  if (!PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const settingsUrl = new URL("/settings/integrations", url.origin);

  if (!code || !state) {
    settingsUrl.searchParams.set("calendar_error", "missing_code");
    return NextResponse.redirect(settingsUrl);
  }

  const { completeConnection, verifyOAuthState, ConnectionError } =
    await import("@/server/services/calendar-connections");
  const { getTenantContextOrNull } = await import("@/server/auth/session");

  try {
    const session = await getTenantContextOrNull();
    if (!session || session.userId !== verifyOAuthState(state).userId) {
      settingsUrl.searchParams.set("calendar_error", "session_mismatch");
      return NextResponse.redirect(settingsUrl);
    }
    await completeConnection({
      provider: provider.toUpperCase() as "GOOGLE" | "MICROSOFT" | "MOCK",
      code,
      state,
    });
    settingsUrl.searchParams.set("calendar_connected", provider);
    return NextResponse.redirect(settingsUrl);
  } catch (e) {
    settingsUrl.searchParams.set(
      "calendar_error",
      e instanceof ConnectionError ? e.code : "connect_failed",
    );
    return NextResponse.redirect(settingsUrl);
  }
}
