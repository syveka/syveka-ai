export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { listConnections } from "@/server/services/calendar-connections";
import { listAvailableProviders } from "@/server/integrations/calendar";
import { CalendarIntegrations } from "@/components/calendar/calendar-integrations";

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ calendar_connected?: string; calendar_error?: string }>;
}) {
  const ctx = await requirePermission("integrations:manage");
  const t = await getTranslations("integrations");
  const sp = await searchParams;

  const [connections, providers] = await Promise.all([
    listConnections(ctx),
    Promise.resolve(listAvailableProviders()),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <CalendarIntegrations
        justConnected={sp.calendar_connected ?? null}
        connectError={sp.calendar_error ?? null}
        providers={providers}
        connections={connections.map((c) => ({
          id: c.id,
          provider: c.provider,
          accountEmail: c.accountEmail,
          status: c.status,
          lastError: c.lastError,
          lastCheckedAt: c.lastCheckedAt?.toISOString() ?? null,
          calendars: c.calendars.map((cal) => ({
            id: cal.id,
            name: cal.name,
            isPrimary: cal.isPrimary,
            syncEnabled: cal.syncEnabled,
            lastSyncedAt: cal.syncState?.lastSyncedAt?.toISOString() ?? null,
            lastSyncStatus: cal.syncState?.lastSyncStatus ?? null,
          })),
        }))}
      />
    </div>
  );
}
