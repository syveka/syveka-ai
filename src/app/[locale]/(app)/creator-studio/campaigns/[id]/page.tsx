export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getCreatorCampaign } from "@/server/services/creator-campaigns";
import { Card, CardContent } from "@/components/ui/card";
import { AutopilotToggle } from "@/components/creator-studio/autopilot-toggle";

export default async function CreatorCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.campaigns");
  const campaign = await getCreatorCampaign(ctx, id);
  const canManageAutopilot = can(ctx.role, "creator:manage-autopilot");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{campaign.name}</h2>
        <p className="text-sm text-muted-foreground">
          {t(`approvalMode.${campaign.approvalMode}` as never)}
        </p>
      </div>

      {canManageAutopilot ? (
        <AutopilotToggle
          campaignId={campaign.id}
          enabled={campaign.autopilotEnabled}
          targetPlatforms={campaign.targetPlatforms}
        />
      ) : null}

      <Card>
        <CardContent className="divide-y p-0">
          {campaign.posts.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">{t("noPosts")}</p>
          ) : (
            campaign.posts.map((post) => (
              <div key={post.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">{post.platform}</p>
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {post.caption ?? t("noCaption")}
                  </p>
                </div>
                <div className="flex gap-2 text-xs">
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    {t(`approvalStatus.${post.approvalStatus}` as never)}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5">
                    {t(`publishStatus.${post.publishStatus}` as never)}
                  </span>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
