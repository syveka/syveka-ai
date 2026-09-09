export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import {
  getCreatorGenerationAnalytics,
  getCreatorPublishingAnalytics,
} from "@/server/services/creator-analytics";
import { getCreatorCreditBalance } from "@/server/services/creator-credits";
import { Card, CardContent } from "@/components/ui/card";

export default async function CreatorAnalyticsPage() {
  const ctx = await requirePermission("analytics:view");
  const t = await getTranslations("creatorStudio.analytics");
  const [generation, publishing, credits] = await Promise.all([
    getCreatorGenerationAnalytics(ctx),
    getCreatorPublishingAnalytics(ctx),
    getCreatorCreditBalance(ctx),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="py-5">
            <p className="text-sm text-muted-foreground">{t("creditsAvailable")}</p>
            <p className="text-2xl font-semibold">{credits.availableCredits}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-5">
            <p className="text-sm text-muted-foreground">{t("creditsConsumed")}</p>
            <p className="text-2xl font-semibold">{generation.creditsConsumedTotal}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-5">
            <p className="text-sm text-muted-foreground">{t("avgLatency")}</p>
            <p className="text-2xl font-semibold">{generation.averageLatencyMs}ms</p>
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
          {t("generationsByType")}
        </h3>
        <Card>
          <CardContent className="divide-y p-0">
            {generation.byTypeStatus.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t("noData")}</p>
            ) : (
              generation.byTypeStatus.map((row, i) => (
                <div key={i} className="flex items-center justify-between p-3 text-sm">
                  <span>
                    {row.generationType} · {row.status}
                  </span>
                  <span className="font-medium">{row.count}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t("postsByPlatform")}</h3>
        <Card>
          <CardContent className="divide-y p-0">
            {publishing.byPlatformStatus.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t("noData")}</p>
            ) : (
              publishing.byPlatformStatus.map((row, i) => (
                <div key={i} className="flex items-center justify-between p-3 text-sm">
                  <span>
                    {row.platform} · {row.publishStatus}
                  </span>
                  <span className="font-medium">{row.count}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        {t("autopilotPublished", { count: publishing.autopilotPublishedCount })} ·{" "}
        {t("avgApprovalTurnaround", {
          hours: Math.round(publishing.avgApprovalTurnaroundMs / 3_600_000),
        })}
      </p>
    </div>
  );
}
