export const dynamic = "force-dynamic";

import { requirePermission } from "@/server/auth/guard";
import { listCreatorProfiles } from "@/server/services/creator-profiles";
import { listCreatorTemplates } from "@/server/services/creator-templates";
import {
  getCreatorCreditBalance,
  getCreatorGenerationCreditCost,
} from "@/server/services/creator-credits";
import { getCreatorMediaProvider, getCreatorCaptionProvider } from "@/server/ai/creator";
import { unscopedPrisma } from "@/server/db/tenant";
import { GenerateStudio } from "@/components/creator-studio/generate-studio";

export default async function CreatorGeneratePage({
  searchParams,
}: {
  searchParams: Promise<{ creatorProfileId?: string }>;
}) {
  const { creatorProfileId } = await searchParams;
  const ctx = await requirePermission("creator:generate");

  const [profiles, templates, balance] = await Promise.all([
    listCreatorProfiles(ctx),
    listCreatorTemplates(ctx),
    getCreatorCreditBalance(ctx),
  ]);

  const assets = await unscopedPrisma.creatorReferenceAsset.findMany({
    where: { organizationId: ctx.orgId, source: "GENERATED" },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, assetType: true, creatorProfileId: true },
  });

  const mediaProvider = getCreatorMediaProvider();
  const captionProvider = getCreatorCaptionProvider();
  const estimatedCosts = {
    IMAGE: getCreatorGenerationCreditCost("IMAGE", mediaProvider.name, "default"),
    IMAGE_TO_VIDEO: getCreatorGenerationCreditCost(
      "IMAGE_TO_VIDEO",
      mediaProvider.name,
      "default",
      {
        durationSeconds: 5,
      },
    ),
    CAPTION: getCreatorGenerationCreditCost("CAPTION", captionProvider.name, "default"),
  };

  return (
    <GenerateStudio
      profiles={profiles.map((p) => ({ id: p.id, displayName: p.displayName, status: p.status }))}
      templates={templates.map((t) => ({
        id: t.id,
        name: t.name,
        category: t.category,
        aspectRatio: t.aspectRatio,
      }))}
      assets={assets}
      defaultProfileId={creatorProfileId}
      creditBalance={balance.availableCredits}
      estimatedCosts={estimatedCosts}
    />
  );
}
