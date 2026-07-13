export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { listSchedules } from "@/server/services/availability";
import { AvailabilityEditor } from "@/components/calendar/availability-editor";
import { Link } from "@/i18n/routing";

export default async function AvailabilityPage() {
  const ctx = await requirePermission("booking:manage");
  const t = await getTranslations("calendar");
  const schedules = await listSchedules(ctx, ctx.userId);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/calendar" className="text-sm text-muted-foreground hover:underline">
          ← {t("title")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{t("availability.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("availability.subtitle")}</p>
      </div>
      <AvailabilityEditor
        schedules={schedules.map((s) => ({
          id: s.id,
          name: s.name,
          timezone: s.timezone,
          isDefault: s.isDefault,
          rules: s.rules.map((r) => ({
            weekday: r.weekday,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          })),
          overrides: s.overrides.map((o) => ({
            date: o.date.toISOString().slice(0, 10),
            startMinute: o.startMinute,
            endMinute: o.endMinute,
            isUnavailable: o.isUnavailable,
          })),
        }))}
      />
    </div>
  );
}
