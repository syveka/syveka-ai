export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import {
  effectiveProbability,
  expectedRevenueCents,
  getBoard,
  listContactOptions,
  listOwnerOptions,
} from "@/server/services/deals";
import { listCompanyOptions } from "@/server/services/companies";
import { DealBoard } from "@/components/crm/deal-board";
import { DealDialog } from "@/components/crm/deal-dialog";
import { PipelineManager } from "@/components/crm/pipeline-manager";
import { formatCents } from "@/lib/utils";

export default async function DealsPage() {
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const locale = await getLocale();
  const canWrite = can(ctx.role, "crm:write");
  const canManagePipeline = can(ctx.role, "crm:manage-pipeline");

  const [pipeline, contacts, companies, owners] = await Promise.all([
    getBoard(ctx),
    canWrite ? listContactOptions(ctx) : Promise.resolve([]),
    canWrite ? listCompanyOptions(ctx) : Promise.resolve([]),
    listOwnerOptions(ctx),
  ]);

  if (!pipeline) {
    return <p className="text-sm text-muted-foreground">{t("noPipeline")}</p>;
  }

  const ownerNameById = new Map(owners.map((o) => [o.id, o.name]));
  const openDeals = pipeline.stages
    .filter((s) => !s.isWon && !s.isLost)
    .flatMap((s) => s.deals.map((d) => ({ deal: d, stage: s })))
    .filter(({ deal }) => deal.closedAt === null);
  const openValue = openDeals.reduce((sum, { deal }) => sum + deal.valueCents, 0);
  const forecastValue = openDeals.reduce(
    (sum, { deal, stage }) =>
      sum + expectedRevenueCents(deal.valueCents, effectiveProbability(deal, stage)),
    0,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("deals")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("openPipeline")}: <strong>{formatCents(openValue, locale)}</strong> · {t("forecast")}
            : <strong>{formatCents(forecastValue, locale)}</strong>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManagePipeline ? (
            <PipelineManager
              stages={pipeline.stages.map((s) => ({
                id: s.id,
                name: s.name,
                probability: s.probability,
                isWon: s.isWon,
                isLost: s.isLost,
                dealCount: s.deals.length,
              }))}
            />
          ) : null}
          {canWrite ? (
            <DealDialog
              mode="create"
              stages={pipeline.stages.map((s) => ({ id: s.id, name: s.name }))}
              contacts={contacts}
              companies={companies}
              owners={owners}
            />
          ) : null}
        </div>
      </div>
      <DealBoard
        canWrite={canWrite}
        stages={pipeline.stages.map((s) => ({
          id: s.id,
          name: s.name,
          probability: s.probability,
          isWon: s.isWon,
          isLost: s.isLost,
          deals: s.deals.map((d) => ({
            id: d.id,
            title: d.title,
            valueCents: d.valueCents,
            currency: d.currency,
            probability: effectiveProbability(d, s),
            expectedCloseAt: d.expectedCloseAt?.toISOString() ?? null,
            isClosed: d.closedAt !== null,
            contactName: d.contact
              ? [d.contact.firstName, d.contact.lastName].filter(Boolean).join(" ")
              : null,
            companyName: d.company?.name ?? null,
            ownerName: (d.ownerId ? ownerNameById.get(d.ownerId) : null) ?? null,
          })),
        }))}
      />
    </div>
  );
}
