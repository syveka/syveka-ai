export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { Plus, GitBranch } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listWorkflows } from "@/server/services/workflows";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WorkflowToggle } from "@/components/workflows/workflow-toggle";
import { formatDate, cn } from "@/lib/utils";

export default async function WorkflowsPage() {
  const ctx = await requirePermission("workflows:view");
  const t = await getTranslations("workflows");
  const locale = await getLocale();
  const workflows = await listWorkflows(ctx);
  const canManage = can(ctx.role, "workflows:manage");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        {canManage ? (
          <Button asChild className="gap-2">
            <Link href="/workflows/new">
              <Plus className="size-4" />
              {t("newWorkflow")}
            </Link>
          </Button>
        ) : null}
      </div>

      {workflows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <GitBranch className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {workflows.map((w) => {
              const lastRun = w.runs[0];
              return (
                <div key={w.id} className="flex items-center gap-3 p-4">
                  <Link href={`/workflows/${w.id}`} className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium hover:underline">{w.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(w.trigger as { type?: string }).type} · {w._count.runs} {t("runs")}
                      {lastRun
                        ? ` · ${t("lastRun")}: ${formatDate(lastRun.startedAt, locale, { dateStyle: "short", timeStyle: "short" })}`
                        : ""}
                    </p>
                  </Link>
                  {lastRun ? (
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs",
                        lastRun.status === "SUCCEEDED" && "bg-success/15 text-success",
                        lastRun.status === "FAILED" && "bg-destructive/15 text-destructive",
                        lastRun.status === "RUNNING" && "bg-warning/15 text-warning",
                        lastRun.status === "WAITING" && "bg-muted text-muted-foreground",
                      )}
                    >
                      {lastRun.status}
                    </span>
                  ) : null}
                  {canManage ? <WorkflowToggle workflowId={w.id} isActive={w.isActive} /> : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
