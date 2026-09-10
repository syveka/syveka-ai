import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const payloadSchema = z
  .object({
    generatingCursor: z.string().uuid().optional(),
    settlementCursor: z.string().uuid().optional(),
  })
  .strict();

/**
 * P0 crash-recovery reconciliation sweep (docs/creator-studio.md §19).
 * Recurring maintenance job — like calendar-sync, the code alone does not
 * create its own trigger; see docs/release-runbook.md for the required
 * QStash recurring-schedule registration.
 *
 * One bounded page per invocation (reconcileCreatorGenerations's own
 * BATCH_SIZE) across both the stale-GENERATING scan and the
 * COMPLETED/FAILED-with-stuck-credits scan; self-repaginates via enqueue()
 * with a cursor when either scan filled its page, exactly like
 * calendar-sync's sweep mode. Never submits a new provider job — every
 * state transition goes through the same claim/commit/release functions a
 * live request uses.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { reconcileCreatorGenerations }, { enqueue }] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/services/creator-generation-recovery"),
    import("@/server/jobs/queue"),
  ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  let payloadJson: unknown;
  try {
    payloadJson = rawBody.length > 0 ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }
  const parsed = payloadSchema.safeParse(payloadJson);
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const result = await reconcileCreatorGenerations({
    generatingCursor: parsed.data.generatingCursor,
    settlementCursor: parsed.data.settlementCursor,
  });

  try {
    if (result.nextGeneratingCursor || result.nextSettlementCursor) {
      await enqueue(
        "reconcile-creator-generations",
        {
          ...(result.nextGeneratingCursor ? { generatingCursor: result.nextGeneratingCursor } : {}),
          ...(result.nextSettlementCursor ? { settlementCursor: result.nextSettlementCursor } : {}),
        },
        {
          deduplicationId: `reconcile-creator-generations-${result.nextGeneratingCursor ?? "x"}-${result.nextSettlementCursor ?? "x"}`,
        },
      );
    }
  } catch {
    return NextResponse.json({ error: "failed to publish follow-up job" }, { status: 500 });
  }

  return NextResponse.json(result);
}
