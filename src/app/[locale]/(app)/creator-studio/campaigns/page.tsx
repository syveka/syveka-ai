export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { Megaphone } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listCreatorCampaigns } from "@/server/services/creator-campaigns";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import { CreateCampaignForm } from "@/components/creator-studio/create-campaign-form";

export default async function CreatorCampaignsPage() {
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.campaigns");
  const campaigns = await listCreatorCampaigns(ctx);
  const canWrite = can(ctx.role, "creator:write");

  return (
    <div className="space-y-6">
      {canWrite ? (
        <Card>
          <CardContent className="py-4">
            <CreateCampaignForm />
          </CardContent>
        </Card>
      ) : null}

      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Megaphone className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {campaigns.map((c) => (
              <Link
                key={c.id}
                href={`/creator-studio/campaigns/${c.id}`}
                className="flex items-center justify-between p-4 hover:bg-accent/40"
              >
                <div>
                  <p className="font-medium">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`approvalMode.${c.approvalMode}` as never)} · {c._count.posts}{" "}
                    {t("postsCount")}
                  </p>
                </div>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {t(`status.${c.status}` as never)}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
