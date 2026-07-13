export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listEvents, listCalendarOwnerOptions } from "@/server/services/calendar";
import { tenantDb } from "@/server/db/tenant";
import { eventFiltersSchema } from "@/lib/validators/calendar";
import { CalendarView } from "@/components/calendar/calendar-view";
import { Link } from "@/i18n/routing";

function rangeFor(view: string, anchorIso: string): { from: Date; to: Date } {
  const anchor = new Date(`${anchorIso}T00:00:00Z`);
  if (view === "day") {
    return { from: anchor, to: new Date(anchor.getTime() + 86_400_000) };
  }
  if (view === "week") {
    const offset = (anchor.getUTCDay() + 6) % 7; // Monday first
    const from = new Date(anchor.getTime() - offset * 86_400_000);
    return { from, to: new Date(from.getTime() + 7 * 86_400_000) };
  }
  if (view === "agenda") {
    return { from: anchor, to: new Date(anchor.getTime() + 30 * 86_400_000) };
  }
  // month: pad a week on both sides for the grid
  const from = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), -7));
  const to = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 8));
  return { from, to };
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requirePermission("calendar:read");
  const t = await getTranslations("calendar");
  const sp = await searchParams;

  const parsed = eventFiltersSchema.safeParse(sp);
  const filters = parsed.success ? parsed.data : eventFiltersSchema.parse({});
  const anchorIso = filters.date ?? new Date().toISOString().slice(0, 10);
  const range = rangeFor(filters.view, anchorIso);

  const canWrite = can(ctx.role, "calendar:write");
  const db = tenantDb(ctx.orgId);

  const [events, owners, contacts, companies, deals] = await Promise.all([
    listEvents(ctx, range, filters),
    canWrite ? listCalendarOwnerOptions(ctx) : Promise.resolve([]),
    canWrite
      ? db.contact.findMany({
          where: { deletedAt: null },
          select: { id: true, firstName: true, lastName: true },
          orderBy: { firstName: "asc" },
          take: 300,
        })
      : Promise.resolve([]),
    canWrite
      ? db.company.findMany({
          where: { deletedAt: null },
          select: { id: true, name: true },
          orderBy: { name: "asc" },
          take: 300,
        })
      : Promise.resolve([]),
    canWrite
      ? db.deal.findMany({
          where: { deletedAt: null, closedAt: null },
          select: { id: true, title: true },
          orderBy: { updatedAt: "desc" },
          take: 300,
        })
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex items-center gap-3 text-sm">
          {can(ctx.role, "booking:manage") ? (
            <>
              <Link href="/calendar/availability" className="text-primary hover:underline">
                {t("availabilityLink")}
              </Link>
              <Link href="/calendar/booking-types" className="text-primary hover:underline">
                {t("bookingTypesLink")}
              </Link>
            </>
          ) : null}
        </div>
      </div>
      <CalendarView
        view={filters.view}
        anchor={anchorIso}
        q={filters.q ?? ""}
        canWrite={canWrite}
        canDelete={can(ctx.role, "calendar:delete")}
        events={events.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          allDay: e.allDay,
          source: e.source,
          status: e.status,
          timezone: e.timezone,
          location: e.location,
          description: e.description,
          recurrenceRule: e.recurrenceRule,
          isOccurrence: e.isOccurrence,
          contactId: e.contactId,
          companyId: e.companyId,
          dealId: e.dealId,
          ownerId: e.ownerId,
          attendees: e.attendeeRecords.map((a) => ({
            contactId: a.contactId,
            email: a.email,
            name:
              a.name ?? (a.contact ? `${a.contact.firstName} ${a.contact.lastName ?? ""}` : null),
          })),
        }))}
        options={{
          owners,
          contacts: contacts.map((c) => ({
            id: c.id,
            name: [c.firstName, c.lastName].filter(Boolean).join(" "),
          })),
          companies,
          deals,
        }}
      />
    </div>
  );
}
