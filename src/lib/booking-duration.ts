/**
 * The length a rescheduled meeting gets: its own while the type still offers
 * it, otherwise the type's default. The guest's slot list and the server's
 * reschedule both use this, so they always agree on one length.
 */
export function rescheduleDurationMinutes(
  bookingType: { durationOptions: number[]; durationMinutes: number },
  startsAt: Date,
  endsAt: Date,
): number {
  const previous = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000);
  return bookingType.durationOptions.includes(previous) ? previous : bookingType.durationMinutes;
}
