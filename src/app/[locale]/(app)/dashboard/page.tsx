import { getTranslations } from "next-intl/server";
import { getTenantContext } from "@/server/auth/session";
import { tenantDb } from "@/server/db/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const ctx = await getTenantContext();
  const t = await getTranslations("dashboard");
  const db = tenantDb(ctx.orgId);

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [openDeals, callsThisMonth, aiMessagesAgg] = await Promise.all([
    db.deal.count({ where: { closedAt: null, deletedAt: null } }),
    db.voiceCall.count({ where: { startedAt: { gte: monthStart } } }),
    db.usageRecord.aggregate({
      where: { metric: "AI_MESSAGES", periodStart: { gte: monthStart } },
      _sum: { quantity: true },
    }),
  ]);

  const stats = [
    { label: t("openDeals"), value: openDeals },
    { label: t("callsHandled"), value: callsThisMonth },
    { label: t("aiMessages"), value: aiMessagesAgg._sum.quantity ?? 0 },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
