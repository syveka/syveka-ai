import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Provider change-notification endpoint.
 * - Google: pings with X-Goog-Channel-Id / X-Goog-Resource-State headers.
 * - Microsoft Graph: validation handshake (validationToken echo) + JSON
 *   notifications carrying subscriptionId.
 * Payloads carry no event data — we only learn "something changed" and run
 * the idempotent incremental sync for the matching calendar. Unknown
 * subscription ids are acknowledged and dropped (no information leak).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  const p = provider.toUpperCase();
  if (p !== "GOOGLE" && p !== "MICROSOFT" && p !== "MOCK") {
    return NextResponse.json({ error: "unknown provider" }, { status: 404 });
  }

  // Microsoft subscription validation handshake.
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const subscriptionIds = new Set<string>();
  if (p === "GOOGLE") {
    const channelId = request.headers.get("x-goog-channel-id");
    if (channelId) subscriptionIds.add(channelId);
  } else {
    try {
      const body = (await request.json()) as {
        value?: Array<{ subscriptionId?: string }>;
      };
      for (const n of body.value ?? []) {
        if (n.subscriptionId) subscriptionIds.add(n.subscriptionId);
      }
    } catch {
      // Empty/no JSON body → nothing to do.
    }
  }
  if (subscriptionIds.size === 0) return NextResponse.json({ ok: true });

  const { handleProviderWebhook } = await import("@/server/services/calendar-sync");
  await Promise.allSettled(
    [...subscriptionIds].map((subscriptionId) =>
      handleProviderWebhook({ provider: p, subscriptionId }),
    ),
  );
  return NextResponse.json({ ok: true });
}
