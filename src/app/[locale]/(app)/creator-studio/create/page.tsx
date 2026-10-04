export const dynamic = "force-dynamic";

import { requirePermission } from "@/server/auth/guard";
import { listCreatorProfiles } from "@/server/services/creator-profiles";
import { listCreatorTemplates } from "@/server/services/creator-templates";
import {
  getCreatorCreditBalance,
  getCreatorGenerationCreditCost,
} from "@/server/services/creator-credits";
import { getCreatorMediaProvider, getCreatorCaptionProvider } from "@/server/ai/creator";
import { CreatorMediaProviderUnavailableError } from "@/server/ai/creator/router";
import { unscopedPrisma } from "@/server/db/tenant";
import { GenerateStudio } from "@/components/creator-studio/generate-studio";

/**
 * Without a media provider the page still renders (captions keep working);
 * estimates show the real provider's cost, and a media generation fails
 * closed with a clear message before any credit is reserved.
 */
function resolveMediaProviderNameForEstimates(): string {
  try {
    return getCreatorMediaProvider().name;
  } catch (e) {
    if (e instanceof CreatorMediaProviderUnavailableError) return "fal";
    throw e;
  }
}

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

  const mediaProviderName = resolveMediaProviderNameForEstimates();
  const captionProvider = getCreatorCaptionProvider();
  const estimatedCosts = {
    IMAGE: getCreatorGenerationCreditCost("IMAGE", mediaProviderName, "default"),
    IMAGE_TO_VIDEO: getCreatorGenerationCreditCost("IMAGE_TO_VIDEO", mediaProviderName, "default", {
      durationSeconds: 5,
    }),
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
