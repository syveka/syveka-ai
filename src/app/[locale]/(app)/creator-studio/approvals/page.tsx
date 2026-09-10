export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { CheckCircle2 } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listCreatorPosts } from "@/server/services/creator-posts";
import { Card, CardContent } from "@/components/ui/card";
import { PostReviewActions } from "@/components/creator-studio/post-review-actions";

export default async function CreatorApprovalsPage() {
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.approvals");
  const posts = await listCreatorPosts(ctx, { approvalStatus: "PENDING_APPROVAL" });
  const canApprove = can(ctx.role, "creator:approve");

  if (posts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <CheckCircle2 className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="divide-y p-0">
        {posts.map((post) => (
          <div key={post.id} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{post.platform}</p>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {post.caption ?? t("noCaption")}
              </p>
            </div>
            {canApprove ? <PostReviewActions postId={post.id} /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
