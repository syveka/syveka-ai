import { NextResponse } from "next/server";
import { z } from "zod";
import { isCrossOrigin } from "@/server/security/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(code: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { code, ...extra } }, { status });
}

/** Which daily limit refused a start (the code stays voice_daily_limit_reached). */
const START_REASONS = {
  daily_sessions: "daily_sessions",
  daily_turns: "daily_turns",
  daily_budget: "daily_audio",
} as const;

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

const startSchema = z.object({ conversationId: z.string().uuid().optional() }).strict();

/**
 * Starts a live voice session bound to one conversation.
 *
 * - An existing conversation must belong to the signed-in user in their
 *   organization (the same rule as the chat route); a client-supplied id is
 *   never trusted without that check.
 * - A new chat gets a conversation id reserved here by the server; the row is
 *   created by the first accepted turn, so ending without speaking leaves no
 *   empty conversation.
 *
 * Everything that can refuse the request (auth, pilot membership, limits,
 * rate limit, conversation access, capacity, daily budgets) is checked before
 * the organization's daily session slot is consumed. A successful start uses
 * the slot for the Helsinki day; it is not refunded when the session ends
 * early. No provider work happens here; every paid turn is reserved
 * separately.
 */
export async function POST(request: Request): Promise<Response> {
  const g = await guard(request, { requireMember: true });
  if (!g.ok) return g.response;
  if (!g.config) return error("voice_conversation_unavailable", 503);
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return error("invalid_input", 400);
  }
  const body = startSchema.safeParse(raw);
  if (!body.success) return error("invalid_input", 400);

  const [{ redis, limitAiVoiceTurn }, { tenantDb }] = await Promise.all([
    import("@/server/integrations/redis"),
    import("@/server/db/tenant"),
  ]);
  const limit = await limitAiVoiceTurn(g.ctx.orgId, g.ctx.userId);
  if (!limit.success) {
    return error(
      limit.unavailable ? "voice_conversation_unavailable" : "rate_limited",
      limit.unavailable ? 503 : 429,
    );
  }

  let conversation: { id: string; isNew: boolean };
  if (body.data.conversationId) {
    const found = await tenantDb(g.ctx.orgId).conversation.findFirst({
      where: { id: body.data.conversationId, userId: g.ctx.userId, deletedAt: null },
      select: { id: true },
    });
    if (!found) return error("resource_not_found", 404);
    conversation = { id: found.id, isNew: false };
  } else {
    conversation = { id: crypto.randomUUID(), isNew: true };
  }

  try {
    const config = g.config;
    const result = await g.conversation.startVoiceSession(
      redis,
      g.ctx,
      config,
      crypto.randomUUID(),
      conversation,
    );
    if (!result.ok) {
      if (result.reason === "org_capacity") return error("voice_capacity_reached", 429);
      return error("voice_daily_limit_reached", 429, {
        reason: START_REASONS[result.reason],
        allowance: await g.conversation.tryReadVoiceAllowance(redis, g.ctx, config),
      });
    }
    return NextResponse.json({
      data: {
        sessionId: result.sessionId,
        conversationId: conversation.id,
        expiresAt: result.expiresAt,
        maxTurnSeconds: config.maxTurnSeconds,
        sessionSeconds: config.sessionSeconds,
        // Read after the start, from the server's counters (null: unknown).
        allowance: await g.conversation.tryReadVoiceAllowance(
          redis,
          g.ctx,
          config,
          result.sessionId,
        ),
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
 * Today's live-voice allowance for the signed-in user's organization, before
 * starting: starts, turns and audio left, when they renew (Helsinki
 * midnight), and the session's maximum duration. Read-only: it never starts
 * a session, reserves a turn or changes a counter. The organization comes
 * only from the server-verified session; no identifier is accepted.
 */
export async function GET(request: Request): Promise<Response> {
  const g = await guard(request, { requireMember: true });
  if (!g.ok) return g.response;
  if (!g.config) return error("voice_conversation_unavailable", 503);
  if (new URL(request.url).search) return error("invalid_input", 400);
  const { redis, limitAiVoiceTurn } = await import("@/server/integrations/redis");
  const limit = await limitAiVoiceTurn(g.ctx.orgId, g.ctx.userId).catch(() => null);
  if (!limit || limit.unavailable) return error("voice_conversation_unavailable", 503);
  if (!limit.success) return error("rate_limited", 429);
  const allowance = await g.conversation.tryReadVoiceAllowance(redis, g.ctx, g.config);
  if (!allowance) return error("voice_conversation_unavailable", 503);
  return NextResponse.json({ data: allowance });
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
