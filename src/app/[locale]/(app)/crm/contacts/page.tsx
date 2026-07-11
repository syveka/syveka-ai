export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listContacts } from "@/server/services/contacts";
import { contactListQuerySchema } from "@/lib/validators/crm";
import { ContactsTable } from "@/components/crm/contacts-table";
import { NewContactDialog } from "@/components/crm/new-contact-dialog";

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const query = contactListQuerySchema.parse(await searchParams);

  const { data, nextCursor } = await listContacts(ctx, query);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("contacts")}</h1>
        {can(ctx.role, "crm:write") ? <NewContactDialog /> : null}
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
          tags: c.tags.map((tc) => ({ name: tc.tag.name, color: tc.tag.color })),
        }))}
      />
    </div>
  );
}
