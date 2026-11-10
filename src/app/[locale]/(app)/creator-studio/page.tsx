export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePagePermission } from "@/server/auth/page-guard";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { CREATOR_STUDIO_FLAG, listCreatorProfiles } from "@/server/services/creator-profiles";
import { getCreatorCreditBalance } from "@/server/services/creator-credits";
import { listCreatorPosts } from "@/server/services/creator-posts";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

export default async function CreatorStudioOverviewPage() {
  const ctx = await requirePagePermission("creator:read");
  // While the feature is off, the layout shows that instead of this page, but
  // still renders it in parallel: reading Creator Studio data here would throw
  // FeatureDisabledError, reported as an unhandled error.
  if (!(await isFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG))) return null;
  const t = await getTranslations("creatorStudio.overview");

  const [profiles, credits, pendingApprovals] = await Promise.all([
    listCreatorProfiles(ctx),
    getCreatorCreditBalance(ctx),
    listCreatorPosts(ctx, { approvalStatus: "PENDING_APPROVAL" }),
  ]);

  const stats = [
    { label: t("characters"), value: profiles.length, href: "/creator-studio/characters" },
    {
      label: t("creditsAvailable"),
      value: credits.availableCredits,
      href: "/creator-studio/analytics",
    },
    {
      label: t("pendingApprovals"),
      value: pendingApprovals.length,
      href: "/creator-studio/approvals",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Link key={s.label} href={s.href}>
            <Card className="transition-colors hover:bg-accent/40">
              <CardContent className="space-y-1 py-5">
                <p className="text-sm text-muted-foreground">{s.label}</p>
                <p className="text-3xl font-semibold">{s.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {profiles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("emptyState")}</p>
            <Link
              href="/creator-studio/characters"
              className="text-sm font-medium text-primary hover:underline"
            >
              {t("createCharacterCta")}
            </Link>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
