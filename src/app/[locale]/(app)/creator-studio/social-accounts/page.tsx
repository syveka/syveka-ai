export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { Share2 } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listSocialAccounts } from "@/server/services/creator-social-accounts";
import { listSocialPlatformCapabilities } from "@/server/social";
import { Card, CardContent } from "@/components/ui/card";
import {
  ConnectSocialAccountForm,
  DisconnectSocialAccountButton,
} from "@/components/creator-studio/connect-social-account-form";

export default async function CreatorSocialAccountsPage() {
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.socialAccounts");
  const accounts = await listSocialAccounts(ctx);
  const capabilities = listSocialPlatformCapabilities();
  const canManage = can(ctx.role, "creator:manage-social-accounts");

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card>
          <CardContent className="py-4">
            <ConnectSocialAccountForm />
          </CardContent>
        </Card>
      ) : null}

      <div>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
          {t("platformStatusTitle")}
        </h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {capabilities.map((c) => (
            <div key={c.platform} className="rounded-md border p-3 text-sm">
              <p className="font-medium">{c.platform}</p>
              <p className="text-xs text-muted-foreground">
                {c.capability === "full" ? t("capabilityFull") : t("capabilityBlocked")}
              </p>
            </div>
          ))}
        </div>
      </div>

      {accounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Share2 className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="divide-y p-0">
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between p-4">
                <div>
                  <p className="text-sm font-medium">
                    {a.platform} — {a.displayName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t(`status.${a.status}` as never)}
                  </p>
                </div>
                {canManage && a.status === "CONNECTED" ? (
                  <DisconnectSocialAccountButton accountId={a.id} />
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
