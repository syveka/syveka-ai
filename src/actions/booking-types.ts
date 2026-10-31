"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { actionWriteLimitError } from "@/server/security/rate-limit";
import { BookingError, deleteBookingType, saveBookingType } from "@/server/services/booking";
import { bookingTypeSchema } from "@/lib/validators/booking";

export type BookingTypeActionState = { error?: string; message?: string };

export async function saveBookingTypeAction(
  bookingTypeId: string | undefined,
  _prev: BookingTypeActionState,
  formData: FormData,
): Promise<BookingTypeActionState> {
  const ctx = await requirePermission("booking:manage");
  const limited = await actionWriteLimitError("booking", ctx);
  if (limited) return { error: limited };
  // An unticked checkbox submits nothing, and the schema's defaults (true)
  // would then silently re-activate the type and its consent requirement.
  const parsed = bookingTypeSchema.safeParse({
    ...Object.fromEntries(formData),
    isActive: formData.get("isActive") === "true",
    requiresConsent: formData.get("requiresConsent") === "true",
  });
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await saveBookingType(ctx, parsed.data, bookingTypeId);
  } catch (e) {
    if (e instanceof BookingError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/calendar/booking-types");
  return { message: "saved" };
}

export async function deleteBookingTypeAction(
  bookingTypeId: string,
): Promise<BookingTypeActionState> {
  const ctx = await requirePermission("booking:manage");
  const limited = await actionWriteLimitError("booking", ctx);
  if (limited) return { error: limited };
  try {
    await deleteBookingType(ctx, bookingTypeId);
  } catch (e) {
    if (e instanceof BookingError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/calendar/booking-types");
  return { message: "deleted" };
}
