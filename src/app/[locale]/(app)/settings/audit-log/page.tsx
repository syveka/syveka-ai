import { getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string }>;
}) {
  const ctx = await requirePermission("audit:view");
  const locale = await getLocale();
  const { action } = await searchParams;

  const db = tenantDb(ctx.orgId);
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
        <h1 className="text-2xl font-semibold">Audit log</h1>
        <p className="text-sm text-muted-foreground">
          Every sensitive change in this organization, retained per your plan.
        </p>
      </div>

      <form method="get">
        <input
          name="action"
          defaultValue={action}
          placeholder="Filter by action (e.g. member.role_change)…"
          className="h-9 w-full max-w-sm rounded-md border border-input bg-transparent px-3 text-sm"
        />
      </form>

      <Card>
        <CardContent className="divide-y p-0">
          {logs.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">No entries.</p>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="p-4 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <code className="text-xs font-medium">{log.action}</code>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(log.createdAt, locale, { dateStyle: "short", timeStyle: "medium" })}
                  </time>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {log.actorId ? (actorById.get(log.actorId) ?? log.actorId) : log.actorType} ·{" "}
                  {log.resourceType}
                  {log.resourceId ? ` · ${log.resourceId.slice(0, 8)}…` : ""}
                  {log.ip ? ` · ${log.ip}` : ""}
                </p>
                {log.before || log.after ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-foreground">diff</summary>
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
