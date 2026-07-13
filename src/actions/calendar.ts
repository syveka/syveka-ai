"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import {
  CalendarError,
  cancelEvent,
  createEvent,
  deleteEvent,
  findConflicts,
  updateEvent,
} from "@/server/services/calendar";
import { assistScheduling, generateMeetingSummary } from "@/server/services/booking-assistant";
import { scheduleEventReminders } from "@/server/services/reminders";
import { eventSchema } from "@/lib/validators/calendar";

export type CalendarActionState = {
  error?: string;
  message?: string;
  conflicts?: Array<{ id: string; title: string; startsAt: string }>;
};

function toErrorState(e: unknown): CalendarActionState {
  if (e instanceof CalendarError) return { error: e.code };
  return { error: "failed" };
}

export async function saveEventAction(
  eventId: string | undefined,
  _prev: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const ctx = await requirePermission("calendar:write");
  const parsed = eventSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  // Conflict prevention: block unless the user explicitly overrides.
  const allowConflict = formData.get("allowConflict") === "true";
  if (!allowConflict) {
    const conflicts = await findConflicts(ctx, {
      startsAt: new Date(parsed.data.startsAt),
      endsAt: new Date(parsed.data.endsAt),
      ownerId: parsed.data.ownerId ?? null,
      excludeEventId: eventId,
    });
    if (conflicts.length > 0) {
      return {
        error: "conflict",
        conflicts: conflicts.slice(0, 3).map((c) => ({
          id: c.id,
          title: c.title,
          startsAt: c.startsAt.toISOString(),
        })),
      };
    }
  }

  try {
    if (eventId) {
      await updateEvent(ctx, eventId, parsed.data);
    } else {
      const event = await createEvent(ctx, parsed.data);
      await scheduleEventReminders({
        orgId: ctx.orgId,
        eventId: event.id,
        startsAt: event.startsAt,
      }).catch(() => undefined);
    }
  } catch (e) {
    return toErrorState(e);
  }

  revalidatePath("/calendar");
  return { message: "saved" };
}

export async function cancelEventAction(eventId: string): Promise<CalendarActionState> {
  const ctx = await requirePermission("calendar:write");
  try {
    await cancelEvent(ctx, eventId);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath("/calendar");
  return { message: "canceled" };
}

export async function deleteEventAction(eventId: string): Promise<CalendarActionState> {
  const ctx = await requirePermission("calendar:delete");
  try {
    await deleteEvent(ctx, eventId);
  } catch (e) {
    return toErrorState(e);
  }
  revalidatePath("/calendar");
  return { message: "deleted" };
}

export type AssistantActionState = {
  error?: string;
  reply?: string;
  slots?: Array<{ startsAt: string; endsAt: string }>;
  timezone?: string;
};

export async function schedulingAssistantAction(
  _prev: AssistantActionState,
  formData: FormData,
): Promise<AssistantActionState> {
  const ctx = await requirePermission("calendar:write");
  const request = String(formData.get("request") ?? "").slice(0, 500);
  if (request.length < 3) return { error: "invalid_input" };
  const contactId = String(formData.get("contactId") ?? "") || undefined;
  const dealId = String(formData.get("dealId") ?? "") || undefined;

  const result = await assistScheduling(ctx, request, { contactId, dealId });
  return {
    reply: result.reply,
    slots: result.suggestedSlots,
    timezone: result.timezone,
  };
}

export async function meetingSummaryAction(
  eventId: string,
): Promise<{ summary: string; followUps: string[] }> {
  const ctx = await requirePermission("calendar:read");
  const result = await generateMeetingSummary(ctx, eventId);
  return { summary: result.summary, followUps: result.followUps };
}
