export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listPrompts } from "@/server/services/prompts";
import { PromptGallery } from "@/components/prompts/prompt-gallery";

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>;
}) {
  const ctx = await requirePermission("prompts:read");
  const t = await getTranslations("prompts");
  const { category } = await searchParams;
  const prompts = await listPrompts(ctx, category);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <PromptGallery
        canWrite={can(ctx.role, "prompts:write")}
        activeCategory={category}
        prompts={prompts.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description,
          content: p.content,
          category: p.category,
          isGlobal: p.organizationId === null,
          variables: (p.variables as Array<{ name: string; label: string }>) ?? [],
          usageCount: p.usageCount,
        }))}
      />
    </div>
  );
}
