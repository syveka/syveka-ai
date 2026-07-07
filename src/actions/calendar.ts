"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { createEvent, updateEvent, deleteEvent } from "@/server/services/calendar";
import { eventSchema } from "@/lib/validators/calendar";

export type CalendarActionState = { error?: string; message?: string };

export async function saveEventAction(
  eventId: string | undefined,
  _prev: CalendarActionState,
  formData: FormData,
): Promise<CalendarActionState> {
  const ctx = await requirePermission("calendar:write");
  const parsed = eventSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  if (eventId) await updateEvent(ctx, eventId, parsed.data);
  else await createEvent(ctx, parsed.data);

  revalidatePath("/calendar");
  return { message: "saved" };
}

export async function deleteEventAction(eventId: string): Promise<void> {
  const ctx = await requirePermission("calendar:write");
  await deleteEvent(ctx, eventId);
  revalidatePath("/calendar");
}
