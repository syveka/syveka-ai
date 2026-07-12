export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listCompanies } from "@/server/services/companies";
import { companyListQuerySchema } from "@/lib/validators/crm";
import { CompaniesTable } from "@/components/crm/companies-table";
import { CompanyDialog } from "@/components/crm/company-dialog";

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const query = companyListQuerySchema.parse(await searchParams);

  const { data, nextCursor } = await listCompanies(ctx, query);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("companies")}</h1>
        {can(ctx.role, "crm:write") ? <CompanyDialog mode="create" /> : null}
      </div>
      <CompaniesTable
        canDelete={can(ctx.role, "crm:delete")}
        nextCursor={nextCursor}
        companies={data.map((c) => ({
          id: c.id,
          name: c.name,
          domain: c.domain,
          industry: c.industry,
          contactCount: c._count.contacts,
          dealCount: c._count.deals,
          archived: c.archivedAt !== null,
        }))}
      />
    </div>
  );
}
