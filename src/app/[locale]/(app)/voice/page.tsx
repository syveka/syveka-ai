import { getTranslations } from "next-intl/server";
import { Phone, Plus } from "lucide-react";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { listAssistants } from "@/server/services/voice";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default async function VoicePage() {
  const ctx = await requirePermission("voice:view-calls");
  const t = await getTranslations("voice");
  const assistants = await listAssistants(ctx);
  const canConfigure = can(ctx.role, "voice:configure");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link href="/voice/calls">{t("callLog")}</Link>
          </Button>
          {canConfigure ? (
            <Button asChild className="gap-2">
              <Link href="/voice/new">
                <Plus className="size-4" />
                {t("newAssistant")}
              </Link>
            </Button>
          ) : null}
        </div>
      </div>

      {assistants.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Phone className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {assistants.map((a) => (
            <Link key={a.id} href={`/voice/${a.id}`}>
              <Card className="transition-colors hover:bg-accent/40">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{a.name}</CardTitle>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        a.isActive ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {a.isActive ? t("active") : t("inactive")}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p>{a.phoneNumber ?? t("noNumber")}</p>
                  <p className="mt-1 text-xs">
                    {a.language} · {a._count.calls} {t("calls")}
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
