export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getPublicBookingType } from "@/server/services/booking";
import { BookingWidget } from "@/components/calendar/booking-widget";

export default async function PublicBookingPage({
  params,
}: {
  params: Promise<{ org: string; slug: string; locale: string }>;
}) {
  const { org, slug, locale } = await params;
  const t = await getTranslations("booking");
  const bookingType = await getPublicBookingType(org, slug);
  if (!bookingType) notFound();

  return (
    <div className="space-y-6">
      <div className="text-center">
        {bookingType.organization.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bookingType.organization.logoUrl}
            alt={bookingType.organization.name}
            className="mx-auto mb-3 h-10 w-auto"
          />
        ) : null}
        <p className="text-sm text-muted-foreground">{bookingType.organization.name}</p>
        <h1
          className="text-2xl font-semibold"
          style={bookingType.brandColor ? { color: bookingType.brandColor } : undefined}
        >
          {bookingType.name}
        </h1>
        {bookingType.description ? (
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            {bookingType.description}
          </p>
        ) : null}
        <p className="mt-1 text-sm text-muted-foreground">
          {t("durationLabel", { minutes: bookingType.durationMinutes })}
        </p>
      </div>

      <BookingWidget
        orgSlug={org}
        typeSlug={slug}
        locale={locale}
        durationMinutes={bookingType.durationMinutes}
        durationOptions={bookingType.durationOptions}
        collectPhone={bookingType.collectPhone}
        collectCompany={bookingType.collectCompany}
        requiresConsent={bookingType.requiresConsent}
        brandColor={bookingType.brandColor}
      />
    </div>
  );
}
