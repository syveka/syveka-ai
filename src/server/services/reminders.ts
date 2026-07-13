import "server-only";

import { unscopedPrisma } from "@/server/db/tenant";
import { enqueue } from "@/server/jobs/queue";

/**
 * Reminder scheduling. Each reminder is a Reminder row (source of truth,
 * idempotent via unique dedupeKey) plus a delayed QStash job. The job route
 * re-reads the row before sending, so canceled/rescheduled meetings never
 * fire, and QStash retries can't double-send (status flips to SENT first).
 */

export const REMINDER_OFFSETS_MINUTES = [24 * 60, 60] as const;

export async function scheduleEventReminders(params: {
  orgId: string;
  eventId: string;
  startsAt: Date;
}): Promise<number> {
  const now = Date.now();
  let scheduled = 0;
  for (const offset of REMINDER_OFFSETS_MINUTES) {
    const sendAt = new Date(params.startsAt.getTime() - offset * 60_000);
    if (sendAt.getTime() <= now) continue;
    const dedupeKey = `evt:${params.eventId}:${offset}`;
    try {
      const reminder = await unscopedPrisma.reminder.create({
        data: {
          organizationId: params.orgId,
          eventId: params.eventId,
          sendAt,
          dedupeKey,
        },
      });
      await enqueue(
        "send-reminder",
        { reminderId: reminder.id },
        { delaySeconds: Math.floor((sendAt.getTime() - now) / 1000) },
      );
      scheduled += 1;
    } catch {
      // Unique dedupeKey violation → already scheduled; skip silently.
    }
  }
  return scheduled;
}

export async function cancelEventReminders(eventId: string): Promise<void> {
  await unscopedPrisma.reminder.updateMany({
    where: { eventId, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
}
