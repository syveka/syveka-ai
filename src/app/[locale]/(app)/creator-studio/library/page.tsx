export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listGenerations } from "@/server/services/creator-generations";
import { listCreatorPosts } from "@/server/services/creator-posts";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { CreatePostFromAssetForm } from "@/components/creator-studio/create-post-from-asset-form";
import { RequestApprovalButton } from "@/components/creator-studio/request-approval-button";

export default async function CreatorLibraryPage() {
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.library");
  const locale = await getLocale();
  const [generations, drafts] = await Promise.all([
    listGenerations(ctx),
    listCreatorPosts(ctx, { approvalStatus: "DRAFT" }),
  ]);
  const canWrite = can(ctx.role, "creator:write");

  return (
    <div className="space-y-6">
      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
          {t("generationsTitle")}
        </h3>
        <Card>
          <CardContent className="divide-y p-0">
            {generations.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t("noGenerations")}</p>
            ) : (
              generations.map((g) => {
                const outputAssetId = g.outputAssetIds[0];
                const output = g.output as { primary?: string } | null;
                return (
                  <div key={g.id} className="flex items-center justify-between gap-4 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {t(`type.${g.generationType}` as never)} ·{" "}
                        {t(`status.${g.status}` as never)}
                      </p>
                      {output?.primary ? (
                        <p className="line-clamp-1 text-xs text-muted-foreground">
                          {output.primary}
                        </p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {formatDate(g.createdAt, locale, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}{" "}
                        · {t("creditsUsed", { count: g.creditsConsumed })}
                      </p>
                    </div>
                    {canWrite && g.status === "COMPLETED" && outputAssetId ? (
                      <CreatePostFromAssetForm assetId={outputAssetId} />
                    ) : null}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{t("draftPostsTitle")}</h3>
        <Card>
          <CardContent className="divide-y p-0">
            {drafts.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{t("noDrafts")}</p>
            ) : (
              drafts.map((post) => (
                <div key={post.id} className="flex items-center justify-between gap-4 p-4">
                  <div>
                    <p className="text-sm font-medium">{post.platform}</p>
                    <p className="line-clamp-1 text-xs text-muted-foreground">
                      {post.caption ?? t("noCaption")}
                    </p>
                  </div>
                  {canWrite ? <RequestApprovalButton postId={post.id} /> : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
