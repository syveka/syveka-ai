import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_AUDIO_BYTES, MIN_AUDIO_BYTES, MIN_RECORDING_MS } from "@/lib/voice/audio";
import { measureAudioDuration } from "@/lib/voice/audio-duration";
import { isCrossOrigin } from "@/server/security/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Upper bound on the single provider attempt. */
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
/** Verified list price for gpt-4o-mini-transcribe (cost estimate only). */
const TRANSCRIPTION_USD_PER_MINUTE = 0.003;
const CONTAINER_MIME = { webm: "audio/webm", mp4: "audio/mp4" } as const;

const fieldsSchema = z.object({ sessionId: z.string().uuid(), turnId: z.string().uuid() }).strict();

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

/**
 * One finished spoken turn of a live voice conversation → text. The text is
 * returned to the client, which submits it through the normal chat pipeline
 * (same session, permissions, moderation, Business DNA, RAG, accounting).
 *
 * Paid work happens only after every check passes and the turn is reserved
 * atomically against the session (owner, expiry, turn cap, idempotent turn
 * id) and the organization's daily audio budget. The reservation is never
 * refunded, and there is exactly one provider attempt (no retries).
 */
export async function POST(request: Request): Promise<Response> {
  const [
    { getTenantContext },
    { can },
    { limitAiVoiceTurn, redis },
    { transcribeAudio, TRANSCRIPTION_MODEL },
    { assertWithinLimit, getMonthUsage, recordUsage, EntitlementError },
    conversation,
  ] = await Promise.all([
    import("@/server/auth/session"),
    import("@/server/auth/permissions"),
    import("@/server/integrations/redis"),
    import("@/server/integrations/openai"),
    import("@/server/services/billing/entitlements"),
    import("@/server/ai/voice-conversation"),
  ]);

  if (isCrossOrigin(request)) return error("cross_origin_request", 403);
  let ctx;
  try {
    ctx = await getTenantContext();
  } catch {
    return error("unauthenticated", 401);
  }
  if (!can(ctx.role, "chat:use")) return error("permission_denied", 403);
  if (!conversation.isVoiceConversationMember(ctx)) {
    return error("voice_conversation_not_enabled", 403);
  }
  const config = conversation.readVoiceConversationConfig();
  if (!config) return error("voice_conversation_unavailable", 503);

  const rate = await limitAiVoiceTurn(ctx.orgId, ctx.userId).catch(() => null);
  if (!rate || rate.unavailable) return error("voice_conversation_unavailable", 503);
  if (!rate.success) return error("rate_limited", 429);

  // Every voice turn becomes a chat message; refuse once chat is out of quota.
  try {
    const userMonthCount = await getMonthUsage(ctx.orgId, "AI_MESSAGES");
    await assertWithinLimit(ctx.orgId, { kind: "ai_messages", userMonthCount });
  } catch (e) {
    if (e instanceof EntitlementError) return error(e.code, 402);
    throw e;
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_AUDIO_BYTES + 64 * 1024) return error("audio_too_large", 413);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error("invalid_input", 400);
  }
  const fields = fieldsSchema.safeParse({
    sessionId: form.get("sessionId") ?? undefined,
    turnId: form.get("turnId") ?? undefined,
  });
  const audio = form.get("audio");
  if (!fields.success || !(audio instanceof File)) return error("invalid_input", 400);
  if (audio.size > MAX_AUDIO_BYTES) return error("audio_too_large", 413);
  if (audio.size < MIN_AUDIO_BYTES) return error("audio_too_short", 422);

  const bytes = new Uint8Array(await audio.arrayBuffer());
  const measured = measureAudioDuration(bytes);
  if (!measured) return error("unsupported_audio_format", 415);
  if (measured.seconds > config.maxTurnSeconds) return error("audio_too_long", 422);
  if (measured.seconds * 1000 < MIN_RECORDING_MS) return error("audio_too_short", 422);

  let reservation;
  try {
    reservation = await conversation.reserveVoiceTurn(
      redis,
      ctx,
      config,
      fields.data.sessionId,
      fields.data.turnId,
      measured.seconds * 1000,
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "voice_conversation_store_unavailable",
        op: "turn",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return error("voice_conversation_unavailable", 503);
  }
  if (!reservation.ok) {
    const status =
      reservation.reason === "daily_budget" || reservation.reason === "turn_limit" ? 429 : 409;
    const code =
      reservation.reason === "daily_budget" ? "voice_daily_limit_reached" : reservation.reason;
    return error(code, status);
  }

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)]);
  const startedAt = Date.now();
  let text: string;
  try {
    text = await transcribeAudio(bytes, measured.container, signal);
  } catch (e) {
    if (request.signal.aborted) return error("request_aborted", 499);
    const timedOut = signal.aborted;
    console.error(
      JSON.stringify({
        event: "voice_conversation_transcription_failed",
        reason: timedOut ? "timeout" : "provider_error",
        name: e instanceof Error ? e.name : "unknown",
        status: (e as { status?: unknown }).status ?? null,
      }),
    );
    return timedOut ? error("transcription_timeout", 504) : error("transcription_failed", 502);
  }

  const audioSeconds = Number(measured.seconds.toFixed(2));
  await recordUsage(ctx.orgId, "API_CALLS", 1, {
    kind: "ai_voice_conversation_turn",
    model: TRANSCRIPTION_MODEL,
    userId: ctx.userId,
    audioBytes: bytes.length,
    audioFormat: CONTAINER_MIME[measured.container],
    audioSeconds,
    estimatedCostUsd: Number(((audioSeconds / 60) * TRANSCRIPTION_USD_PER_MINUTE).toFixed(6)),
    latencyMs: Date.now() - startedAt,
  });

  const remainingSeconds = Math.max(
    0,
    Math.floor((config.dailyOrgAudioSeconds * 1000 - reservation.usedMs) / 1000),
  );
  return NextResponse.json({ data: { text, dailyRemainingSeconds: remainingSeconds } });
}
