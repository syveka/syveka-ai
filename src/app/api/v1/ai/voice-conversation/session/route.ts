import { NextResponse } from "next/server";
import { z } from "zod";
import { isCrossOrigin } from "@/server/security/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

const endSchema = z.object({ sessionId: z.string().uuid() }).strict();

async function guard(request: Request, { requireMember }: { requireMember: boolean }) {
  const [{ getTenantContext }, { can }, conversation] = await Promise.all([
    import("@/server/auth/session"),
    import("@/server/auth/permissions"),
    import("@/server/ai/voice-conversation"),
  ]);
  if (isCrossOrigin(request))
    return { ok: false as const, response: error("cross_origin_request", 403) };
  let ctx;
  try {
    ctx = await getTenantContext();
  } catch {
    return { ok: false as const, response: error("unauthenticated", 401) };
  }
  if (!can(ctx.role, "chat:use"))
    return { ok: false as const, response: error("permission_denied", 403) };
  // Ending never requires membership: a session must always be closable,
  // even if the feature was switched off meanwhile.
  if (!requireMember) return { ok: true as const, ctx, config: null, conversation };
  if (!conversation.isVoiceConversationMember(ctx)) {
    return { ok: false as const, response: error("voice_conversation_not_enabled", 403) };
  }
  const config = conversation.readVoiceConversationConfig();
  if (!config)
    return { ok: false as const, response: error("voice_conversation_unavailable", 503) };
  return { ok: true as const, ctx, config, conversation };
}

/**
 * Starts a live voice session: one per user (a new start replaces the user's
 * own previous session, e.g. from another tab), capped per organization,
 * refused once the organization's daily audio budget is used. No provider
 * work happens here; every paid turn is reserved separately.
 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, { requireMember: true });
  if (!g.ok) return g.response;
  if (!g.config) return error("voice_conversation_unavailable", 503);
  const { redis } = await import("@/server/integrations/redis");
  try {
    const config = g.config;
    const result = await g.conversation.startVoiceSession(
      redis,
      g.ctx,
      config,
      crypto.randomUUID(),
    );
    if (!result.ok) {
      return error(
        result.reason === "daily_budget" ? "voice_daily_limit_reached" : "voice_capacity_reached",
        429,
      );
    }
    return NextResponse.json({
      data: {
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        maxTurnSeconds: config.maxTurnSeconds,
        sessionSeconds: config.sessionSeconds,
      },
    });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "voice_conversation_store_unavailable",
        op: "start",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return error("voice_conversation_unavailable", 503);
  }
}

/**
 * Ends a session (also sent as a keepalive fetch on page hide). Only the
 * owning user can end it; ending an already-ended session is a no-op.
 */
export async function DELETE(request: Request): Promise<Response> {
  const g = await guard(request, { requireMember: false });
  if (!g.ok) return g.response;
  const url = new URL(request.url);
  const body = endSchema.safeParse({ sessionId: url.searchParams.get("sessionId") ?? undefined });
  if (!body.success) return error("invalid_input", 400);
  const { redis } = await import("@/server/integrations/redis");
  try {
    const result = await g.conversation.endVoiceSession(redis, g.ctx, body.data.sessionId);
    if (result === "not_owner") return error("resource_not_found", 404);
    return NextResponse.json({ data: { ended: true } });
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "voice_conversation_store_unavailable",
        op: "end",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return error("voice_conversation_unavailable", 503);
  }
}
