import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const payloadSchema = z
  .object({
    callCursor: z.string().guid().optional(),
    assistantCursor: z.string().guid().optional(),
    callsDone: z.boolean().optional(),
    assistantsDone: z.boolean().optional(),
    hop: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * Recovers voice calls whose webhooks were lost or late. Recurring maintenance job: like
 * reconcile-creator-generations, the code doesn't create its own trigger, so a QStash
 * schedule has to be registered (docs/release-runbook.md, a manual rollout step).
 *
 * One bounded page per delivery, continued with a cursor. It only reads from Vapi, and any
 * charge goes through the post-call job's own idempotency.
 *
 * A follow-up can resume from the cursor it was given, and QStash silently drops a repeated
 * deduplication id for 10 minutes, which would end the chain. The hop keeps each step's id new,
 * while a retry of one delivery that reaches the same result still publishes the same id.
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

  const { hop = 0, ...page } = parsed.data;
  const result = await reconcileVoiceCalls(page);
  console.info(JSON.stringify({ event: "voice_reconcile_finished", hop, ...result }));

  if (result.nextCallCursor || result.nextAssistantCursor) {
    try {
      await enqueue(
        "reconcile-voice-calls",
        {
          ...(result.nextCallCursor ? { callCursor: result.nextCallCursor } : { callsDone: true }),
          ...(result.nextAssistantCursor
            ? { assistantCursor: result.nextAssistantCursor }
            : { assistantsDone: true }),
          hop: hop + 1,
        },
        {
          deduplicationId: `reconcile-voice-calls-${hop + 1}-${result.nextCallCursor ?? "x"}-${result.nextAssistantCursor ?? "x"}`,
        },
      );
    } catch {
      return NextResponse.json({ error: "failed to publish follow-up job" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, ...result });
}
