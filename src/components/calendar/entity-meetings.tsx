import { getTranslations, getLocale } from "next-intl/server";
import { CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getEntityEvents } from "@/server/services/calendar";
import { Link } from "@/i18n/routing";
import type { TenantContext } from "@/server/auth/session";

/**
 * Server component: meeting timeline for a CRM entity page
 * (contact / company / deal). Rendered only for calendar:read holders.
 */
export async function EntityMeetings({
  ctx,
  contactId,
  companyId,
  dealId,
}: {
  ctx: TenantContext;
  contactId?: string;
  companyId?: string;
  dealId?: string;
}) {
  const t = await getTranslations("calendar");
  const locale = await getLocale();
  const { upcoming, past } = await getEntityEvents(ctx, { contactId, companyId, dealId }, 5);

  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  const renderRow = (e: (typeof upcoming)[number]) => (
    <li key={`${e.id}-${e.startsAt.toISOString()}`} className="flex items-start gap-2 py-1.5">
      <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {e.title}
          {e.status === "CANCELED" ? (
            <span className="ms-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {t("statusCanceled")}
            </span>
          ) : null}
        </p>
        <p className="text-xs text-muted-foreground">{fmt.format(e.startsAt)}</p>
      </div>
    </li>
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t("meetings")}</CardTitle>
        <Link href="/calendar" className="text-sm text-primary hover:underline">
          {t("openCalendar")}
        </Link>
      </CardHeader>
      <CardContent>
        {upcoming.length === 0 && past.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noMeetings")}</p>
        ) : (
          <div className="space-y-3">
            {upcoming.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {t("upcoming")}
                </p>
                <ul className="divide-y">{upcoming.map(renderRow)}</ul>
              </div>
            ) : null}
            {past.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">{t("past")}</p>
                <ul className="divide-y">{past.map(renderRow)}</ul>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
