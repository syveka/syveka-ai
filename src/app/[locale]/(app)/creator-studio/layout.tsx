import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { AuthError } from "@/server/auth/session";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { CREATOR_STUDIO_FLAG } from "@/server/services/creator-profiles";
import { CreatorStudioNav } from "@/components/creator-studio/nav";

export default async function CreatorStudioLayout({ children }: { children: React.ReactNode }) {
  let ctx;
  try {
    ctx = await requirePermission("creator:read");
  } catch (e) {
    if (e instanceof AuthError) redirect("/dashboard");
    throw e;
  }

  const t = await getTranslations("creatorStudio");
  const enabled = await isFeatureEnabled(ctx.orgId, CREATOR_STUDIO_FLAG);

  if (!enabled) {
    return (
      <div className="mx-auto max-w-xl space-y-3 py-16 text-center">
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("featureDisabled")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      <CreatorStudioNav />
      {children}
    </div>
  );
}
