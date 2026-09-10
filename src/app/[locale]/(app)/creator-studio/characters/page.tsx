export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { UserCircle2 } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listCreatorProfiles } from "@/server/services/creator-profiles";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import { CreateProfileForm } from "@/components/creator-studio/create-profile-form";

export default async function CreatorCharactersPage() {
  const ctx = await requirePermission("creator:read");
  const t = await getTranslations("creatorStudio.characters");
  const profiles = await listCreatorProfiles(ctx);
  const canWrite = can(ctx.role, "creator:write");

  return (
    <div className="space-y-6">
      {canWrite ? (
        <Card>
          <CardContent className="py-4">
            <CreateProfileForm />
          </CardContent>
        </Card>
      ) : null}

      {profiles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <UserCircle2 className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {profiles.map((p) => (
            <Link key={p.id} href={`/creator-studio/characters/${p.id}`}>
              <Card className="h-full transition-colors hover:bg-accent/40">
                <CardContent className="space-y-2 py-5">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{p.displayName}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        p.status === "ACTIVE"
                          ? "bg-success/15 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {t(`status.${p.status}` as never)}
                    </span>
                  </div>
                  {p.description ? (
                    <p className="line-clamp-2 text-sm text-muted-foreground">{p.description}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {t("referenceCount", { count: p._count.referenceAssets })}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
