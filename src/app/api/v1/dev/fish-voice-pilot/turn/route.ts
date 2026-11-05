import { NextResponse } from "next/server";
import { pilotTurnSchema, type PilotEvent } from "@/lib/voice/fish-pilot-scenarios";
import { isCrossOrigin } from "@/server/security/same-origin";
import { isFishVoicePilotEnabled } from "@/server/voice/fish-pilot/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const REFUSAL_STATUS: Record<string, number> = {
  duplicate_turn: 409,
  session_limit: 429,
  turn_limit: 429,
};

/**
 * One turn of the development-only Fish Audio pilot, as newline-delimited JSON: the
 * reply and its tool results, then audio chunks, then timings. It touches no real CRM,
 * calendar or phone call, and the API key stays on the server.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isFishVoicePilotEnabled()) return new NextResponse(null, { status: 404 });

  const [
    { selectSpeechProvider, hasRealTurnBudget, reserveRealTurn, FishPilotConfigError },
    { requirePermission },
    { AuthError },
    { rateLimitRefusal },
    { runPilotTurn },
    { guardSpeechStream, SpeechError },
    { recordPilotTurnUsage, turnUsage },
  ] = await Promise.all([
    import("@/server/voice/fish-pilot/config"),
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/security/rate-limit"),
    import("@/server/voice/fish-pilot/conversation"),
    import("@/server/voice/fish-pilot/speech-provider"),
    import("@/server/voice/fish-pilot/usage"),
  ]);

  if (isCrossOrigin(request)) {
    return NextResponse.json({ error: { code: "cross_origin_request" } }, { status: 403 });
  }

  let ctx;
  try {
    ctx = await requirePermission("voice:configure");
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: error.status });
    }
    throw error;
  }
  // The live-voice limiter, not the generic one: a turn can be a paid provider call.
  const refused = await rateLimitRefusal("aiVoiceTurnUser", `${ctx.orgId}:${ctx.userId}`);
  if (refused) return refused;

  const parsed = pilotTurnSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
  }

  let provider;
  try {
    provider = selectSpeechProvider(parsed.data.mockFailure);
  } catch (error) {
    if (error instanceof FishPilotConfigError) {
      return NextResponse.json({ error: { code: "fish_pilot_not_configured" } }, { status: 503 });
    }
    throw error;
  }
  if (!provider.syntheticTiming && parsed.data.mockFailure !== "none") {
    // A failure test must not quietly become a real, successful paid call.
    return NextResponse.json({ error: { code: "mock_failure_needs_mock" } }, { status: 400 });
  }

  // Before the turn takes effect, so a refusal here leaves its turn id unused for a retry.
  if (!provider.syntheticTiming && !hasRealTurnBudget()) {
    return NextResponse.json({ error: { code: "real_turn_budget_used" } }, { status: 429 });
  }

  const turn = runPilotTurn({ orgId: ctx.orgId, userId: ctx.userId }, parsed.data);
  if (!turn.ok) {
    return NextResponse.json(
      { error: { code: turn.code } },
      { status: REFUSAL_STATUS[turn.code] ?? 400 },
    );
  }
  if (!provider.syntheticTiming) reserveRealTurn();

  const abort = new AbortController();
  if (request.signal.aborted) abort.abort();
  else request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    async start(stream) {
      const send = (event: PilotEvent) => {
        if (!cancelled) stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const startedAt = performance.now();
      let firstAudioMs: number | null = null;
      let audioBytes = 0;
      let seq = 0;
      let completed = false;
      const usageSoFar = () =>
        turnUsage({
          text: turn.reply,
          audioBytes,
          sampleRate: provider.sampleRate,
          usdPerMillionBytes: provider.usdPerMillionBytes,
        });
      send({ type: "reply", caller: turn.caller, text: turn.reply, toolResults: turn.toolResults });
      try {
        for await (const chunk of guardSpeechStream(
          provider,
          { text: turn.reply, language: parsed.data.language },
          abort.signal,
        )) {
          firstAudioMs ??= Math.round(performance.now() - startedAt);
          audioBytes += chunk.length;
          send({
            type: "audio",
            seq: seq++,
            data: Buffer.from(chunk).toString("base64"),
            sampleRate: provider.sampleRate,
          });
        }
        completed = true;
        send({
          type: "done",
          provider: provider.name,
          firstAudioMs,
          totalMs: Math.round(performance.now() - startedAt),
          audioBytes,
          syntheticTiming: provider.syntheticTiming,
          usage: usageSoFar(),
        });
      } catch (error) {
        const code = error instanceof SpeechError ? error.code : "provider_failed";
        // Ids and the code only: never the reply text or anything from the provider.
        console.warn(JSON.stringify({ event: "fish_pilot_speech_failed", orgId: ctx.orgId, code }));
        send({ type: "error", code });
      } finally {
        // In finally: a failed or interrupted real turn may still have been billed.
        recordPilotTurnUsage(ctx.orgId, {
          usage: usageSoFar(),
          completed,
          syntheticTiming: provider.syntheticTiming,
          firstAudioMs,
          totalMs: Math.round(performance.now() - startedAt),
        });
        if (!cancelled) stream.close();
      }
    },
    cancel() {
      cancelled = true;
      abort.abort();
    },
  });

  return new Response(body, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" },
  });
}

/** The caller's organization's pilot usage: the organization comes only from the session. */
export async function GET(request: Request): Promise<Response> {
  if (!isFishVoicePilotEnabled()) return new NextResponse(null, { status: 404 });

  const [{ requirePermission }, { AuthError }, { rateLimitRefusal }, { getPilotUsage }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/auth/session"),
      import("@/server/security/rate-limit"),
      import("@/server/voice/fish-pilot/usage"),
    ]);

  if (isCrossOrigin(request)) {
    return NextResponse.json({ error: { code: "cross_origin_request" } }, { status: 403 });
  }

  let ctx;
  try {
    ctx = await requirePermission("voice:configure");
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: error.status });
    }
    throw error;
  }
  const refused = await rateLimitRefusal("aiVoiceTurnUser", `${ctx.orgId}:${ctx.userId}`);
  if (refused) return refused;
  return NextResponse.json(getPilotUsage(ctx.orgId), { headers: { "Cache-Control": "no-store" } });
}
