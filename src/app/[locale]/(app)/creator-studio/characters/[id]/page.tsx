export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getCreatorProfile } from "@/server/services/creator-profiles";
import { MIN_REFERENCE_ASSETS } from "@/lib/validators/creator-studio";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { ReferenceAssetUploader } from "@/components/creator-studio/reference-asset-uploader";
import { ConsentButton } from "@/components/creator-studio/consent-button";

export default async function CreatorCharacterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.characters");
  const profile = await getCreatorProfile(ctx, id);
  const canWrite = can(ctx.role, "creator:write");
  const approvedCount = profile.referenceAssets.filter(
    (a) => a.validationStatus === "APPROVED",
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{profile.displayName}</h2>
          <p className="text-sm text-muted-foreground">
            {t(`status.${profile.status}` as never)}
            {profile.consentConfirmedAt ? ` · ${t("consentConfirmed")}` : ""}
          </p>
        </div>
        {profile.status === "ACTIVE" ? (
          <Button asChild>
            <Link href={`/creator-studio/create?creatorProfileId=${profile.id}`}>
              {t("generateCta")}
            </Link>
          </Button>
        ) : null}
      </div>

      {canWrite ? (
        <Card>
          <CardContent className="space-y-4 py-5">
            <div>
              <h3 className="mb-1 font-medium">{t("referenceImages")}</h3>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("referenceProgress", { count: approvedCount, min: MIN_REFERENCE_ASSETS })}
              </p>
              <ReferenceAssetUploader profileId={profile.id} />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {profile.referenceAssets.length > 0 ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {profile.referenceAssets.map((asset) => (
            <div
              key={asset.id}
              className="flex aspect-square items-center justify-center rounded-md border bg-muted text-xs text-muted-foreground"
            >
              {t(`validation.${asset.validationStatus}` as never)}
            </div>
          ))}
        </div>
      ) : null}

      {canWrite && !profile.consentConfirmedAt ? (
        <Card>
          <CardContent className="py-5">
            <ConsentButton profileId={profile.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
