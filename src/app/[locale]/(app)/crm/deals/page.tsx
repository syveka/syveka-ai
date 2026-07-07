import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getBoard } from "@/server/services/deals";
import { DealBoard } from "@/components/crm/deal-board";
import { formatCents } from "@/lib/utils";

export default async function DealsPage() {
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const locale = await getLocale();
  const pipeline = await getBoard(ctx);

  if (!pipeline) {
    return <p className="text-sm text-muted-foreground">{t("noPipeline")}</p>;
  }

  const openValue = pipeline.stages
    .filter((s) => !s.isWon && !s.isLost)
    .flatMap((s) => s.deals)
    .reduce((sum, d) => sum + d.valueCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">{t("deals")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("openPipeline")}: <strong>{formatCents(openValue, locale)}</strong>
        </p>
      </div>
      <DealBoard
        canWrite={can(ctx.role, "crm:write")}
        stages={pipeline.stages.map((s) => ({
          id: s.id,
          name: s.name,
          isWon: s.isWon,
          isLost: s.isLost,
          deals: s.deals.map((d) => ({
            id: d.id,
            title: d.title,
            valueCents: d.valueCents,
            contactName: d.contact
              ? [d.contact.firstName, d.contact.lastName].filter(Boolean).join(" ")
              : null,
          })),
        }))}
      />
    </div>
  );
}
