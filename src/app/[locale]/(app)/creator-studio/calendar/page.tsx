export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listCreatorPosts } from "@/server/services/creator-posts";
import { listSocialAccounts } from "@/server/services/creator-social-accounts";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { SchedulePostForm } from "@/components/creator-studio/schedule-post-form";
import { CancelPostButton } from "@/components/creator-studio/cancel-post-button";

const STATUS_ORDER = [
  "NOT_SCHEDULED",
  "SCHEDULED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELED",
] as const;

export default async function CreatorCalendarPage() {
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.calendar");
  const locale = await getLocale();
  const [posts, socialAccounts] = await Promise.all([
    listCreatorPosts(ctx),
    listSocialAccounts(ctx),
  ]);
  const canPublish = can(ctx.role, "creator:publish");
  const connectedAccounts = socialAccounts
    .filter((a) => a.status === "CONNECTED")
    .map((a) => ({ id: a.id, platform: a.platform, displayName: a.displayName }));

  const grouped = STATUS_ORDER.map((status) => ({
    status,
    posts: posts.filter((p) => p.publishStatus === status),
  })).filter((g) => g.posts.length > 0);

  if (grouped.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          {t("empty")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map((group) => (
        <div key={group.status}>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
            {t(`status.${group.status}` as never)}
          </h3>
          <Card>
            <CardContent className="divide-y p-0">
              {group.posts.map((post) => (
                <div key={post.id} className="space-y-2 p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium">{post.platform}</p>
                      <p className="line-clamp-1 text-xs text-muted-foreground">
                        {post.caption ?? t("noCaption")}
                      </p>
                      {post.scheduledFor ? (
                        <p className="text-xs text-muted-foreground">
                          {formatDate(post.scheduledFor, locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </p>
                      ) : null}
                      {post.lastErrorSafe ? (
                        <p className="text-xs text-destructive">{post.lastErrorSafe}</p>
                      ) : null}
                    </div>
                    {canPublish && post.publishStatus === "SCHEDULED" ? (
                      <CancelPostButton postId={post.id} />
                    ) : null}
                  </div>
                  {canPublish &&
                  post.publishStatus === "NOT_SCHEDULED" &&
                  post.approvalStatus === "APPROVED" ? (
                    <SchedulePostForm postId={post.id} socialAccounts={connectedAccounts} />
                  ) : null}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}
