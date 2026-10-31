import { getTranslations } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { PublicLanguageSwitcher } from "@/components/calendar/public-language-switcher";

/**
 * Shown, with HTTP 404, whenever a booking link can't be booked: the page is
 * paused, deleted or misspelled, its organization is gone, or its owner left.
 * It is the same page for every case and names nothing from the link, so it
 * never confirms that a paused page (or its organization) exists. See
 * getPublicBookingType, which returns null for all of these alike.
 */
export default async function BookingPageUnavailable() {
  const t = await getTranslations("booking.unavailable");

  return (
    <div className="space-y-6">
      <PublicLanguageSwitcher />
      <Card>
        <CardContent className="space-y-2 pt-6 text-center">
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          <p className="text-sm text-muted-foreground">{t("contactHint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
