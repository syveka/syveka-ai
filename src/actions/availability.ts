"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { actionWriteLimitError } from "@/server/security/rate-limit";
import { AvailabilityError, deleteSchedule, saveSchedule } from "@/server/services/availability";
import { availabilityScheduleSchema } from "@/lib/validators/booking";

export type AvailabilityActionState = { error?: string; message?: string };

export async function saveScheduleAction(
  scheduleId: string | undefined,
  _prev: AvailabilityActionState,
  formData: FormData,
): Promise<AvailabilityActionState> {
  const ctx = await requirePermission("booking:manage");
  const limited = await actionWriteLimitError("booking", ctx);
  if (limited) return { error: limited };
  const parsed = availabilityScheduleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await saveSchedule(ctx, parsed.data, scheduleId);
  } catch (e) {
    if (e instanceof AvailabilityError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/calendar/availability");
  return { message: "saved" };
}

export async function deleteScheduleAction(scheduleId: string): Promise<AvailabilityActionState> {
  const ctx = await requirePermission("booking:manage");
  const limited = await actionWriteLimitError("booking", ctx);
  if (limited) return { error: limited };
  try {
    await deleteSchedule(ctx, scheduleId);
  } catch (e) {
    if (e instanceof AvailabilityError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/calendar/availability");
  return { message: "deleted" };
}
