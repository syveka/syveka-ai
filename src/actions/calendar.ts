"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { actionWriteLimitError } from "@/server/security/rate-limit";
import { checkRateLimit } from "@/server/integrations/redis";
import {
  addedAttendeeEmails,
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
import { AiSpendError, assertAiSpendAllowed, recordAiSpend } from "@/server/services/ai-spend";

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
  const limited = await actionWriteLimitError("calendar", ctx);
  if (limited) return { error: limited };
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

  // Reminders email every attendee address from the platform's domain, so
  // the addresses a save adds spend an hourly and a daily budget per
  // organization. Refused before anything is saved, so the form never says
  // reminders will go out when they won't.
  const added = await addedAttendeeEmails(ctx, eventId, parsed.data.attendees);
  if (added.length > 0) {
    for (const limiter of ["eventReminderRecipientsHour", "eventReminderRecipientsDay"] as const) {
      const decision = await checkRateLimit(limiter, ctx.orgId, added.length);
      if (!decision.ok) {
        return {
          error: decision.reason === "unavailable" ? "service_unavailable" : "rate_limited",
        };
      }
    }
  }

  try {
    if (eventId) {
      // An explicit "Does not repeat" submits "" and clears the rule; a form
      // without the field (e.g. a disabled control) keeps it.
      await updateEvent(ctx, eventId, parsed.data, {
        keepRecurrenceRule: !formData.has("recurrenceRule"),
      });
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
  const limited = await actionWriteLimitError("calendar", ctx);
  if (limited) return { error: limited };
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
  const limited = await actionWriteLimitError("calendar", ctx);
  if (limited) return { error: limited };
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

  try {
    await assertAiSpendAllowed(ctx);
  } catch (e) {
    if (e instanceof AiSpendError) return { error: e.code };
    throw e;
  }
  const result = await assistScheduling(ctx, request, { contactId, dealId });
  // Fallback answers (no slots, provider unavailable) made no AI call.
  if (result.aiUsed) await recordAiSpend(ctx, "scheduling_assistant");
  return {
    reply: result.reply,
    slots: result.suggestedSlots,
    timezone: result.timezone,
  };
}

export async function meetingSummaryAction(
  eventId: string,
): Promise<{ summary: string; followUps: string[] }> {
  // A paid AI call counted against the organization's monthly AI quota: it
  // needs the AI permission too, so a read-only VIEWER (calendar:read, no
  // chat:use) can't spend the quota for everyone.
  await requirePermission("chat:use");
  const ctx = await requirePermission("calendar:read");
  await assertAiSpendAllowed(ctx);
  const result = await generateMeetingSummary(ctx, eventId);
  if (result.aiUsed) await recordAiSpend(ctx, "meeting_summary");
  return { summary: result.summary, followUps: result.followUps };
}
