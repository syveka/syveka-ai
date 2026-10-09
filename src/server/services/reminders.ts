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
    // The start time is part of the key: a moved event gets fresh reminders even when
    // one for its previous time was already sent (see rescheduleEventReminders).
    const dedupeKey = `evt:${params.eventId}:${offset}:${params.startsAt.getTime()}`;
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

/**
 * Moves an event's reminders to its new start time. Pending reminders for the
 * old time are removed, so their already-enqueued jobs find no SCHEDULED row
 * and send nothing; then reminders for the new time are scheduled (none whose
 * send time has already passed). Sent reminders stay as the delivery record.
 * `eventId` must already be verified inside `orgId`.
 */
export async function rescheduleEventReminders(params: {
  orgId: string;
  eventId: string;
  startsAt: Date;
}): Promise<number> {
  await unscopedPrisma.reminder.deleteMany({
    where: { eventId: params.eventId, organizationId: params.orgId, status: "SCHEDULED" },
  });
  return scheduleEventReminders(params);
}

export async function cancelEventReminders(eventId: string): Promise<void> {
  await unscopedPrisma.reminder.updateMany({
    where: { eventId, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
}
