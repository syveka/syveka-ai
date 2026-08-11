export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getBusinessDNA } from "@/server/services/business-dna";
import { normalizeOpeningHours } from "@/lib/business-dna/opening-hours";
import { Link } from "@/i18n/routing";
import { BusinessDnaForm } from "./business-dna-form";

export default async function BusinessDnaSettingsPage() {
  const ctx = await requirePermission("business-dna:read");
  const t = await getTranslations("businessDna");
  const record = await getBusinessDNA(ctx);
  const isNew = record === null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
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
        readOnly={!can(ctx.role, "business-dna:write")}
        isNew={isNew}
        updatedAt={record?.updatedAt.toISOString() ?? null}
        initial={{
          displayName: record?.displayName ?? "",
          industry: record?.industry ?? "",
          productsServices: record?.productsServices ?? "",
          supportedLocales: record?.supportedLocales ?? [],
          brandTone: record?.brandTone ?? "",
          communicationStyle: record?.communicationStyle ?? "",
          openingHours: normalizeOpeningHours(record?.openingHours ?? null),
          policies: record?.policies ?? "",
          pricingNotes: record?.pricingNotes ?? "",
          targetCustomer: record?.targetCustomer ?? "",
          keyFacts: record?.keyFacts ?? [],
        }}
      />
    </div>
  );
}
