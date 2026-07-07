import { getTranslations, getLocale } from "next-intl/server";
import { getTenantContext } from "@/server/auth/session";
import { listNotifications } from "@/server/services/notifications";
import { markReadAction } from "@/actions/notifications";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, cn } from "@/lib/utils";

export default async function NotificationsPage() {
  const ctx = await getTenantContext();
  const t = await getTranslations("notifications");
  const locale = await getLocale();
  const notifications = await listNotifications(ctx);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <form action={markReadAction.bind(null, "all")}>
          <Button type="submit" variant="ghost" size="sm">
            {t("markAllRead")}
          </Button>
        </form>
      </div>
      <Card>
        <CardContent className="divide-y p-0">
          {notifications.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{t("empty")}</p>
          ) : (
            notifications.map((n) => {
              const inner = (
                <div className={cn("p-4", !n.readAt && "bg-primary/5")}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{n.title}</p>
                    <time className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(n.createdAt, locale, { dateStyle: "short", timeStyle: "short" })}
                    </time>
                  </div>
                  {n.body ? <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p> : null}
                </div>
              );
              return n.href ? (
                <Link key={n.id} href={n.href as never} className="block hover:bg-accent/40">
                  {inner}
                </Link>
              ) : (
                <div key={n.id}>{inner}</div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
