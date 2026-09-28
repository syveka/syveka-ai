import { NextResponse } from "next/server";
import {
  MAX_AUDIO_BYTES,
  MAX_RECORDING_SECONDS,
  MIN_AUDIO_BYTES,
  MIN_RECORDING_MS,
} from "@/lib/voice/audio";
import { measureAudioDuration } from "@/lib/voice/audio-duration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Upper bound on provider work per request (retries included). */
const TRANSCRIPTION_TIMEOUT_MS = 30_000;
/** gpt-4o-mini-transcribe list price, USD per audio minute (cost estimate only). */
const TRANSCRIPTION_USD_PER_MINUTE = 0.003;
/** Slack over the recorder's auto-stop (timer tick + encoder flush). */
const DURATION_TOLERANCE_SECONDS = 3;
const CONTAINER_MIME = { webm: "audio/webm", mp4: "audio/mp4" } as const;

function error(code: string, status: number, headers?: HeadersInit) {
  return NextResponse.json({ error: { code } }, { status, headers });
}

/**
 * Defense in depth against cross-site requests. The session cookie is
 * SameSite=Lax (not sent on cross-site POSTs), but this endpoint accepts
 * multipart form data — a request any site can send without a CORS
 * preflight — and triggers paid work, so it also requires a same-origin
 * browser request. Non-browser clients sending neither header still need a
 * valid session.
 */
function isCrossOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/**
 * Chat voice input: turns one short recording into text that the user then
 * reviews and sends through the normal chat pathway. The transcript is only
 * returned — never sent, stored or executed here. The audio is held in memory
 * for this request and not retained.
 */
export async function POST(request: Request): Promise<Response> {
  const [
    { getTenantContext },
    { can },
    { limitAiTranscription },
    { transcribeAudio, TRANSCRIPTION_MODEL },
    { assertWithinLimit, getMonthUsage, recordUsage, EntitlementError },
    { isChatTranscriptionEnabled },
  ] = await Promise.all([
    import("@/server/auth/session"),
    import("@/server/auth/permissions"),
    import("@/server/integrations/redis"),
    import("@/server/integrations/openai"),
    import("@/server/services/billing/entitlements"),
    import("@/env"),
  ]);

  // ── Guardrails: origin → auth → permission → availability → rate limit → entitlement ──
  if (isCrossOrigin(request)) return error("cross_origin_request", 403);
  let ctx;
  try {
    ctx = await getTenantContext();
  } catch {
    return error("unauthenticated", 401);
  }
  if (!can(ctx.role, "chat:use")) return error("permission_denied", 403);
  if (!isChatTranscriptionEnabled()) return error("transcription_unavailable", 503);

  const rateLimit = await limitAiTranscription(ctx.orgId, ctx.userId);
  if (rateLimit.unavailable) return error("transcription_unavailable", 503);
  if (!rateLimit.success) {
    return error("rate_limited", 429, {
      "Retry-After": String(Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000))),
    });
  }

  // Dictation only feeds a chat message, so it is refused once the chat quota
  // is exhausted rather than paying to transcribe a message that can't be sent.
  try {
    const userMonthCount = await getMonthUsage(ctx.orgId, "AI_MESSAGES");
    await assertWithinLimit(ctx.orgId, { kind: "ai_messages", userMonthCount });
  } catch (e) {
    if (e instanceof EntitlementError) return error(e.code, 402);
    throw e;
  }

  // ── Input: size before parsing, then the actual bytes ──
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_AUDIO_BYTES + 64 * 1024) return error("audio_too_large", 413);

  let audio: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get("audio");
    audio = value instanceof File ? value : null;
  } catch {
    return error("invalid_input", 400);
  }
  if (!audio) return error("invalid_input", 400);
  if (audio.size > MAX_AUDIO_BYTES) return error("audio_too_large", 413);
  if (audio.size < MIN_AUDIO_BYTES) return error("audio_too_short", 422);

  const bytes = new Uint8Array(await audio.arrayBuffer());
  // Duration is measured from the audio frames the provider will decode; the
  // browser's 60 s auto-stop is not trusted. Unmeasurable input is refused.
  const measured = measureAudioDuration(bytes);
  if (!measured) return error("unsupported_audio_format", 415);
  if (measured.seconds > MAX_RECORDING_SECONDS + DURATION_TOLERANCE_SECONDS) {
    return error("audio_too_long", 422);
  }
  if (measured.seconds * 1000 < MIN_RECORDING_MS) return error("audio_too_short", 422);
  const container = measured.container;

  // ── Provider call, bounded ──
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS)]);
  const startedAt = Date.now();
  let text: string;
  try {
    text = await transcribeAudio(bytes, container, signal);
  } catch (e) {
    if (request.signal.aborted) return error("request_aborted", 499);
    const timedOut = signal.aborted;
    // Error class/status only: never the audio, the transcript or provider payloads.
    console.error(
      JSON.stringify({
        event: "ai_transcription_failed",
        reason: timedOut ? "timeout" : "provider_error",
        name: e instanceof Error ? e.name : "unknown",
        status: (e as { status?: unknown }).status ?? null,
      }),
    );
    return timedOut ? error("transcription_timeout", 504) : error("transcription_failed", 502);
  }

  // Observability only — not an enforced spending allowance.
  const audioSeconds = Number(measured.seconds.toFixed(2));
  await recordUsage(ctx.orgId, "API_CALLS", 1, {
    kind: "ai_transcription",
    model: TRANSCRIPTION_MODEL,
    userId: ctx.userId,
    audioBytes: bytes.length,
    audioFormat: CONTAINER_MIME[container],
    audioSeconds,
    estimatedCostUsd: Number(((audioSeconds / 60) * TRANSCRIPTION_USD_PER_MINUTE).toFixed(6)),
    latencyMs: Date.now() - startedAt,
  });

  if (!text) return error("empty_transcript", 422);
  return NextResponse.json({ data: { text } });
}
