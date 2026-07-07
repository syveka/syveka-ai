import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import {
  getSalesAnalytics, getAiAnalytics, getVoiceAnalytics,
} from "@/server/services/analytics";
import { BarChart, FunnelChart, StatCard } from "@/components/analytics/charts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCents } from "@/lib/utils";

export default async function AnalyticsPage() {
  const ctx = await requirePermission("analytics:view");
  const t = await getTranslations("analytics");
  const locale = await getLocale();

  const [sales, ai, voice] = await Promise.all([
    getSalesAnalytics(ctx),
    getAiAnalytics(ctx),
    getVoiceAnalytics(ctx),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("winRate")} value={sales.winRate !== null ? `${sales.winRate} %` : "—"} />
        <StatCard label={t("aiTokens")} value={(ai.tokensIn + ai.tokensOut).toLocaleString()} />
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
                stage: s.stage,
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
            <BarChart data={ai.messagesByDay.map((d) => ({ label: d.date.slice(5), value: d.count }))} />
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
            <BarChart data={voice.callsByDay.map((d) => ({ label: d.date.slice(5), value: d.count }))} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("callSentiment")}</CardTitle>
          </CardHeader>
          <CardContent>
            <FunnelChart
              data={[
                { stage: t("sentiment.positive"), count: voice.sentiments.positive, value: "", isWon: true },
                { stage: t("sentiment.neutral"), count: voice.sentiments.neutral, value: "" },
                { stage: t("sentiment.negative"), count: voice.sentiments.negative, value: "", isLost: true },
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
