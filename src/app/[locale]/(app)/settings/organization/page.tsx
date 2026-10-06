export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { unscopedPrisma } from "@/server/db/tenant";
import { OrganizationForm } from "./organization-form";

export default async function OrganizationSettingsPage() {
  const ctx = await requirePermission("org:update");
  const t = await getTranslations("settingsOrganization");
  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { name: true, businessId: true, vatId: true, settings: true, slug: true },
  });
  const settings = (org.settings ?? {}) as { aiInstructions?: string };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("workspace", { slug: org.slug })}</p>
      </div>
      <OrganizationForm
        initial={{
          name: org.name,
          businessId: org.businessId ?? "",
          vatId: org.vatId ?? "",
          aiInstructions: settings.aiInstructions ?? "",
        }}
      />
    </div>
  );
}
