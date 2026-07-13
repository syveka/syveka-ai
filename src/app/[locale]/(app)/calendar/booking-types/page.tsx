export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { listBookingTypes } from "@/server/services/booking";
import { listSchedules } from "@/server/services/availability";
import { tenantDb } from "@/server/db/tenant";
import { clientEnv } from "@/env";
import { BookingTypesManager } from "@/components/calendar/booking-types-manager";
import { Link } from "@/i18n/routing";

export default async function BookingTypesPage() {
  const ctx = await requirePermission("booking:manage");
  const t = await getTranslations("calendar");
  const db = tenantDb(ctx.orgId);

  const [types, schedules, org] = await Promise.all([
    listBookingTypes(ctx),
    listSchedules(ctx, ctx.userId),
    db.organization.findFirst({ where: { id: ctx.orgId }, select: { slug: true } }),
  ]);

  return (
    <div className="space-y-4">
      <div>
        <Link href="/calendar" className="text-sm text-muted-foreground hover:underline">
          ← {t("title")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{t("bookingTypes.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("bookingTypes.subtitle")}</p>
      </div>
      <BookingTypesManager
        baseUrl={`${clientEnv.NEXT_PUBLIC_APP_URL}/book/${org?.slug ?? ""}`}
        schedules={schedules.map((s) => ({ id: s.id, name: s.name }))}
        types={types.map((bt) => ({
          id: bt.id,
          slug: bt.slug,
          name: bt.name,
          description: bt.description,
          durationMinutes: bt.durationMinutes,
          durationOptions: bt.durationOptions,
          locationType: bt.locationType,
          location: bt.location,
          bufferBeforeMinutes: bt.bufferBeforeMinutes,
          bufferAfterMinutes: bt.bufferAfterMinutes,
          minNoticeMinutes: bt.minNoticeMinutes,
          maxWindowDays: bt.maxWindowDays,
          brandColor: bt.brandColor,
          confirmationMessage: bt.confirmationMessage,
          collectPhone: bt.collectPhone,
          collectCompany: bt.collectCompany,
          requiresConsent: bt.requiresConsent,
          isActive: bt.isActive,
          scheduleId: bt.scheduleId,
        }))}
      />
    </div>
  );
}
