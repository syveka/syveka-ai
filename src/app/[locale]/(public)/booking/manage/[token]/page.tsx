export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { getBookingByToken } from "@/server/services/booking";
import { BookingTokenError } from "@/server/services/booking-tokens";
import { unscopedPrisma } from "@/server/db/tenant";
import { ManageBooking } from "@/components/calendar/manage-booking";
import { Card, CardContent } from "@/components/ui/card";

export default async function ManageBookingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("booking");

  let booking: Awaited<ReturnType<typeof getBookingByToken>> | null = null;
  let tokenError: string | null = null;
  try {
    booking = await getBookingByToken(token);
  } catch (e) {
    tokenError = e instanceof BookingTokenError ? e.code : "invalid";
  }

  if (!booking) {
    return (
      <Card>
        <CardContent className="pt-6 text-center">
          <h1 className="text-xl font-semibold">{t("manage.invalidTitle")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tokenError === "expired" ? t("manage.expired") : t("manage.invalid")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const org = await unscopedPrisma.organization.findUnique({
    where: { id: booking.organizationId },
    select: { slug: true },
  });

  return (
    <ManageBooking
      token={token}
      bookingTypeName={booking.bookingType.name}
      typeSlug={booking.bookingType.slug}
      orgSlug={org?.slug ?? ""}
      status={booking.status}
      startsAt={booking.startsAt.toISOString()}
      guestTimezone={booking.guestTimezone}
    />
  );
}
