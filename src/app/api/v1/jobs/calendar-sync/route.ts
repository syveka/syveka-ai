import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Bounded per-invocation batch — keeps one invocation well under maxDuration, and
 * bounds a retry-mode payload to at most this many ids. */
const BATCH_SIZE = 25;

const sweepPayloadSchema = z.object({ cursor: z.string().uuid().optional() }).strict();
const retryPayloadSchema = z
  .object({ calendarIds: z.array(z.string().uuid()).min(1).max(BATCH_SIZE) })
  .strict();
const payloadSchema = z.union([sweepPayloadSchema, retryPayloadSchema]);

/** Deterministic across replays of the same sweep page: same failed set → same id, so
 * QStash dedupes a re-publish instead of chaining a second retry job. */
function retryDeduplicationId(failedIds: string[]): string {
  const digest = createHash("sha256")
    .update([...failedIds].sort().join(","))
    .digest("hex");
  return `calendar-sync-retry-${digest}`;
}

async function processCalendars(
  ids: string[],
  ensureWebhookSubscription: (id: string) => Promise<"reused" | "renewed" | "skipped">,
): Promise<{ reused: number; renewed: number; skipped: number; failedIds: string[] }> {
  let reused = 0;
  let renewed = 0;
  let skipped = 0;
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      const outcome = await ensureWebhookSubscription(id);
      if (outcome === "reused") reused += 1;
      else if (outcome === "renewed") renewed += 1;
      else skipped += 1;
    } catch {
      // Never expose provider tokens or verification secrets in the response/logs —
      // just record which calendar needs a retry.
      failedIds.push(id);
    }
  }
  return { reused, renewed, skipped, failedIds };
}

/**
 * Recurring webhook-subscription maintenance sweep (P0.2 renewal lifecycle).
 *
 * Despite the shared "calendar-sync" job name, this route is intentionally narrow: it
 * only calls ensureWebhookSubscription() for syncEnabled external calendars. It never
 * runs a calendar event sync, never polls, and never touches CalendarEvent rows.
 * Nothing else in the system calls ensureWebhookSubscription() on a recurring basis —
 * the settings-page toggle-on action only calls it once, immediately, for the calendar
 * being enabled — so this sweep is what keeps every enabled calendar's webhook
 * subscription (and verification secret) renewed before its 12-hour freshness buffer
 * runs out. See docs/release-runbook.md for the required QStash recurring-schedule
 * registration: the code alone does not create that schedule.
 *
 * Two bounded payload modes:
 * - Sweep `{ cursor?: string }`: one page of BATCH_SIZE syncEnabled calendars, ordered
 *   by a stable id. Every calendar in the page is attempted regardless of others'
 *   outcomes. Failures are handed off to their own dedicated retry-mode job rather
 *   than making the whole sweep page retryable — a persistently-failing calendar can
 *   never block pagination, and QStash never has to re-run (and thus never
 *   re-enqueues) an already-completed page. Both follow-up publications (the failure
 *   retry and the next page) use deterministic deduplicationIds, so replaying this
 *   same sweep invocation — e.g. after a publish failure below — can never chain a
 *   duplicate pagination job.
 * - Retry `{ calendarIds: string[] }`: a bounded set of specific ids from a previous
 *   sweep's failures. No pagination, no "all enabled calendars" query — only these
 *   ids are processed, and ensureWebhookSubscription() remains the sole authority on
 *   whether a given calendar is actually enabled or should be skipped. If any
 *   supplied id still fails, this responds 500 so QStash retries this same
 *   already-published message; it never publishes a further retry job itself.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { unscopedPrisma }, { ensureWebhookSubscription }, { enqueue }] =
    await Promise.all([
      import("@/server/jobs/verify"),
      import("@/server/db/tenant"),
      import("@/server/services/calendar-sync"),
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

  if ("calendarIds" in parsed.data) {
    const { reused, renewed, skipped, failedIds } = await processCalendars(
      parsed.data.calendarIds,
      ensureWebhookSubscription,
    );
    const body = {
      processed: parsed.data.calendarIds.length,
      reused,
      renewed,
      skipped,
      failed: failedIds.length,
    };
    if (failedIds.length > 0) return NextResponse.json(body, { status: 500 });
    return NextResponse.json(body);
  }

  const calendars = await unscopedPrisma.externalCalendar.findMany({
    where: {
      syncEnabled: true,
      ...(parsed.data.cursor ? { id: { gt: parsed.data.cursor } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });

  const { reused, renewed, skipped, failedIds } = await processCalendars(
    calendars.map((calendar) => calendar.id),
    ensureWebhookSubscription,
  );

  const nextCursor =
    calendars.length === BATCH_SIZE ? (calendars[calendars.length - 1]?.id ?? null) : null;

  try {
    if (failedIds.length > 0) {
      await enqueue(
        "calendar-sync",
        { calendarIds: failedIds },
        { deduplicationId: retryDeduplicationId(failedIds) },
      );
    }
    if (nextCursor) {
      await enqueue(
        "calendar-sync",
        { cursor: nextCursor },
        { deduplicationId: `calendar-sync-page-${nextCursor}` },
      );
    }
  } catch {
    return NextResponse.json({ error: "failed to publish follow-up job" }, { status: 500 });
  }

  // Both required publications succeeded (or weren't needed), so this page is done —
  // 200 even when some calendars failed, since those failures now have their own
  // retry job rather than depending on QStash re-running this whole page.
  return NextResponse.json({
    processed: calendars.length,
    reused,
    renewed,
    skipped,
    failed: failedIds.length,
    nextCursor,
  });
}
