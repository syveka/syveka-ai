export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listContacts } from "@/server/services/contacts";
import { listCompanyOptions } from "@/server/services/companies";
import { contactListQuerySchema } from "@/lib/validators/crm";
import { ContactsTable } from "@/components/crm/contacts-table";
import { ContactDialog } from "@/components/crm/contact-dialog";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const query = contactListQuerySchema.parse(await searchParams);
  const canWrite = can(ctx.role, "crm:write");

  const [{ data, nextCursor }, companies] = await Promise.all([
    listContacts(ctx, query),
    canWrite ? listCompanyOptions(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("contacts")}</h1>
        {canWrite ? <ContactDialog mode="create" companies={companies} /> : null}
      </div>
      <ContactsTable
        canDelete={can(ctx.role, "crm:delete")}
        nextCursor={nextCursor}
        contacts={data.map((c) => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(" "),
          email: c.email,
          phone: c.phone,
          status: c.status,
          company: c.company?.name ?? null,
          archived: c.archivedAt !== null,
          tags: c.tags.map((tc) => ({ name: tc.tag.name, color: tc.tag.color })),
        }))}
      />
    </div>
  );
}
