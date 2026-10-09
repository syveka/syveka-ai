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

// The start time is part of the key: a moved event gets fresh reminders even when
// one for its previous time was already sent (see rescheduleEventReminders).
function reminderDedupeKey(eventId: string, offset: number, startsAt: Date): string {
  return `evt:${eventId}:${offset}:${startsAt.getTime()}`;
}

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
    const dedupeKey = reminderDedupeKey(params.eventId, offset, params.startsAt);
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
 * Moves an event's reminders to its new start time.
 *
 * Only events that were given reminders are rescheduled: imported (Google,
 * Outlook) and assistant-booked events never had any and must not start
 * emailing their attendees because they were moved.
 *
 * Pending reminders for the old time are canceled, so their already-enqueued
 * jobs find no SCHEDULED row and send nothing; canceled rows also keep the
 * event marked as one that has reminders. Then reminders for the new time are
 * scheduled (none whose send time has already passed). A canceled reminder
 * for exactly the new time (the event moved away and back) is removed first so
 * it doesn't block its replacement. Sent reminders stay as the delivery record.
 * `eventId` must already be verified inside `orgId`.
 */
export async function rescheduleEventReminders(params: {
  orgId: string;
  eventId: string;
  startsAt: Date;
}): Promise<number> {
  const scope = { eventId: params.eventId, organizationId: params.orgId };
  if ((await unscopedPrisma.reminder.count({ where: scope })) === 0) return 0;

  await unscopedPrisma.reminder.updateMany({
    where: { ...scope, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
  await unscopedPrisma.reminder.deleteMany({
    where: {
      ...scope,
      status: "CANCELED",
      dedupeKey: {
        in: REMINDER_OFFSETS_MINUTES.map((offset) =>
          reminderDedupeKey(params.eventId, offset, params.startsAt),
        ),
      },
    },
  });
  return scheduleEventReminders(params);
}

export async function cancelEventReminders(eventId: string): Promise<void> {
  await unscopedPrisma.reminder.updateMany({
    where: { eventId, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
}
