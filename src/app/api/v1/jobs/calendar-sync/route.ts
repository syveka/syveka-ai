import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const payloadSchema = z.object({ cursor: z.string().uuid().optional() });

/** Bounded per-invocation batch — keeps one invocation well under maxDuration. */
const BATCH_SIZE = 25;

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
 * Bounded, cursor-paginated: processes one page of BATCH_SIZE calendars ordered by a
 * stable id, then enqueues exactly one follow-up job with the next cursor if more rows
 * remain — never an unbounded loop inside a single invocation. Every calendar in the
 * current batch is attempted even if another one fails (ensureWebhookSubscription is
 * per-calendar and idempotent), and the next page is enqueued regardless of in-page
 * failures, so one persistently-failing calendar can never block the sweep from
 * reaching the rest. A batch with any failure responds with a 5xx so QStash's own
 * retry also gives the failed calendar(s) another, sooner attempt; retrying is always
 * safe because ensureWebhookSubscription() no-ops on an already-valid subscription.
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

  const parsed = payloadSchema.safeParse(rawBody.length > 0 ? JSON.parse(rawBody) : {});
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const calendars = await unscopedPrisma.externalCalendar.findMany({
    where: {
      syncEnabled: true,
      ...(parsed.data.cursor ? { id: { gt: parsed.data.cursor } } : {}),
    },
    select: { id: true },
    orderBy: { id: "asc" },
    take: BATCH_SIZE,
  });

  let reused = 0;
  let renewed = 0;
  let skipped = 0;
  let failed = 0;
  for (const calendar of calendars) {
    try {
      const outcome = await ensureWebhookSubscription(calendar.id);
      if (outcome === "reused") reused += 1;
      else if (outcome === "renewed") renewed += 1;
      else skipped += 1;
    } catch {
      // Never expose provider tokens or verification secrets in the response/logs —
      // just count the failure. This calendar's turn comes again on the next sweep
      // (or sooner, via QStash's retry of this same page, see the 5xx below).
      failed += 1;
    }
  }

  const nextCursor =
    calendars.length === BATCH_SIZE ? (calendars[calendars.length - 1]?.id ?? null) : null;
  if (nextCursor) {
    await enqueue("calendar-sync", { cursor: nextCursor });
  }

  const body = { processed: calendars.length, reused, renewed, skipped, failed, nextCursor };
  if (failed > 0) return NextResponse.json(body, { status: 500 });
  return NextResponse.json(body);
}
