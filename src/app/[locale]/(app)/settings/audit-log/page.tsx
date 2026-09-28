export const dynamic = "force-dynamic";

import { getLocale, getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeInTimeZone, resolveDisplayTimeZone } from "@/lib/date-time";

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const ctx = await requirePermission("audit:view");
  const locale = await getLocale();
  const t = await getTranslations("settingsAuditLog");
  const { action } = await searchParams;

  const db = tenantDb(ctx.orgId);
  // Times are shown in the viewer's own profile timezone (see src/lib/date-time.ts).
  const viewer = await unscopedPrisma.user.findUnique({
    where: { id: ctx.userId },
    select: { timezone: true },
  });
  const timeZone = resolveDisplayTimeZone(viewer?.timezone);
  const logs = await db.auditLog.findMany({
    where: action ? { action: { contains: action } } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const actorIds = [...new Set(logs.map((l) => l.actorId).filter((v): v is string => !!v))];
  const actors = await unscopedPrisma.user.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, email: true },
  });
  const actorById = new Map(actors.map((a) => [a.id, a.email]));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("timesShownIn", { timeZone })}</p>
      </div>

      <form method="get">
        <label htmlFor="audit-action-filter" className="sr-only">
          {t("filterLabel")}
        </label>
        <input
          id="audit-action-filter"
          type="search"
          name="action"
          defaultValue={action}
          placeholder={t("filterPlaceholder")}
          className="h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-3 text-sm"
        />
      </form>

      <Card>
        <CardContent className="divide-y p-0">
          {logs.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="p-4 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <code dir="ltr" className="break-all text-xs font-medium">
                    {log.action}
                  </code>
                  <time
                    dateTime={log.createdAt.toISOString()}
                    title={timeZone}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {formatDateTimeInTimeZone(log.createdAt, locale, timeZone)}
                  </time>
                </div>
                <p className="mt-0.5 break-words text-xs text-muted-foreground">
                  {log.actorId ? (actorById.get(log.actorId) ?? log.actorId) : log.actorType} ·{" "}
                  {log.resourceType}
                  {log.resourceId ? ` · ${log.resourceId.slice(0, 8)}…` : ""}
                  {log.ip ? ` · ${log.ip}` : ""}
                </p>
                {log.before || log.after ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {t("details")}
                    </summary>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify({ before: log.before, after: log.after }, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
