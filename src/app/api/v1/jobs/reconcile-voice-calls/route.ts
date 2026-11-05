import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const payloadSchema = z
  .object({
    callCursor: z.string().guid().optional(),
    assistantCursor: z.string().guid().optional(),
  })
  .strict();

/**
 * Recovers voice calls whose webhooks were lost or late. Recurring maintenance job: like
 * reconcile-creator-generations, the code doesn't create its own trigger, so a QStash
 * schedule has to be registered (docs/voice/implementation-plan.md, a manual rollout step).
 *
 * One bounded page per delivery, continued with a cursor. It only reads from Vapi, and any
 * charge goes through the post-call job's own idempotency.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { jobPayloadJson }, { reconcileVoiceCalls }, { enqueue }, env] =
    await Promise.all([
      import("@/server/jobs/verify"),
      import("@/server/jobs/payload"),
      import("@/server/voice/reconcile-calls"),
      import("@/server/jobs/queue"),
      import("@/env"),
    ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(rawBody.length > 0 ? jobPayloadJson(rawBody) : {});
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  try {
    env.getVapiEnv();
  } catch {
    // Voice isn't set up on this deployment: nothing to reconcile, and retrying won't help.
    return NextResponse.json({ skipped: "vapi_not_configured" });
  }

  const result = await reconcileVoiceCalls(parsed.data);
  console.info(JSON.stringify({ event: "voice_reconcile_finished", ...result }));

  if (result.nextCallCursor || result.nextAssistantCursor) {
    try {
      await enqueue(
        "reconcile-voice-calls",
        {
          ...(result.nextCallCursor ? { callCursor: result.nextCallCursor } : {}),
          ...(result.nextAssistantCursor ? { assistantCursor: result.nextAssistantCursor } : {}),
        },
        {
          deduplicationId: `reconcile-voice-calls-${result.nextCallCursor ?? "x"}-${result.nextAssistantCursor ?? "x"}`,
        },
      );
    } catch {
      return NextResponse.json({ error: "failed to publish follow-up job" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, ...result });
}
