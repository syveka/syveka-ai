export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { getSalesAnalytics, getAiAnalytics, getVoiceAnalytics } from "@/server/services/analytics";
import { BarChart, FunnelChart, StatCard } from "@/components/analytics/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";
import { stageLabel } from "@/lib/crm/stage-labels";

export default async function AnalyticsPage() {
  const ctx = await requirePermission("analytics:view");
  const t = await getTranslations("analytics");
  const tCrm = await getTranslations("crm");
  const locale = await getLocale();

  const [sales, ai, voice] = await Promise.all([
    getSalesAnalytics(ctx),
    getAiAnalytics(ctx),
    getVoiceAnalytics(ctx),
  ]);

  const number = new Intl.NumberFormat(locale);
  // Series keys are calendar days ("YYYY-MM-DD", bucketed in UTC by the
  // analytics service), so they are formatted as dates in UTC, not shifted.
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const series = (rows: Array<{ date: string; count: number }>) =>
    rows.map((r) => ({
      key: r.date,
      label: day.format(new Date(`${r.date}T00:00:00Z`)),
      value: r.count,
      valueText: number.format(r.count),
    }));
  const chartText = (rows: Array<{ count: number }>) =>
    t("chartSummary", {
      count: rows.length,
      max: number.format(Math.max(0, ...rows.map((r) => r.count))),
    });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t("winRate")}
          value={sales.winRate !== null ? `${sales.winRate} %` : "—"}
        />
        <StatCard label={t("aiTokens")} value={number.format(ai.tokensIn + ai.tokensOut)} />
        <StatCard label={t("voiceCalls30d")} value={voice.totalCalls} />
        <StatCard label={t("voiceMinutes30d")} value={voice.totalMinutes} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("pipelineFunnel")}</CardTitle>
          </CardHeader>
          <CardContent>
            <FunnelChart
              data={sales.funnel.map((s) => ({
                stage: stageLabel(
                  { name: s.stage, order: s.order, isWon: s.isWon, isLost: s.isLost },
                  (key) => tCrm(`defaultStages.${key}`),
                ),
                count: s.count,
                value: formatCents(s.valueCents, locale),
                isWon: s.isWon,
                isLost: s.isLost,
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("aiMessages30d")}</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={series(ai.messagesByDay)}
              title={t("aiMessages30d")}
              summary={chartText(ai.messagesByDay)}
              emptyLabel={t("noAiMessages")}
              dateHeader={t("chartDate")}
              valueHeader={t("chartValue")}
            />
            {ai.feedbackPositivePct !== null ? (
              <p className="mt-3 text-sm text-muted-foreground">
                {t("feedbackPositive")}: {ai.feedbackPositivePct} %
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("callVolume30d")}</CardTitle>
          </CardHeader>
          <CardContent>
            <BarChart
              data={series(voice.callsByDay)}
              title={t("callVolume30d")}
              summary={chartText(voice.callsByDay)}
              emptyLabel={t("noCalls")}
              dateHeader={t("chartDate")}
              valueHeader={t("chartValue")}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("callSentiment")}</CardTitle>
          </CardHeader>
          <CardContent>
            <FunnelChart
              data={[
                {
                  stage: t("sentiment.positive"),
                  count: voice.sentiments.positive,
                  value: "",
                  isWon: true,
                },
                { stage: t("sentiment.neutral"), count: voice.sentiments.neutral, value: "" },
                {
                  stage: t("sentiment.negative"),
                  count: voice.sentiments.negative,
                  value: "",
                  isLost: true,
                },
              ]}
            />
            <p className="mt-3 text-sm text-muted-foreground">
              {t("transferred")}: {voice.transferred}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
