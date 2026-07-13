"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { BookingError, deleteBookingType, saveBookingType } from "@/server/services/booking";
import { bookingTypeSchema } from "@/lib/validators/booking";

export type BookingTypeActionState = { error?: string; message?: string };

export async function saveBookingTypeAction(
  bookingTypeId: string | undefined,
  _prev: BookingTypeActionState,
  formData: FormData,
): Promise<BookingTypeActionState> {
  const ctx = await requirePermission("booking:manage");
  const parsed = bookingTypeSchema.safeParse(Object.fromEntries(formData));
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
  try {
    await deleteBookingType(ctx, bookingTypeId);
  } catch (e) {
    if (e instanceof BookingError) return { error: e.code };
    return { error: "failed" };
  }
  revalidatePath("/calendar/booking-types");
  return { message: "deleted" };
}
