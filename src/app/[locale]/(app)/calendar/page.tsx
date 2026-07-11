export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listEvents } from "@/server/services/calendar";
import { CalendarView } from "@/components/calendar/calendar-view";

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const ctx = await requirePermission("calendar:read");
  const t = await getTranslations("calendar");
  const { month } = await searchParams;

  const anchor = month ? new Date(`${month}-01T00:00:00Z`) : new Date();
  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), -7));
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 8));

  const events = await listEvents(ctx, { from, to });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <CalendarView
        canWrite={can(ctx.role, "calendar:write")}
        year={anchor.getUTCFullYear()}
        month={anchor.getUTCMonth()}
        events={events.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          allDay: e.allDay,
          source: e.source,
        }))}
      />
    </div>
  );
}
