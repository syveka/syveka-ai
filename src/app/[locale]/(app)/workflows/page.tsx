export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { Plus, GitBranch } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listWorkflows } from "@/server/services/workflows";
import { getViewerTimeZone } from "@/server/services/viewer-time-zone";
import { getWorkflowActivation } from "@/server/services/workflow-activation";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WorkflowToggle } from "@/components/workflows/workflow-toggle";
import { WorkflowEntitlementNotice } from "@/components/workflows/workflow-entitlement-notice";
import { cn } from "@/lib/utils";
import { formatDateTimeInTimeZone } from "@/lib/date-time";
import { isKnownTriggerType } from "@/lib/workflows/activation";

const NOTICE_ID = "workflow-entitlement-notice";

export default async function WorkflowsPage() {
  const ctx = await requirePermission("workflows:view");
  const t = await getTranslations("workflows");
  const locale = await getLocale();
  const [workflows, timeZone] = await Promise.all([
    listWorkflows(ctx),
    getViewerTimeZone(ctx.userId),
  ]);
  const canManage = can(ctx.role, "workflows:manage");
  const activation = await getWorkflowActivation(
    ctx.orgId,
    workflows.filter((w) => w.isActive).length,
  );

  const triggerLabel = (type: string | undefined) =>
    isKnownTriggerType(type) ? t(`triggers.${type}`) : (type ?? "");

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

      {activation.block ? (
        <WorkflowEntitlementNotice
          id={NOTICE_ID}
          message={
            activation.block === "limit_reached"
              ? t("entitlement.limitReached", { limit: activation.limit })
              : activation.block === "read_only"
                ? t("entitlement.readOnly")
                : t("entitlement.notIncluded")
          }
          plansLabel={can(ctx.role, "billing:view") ? t("entitlement.viewPlans") : undefined}
        />
      ) : null}

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
                      {triggerLabel((w.trigger as { type?: string }).type)} ·{" "}
                      {t("runsCount", { count: w._count.runs })}
                      {lastRun
                        ? ` · ${t("lastRun")}: ${formatDateTimeInTimeZone(lastRun.startedAt, locale, timeZone, { dateStyle: "short", timeStyle: "short" })}`
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
                      {t(`runStatus.${lastRun.status}`)}
                    </span>
                  ) : null}
                  {canManage ? (
                    <WorkflowToggle
                      workflowId={w.id}
                      isActive={w.isActive}
                      label={t("toggleLabel", { name: w.name })}
                      activationBlocked={activation.block !== null}
                      describedById={activation.block ? NOTICE_ID : undefined}
                    />
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
