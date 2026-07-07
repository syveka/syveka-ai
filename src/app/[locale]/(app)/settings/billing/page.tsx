import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import {
  getEntitlements, getMonthUsage,
} from "@/server/services/billing/entitlements";
import { tenantDb } from "@/server/db/tenant";
import { PlanCards } from "@/components/billing/plan-cards";
import { UsageMeters } from "@/components/billing/usage-meters";
import { openPortalAction } from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requirePermission("billing:view");
  const t = await getTranslations("billingPage");
  const { status } = await searchParams;
  const canManage = can(ctx.role, "billing:manage");

  const db = tenantDb(ctx.orgId);
  const [ent, aiMessages, voiceMinutes, contacts, storageAgg, seats] = await Promise.all([
    getEntitlements(ctx.orgId),
    getMonthUsage(ctx.orgId, "AI_MESSAGES"),
    getMonthUsage(ctx.orgId, "VOICE_MINUTES"),
    db.contact.count({ where: { deletedAt: null } }),
    db.document.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
    db.organizationMember.count(),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      {status === "success" ? (
        <Card className="border-success/40">
          <CardContent className="pt-6 text-sm text-success">{t("checkoutSuccess")}</CardContent>
        </Card>
      ) : null}
      {ent.status === "PAST_DUE" ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">{t("pastDue")}</CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{t("currentPlan")}</p>
          <p className="text-xl font-semibold">{ent.plan}</p>
        </div>
        {canManage && ent.plan !== "FREE" ? (
          <form action={openPortalAction}>
            <Button type="submit" variant="outline">
              {t("managePortal")}
            </Button>
          </form>
        ) : null}
      </div>

      <UsageMeters
        items={[
          { label: t("usage.aiMessages"), used: aiMessages, limit: ent.aiMessagesPerUserMonth * seats },
          { label: t("usage.voiceMinutes"), used: voiceMinutes, limit: ent.voiceMinutesMonth },
          { label: t("usage.contacts"), used: contacts, limit: ent.maxContacts },
          {
            label: t("usage.storage"),
            used: Math.round((storageAgg._sum.sizeBytes ?? 0) / 1_048_576),
            limit: ent.kbStorageMb,
          },
          { label: t("usage.seats"), used: seats, limit: ent.maxSeats },
        ]}
      />

      {canManage ? <PlanCards currentPlan={ent.plan} /> : null}
    </div>
  );
}
