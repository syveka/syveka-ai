export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getBusinessDNA } from "@/server/services/business-dna";
import { listBusinessDnaServices } from "@/server/services/business-dna-services";
import { normalizeOpeningHours } from "@/lib/business-dna/opening-hours";
import { Link } from "@/i18n/routing";
import { BusinessDnaForm } from "./business-dna-form";

export default async function BusinessDnaSettingsPage() {
  const ctx = await requirePermission("business-dna:read");
  const t = await getTranslations("businessDna");
  const [record, services] = await Promise.all([getBusinessDNA(ctx), listBusinessDnaServices(ctx)]);
  const isNew = record === null;
  const canWrite = can(ctx.role, "business-dna:write");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {isNew ? (
          <Link
            href="/dashboard"
            className="shrink-0 text-sm text-muted-foreground hover:underline"
          >
            {t("skipForNow")}
          </Link>
        ) : null}
      </div>
      <BusinessDnaForm
        readOnly={!canWrite}
        isNew={isNew}
        updatedAt={record?.updatedAt.toISOString() ?? null}
        services={services}
        canManageServices={canWrite && !isNew}
        initial={{
          displayName: record?.displayName ?? "",
          industry: record?.industry ?? "",
          description: record?.description ?? "",
          productsServices: record?.productsServices ?? "",
          supportedLocales: record?.supportedLocales ?? [],
          timezone: record?.timezone ?? "",
          brandTone: record?.brandTone ?? "",
          communicationStyle: record?.communicationStyle ?? "",
          responseInstructions: record?.responseInstructions ?? "",
          openingHours: normalizeOpeningHours(record?.openingHours ?? null),
          cancellationPolicy: record?.cancellationPolicy ?? "",
          bookingPolicy: record?.bookingPolicy ?? "",
          refundPolicy: record?.refundPolicy ?? "",
          paymentPolicy: record?.paymentPolicy ?? "",
          otherPolicies: record?.otherPolicies ?? "",
          currency: record?.currency ?? "",
          quoteInstructions: record?.quoteInstructions ?? "",
          pricingNotes: record?.pricingNotes ?? "",
          targetCustomer: record?.targetCustomer ?? "",
          keyFacts: record?.keyFacts ?? [],
        }}
      />
    </div>
  );
}
