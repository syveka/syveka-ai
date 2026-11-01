export const dynamic = "force-dynamic";

import { getTranslations, getLocale } from "next-intl/server";
import { getTenantContext } from "@/server/auth/session";
import { listNotifications } from "@/server/services/notifications";
import { markReadAction } from "@/actions/notifications";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatDateTimeInTimeZone } from "@/lib/date-time";
import { getViewerTimeZone } from "@/server/services/viewer-time-zone";
import { displayNotification } from "@/lib/notifications/display";

export default async function NotificationsPage() {
  const ctx = await getTenantContext();
  const t = await getTranslations("notifications");
  const tWorkflows = await getTranslations("workflows");
  const locale = await getLocale();
  const [notifications, timeZone] = await Promise.all([
    listNotifications(ctx),
    getViewerTimeZone(ctx.userId),
  ]);

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
              // Stored text is shown as stored, except what the viewer's
              // language can safely replace; names and other user data are
              // isolated so mixed Arabic/Latin text keeps its order.
              const shown = displayNotification(n);
              const title =
                shown.kind === "workflow_failed"
                  ? t.rich("workflowFailed", {
                      name: () => <bdi>{shown.workflowName}</bdi>,
                    })
                  : shown.kind === "booking"
                    ? t.rich(`booking.${shown.action}`, {
                        type: () => <bdi>{shown.bookingType}</bdi>,
                        guest: () => <bdi>{shown.guest}</bdi>,
                      })
                    : shown.title;
              const body =
                shown.kind === "workflow_failed"
                  ? tWorkflows(`runFailure.${shown.failure}`)
                  : shown.body;
              const inner = (
                <div className={cn("p-4", !n.readAt && "bg-primary/5")}>
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      dir={shown.kind === "plain" ? "auto" : undefined}
                      className="text-sm font-medium"
                    >
                      {title}
                    </p>
                    <time
                      className="shrink-0 text-xs text-muted-foreground"
                      dateTime={new Date(n.createdAt).toISOString()}
                    >
                      {formatDateTimeInTimeZone(n.createdAt, locale, timeZone, {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </time>
                  </div>
                  {body ? (
                    <p
                      dir={shown.kind === "workflow_failed" ? undefined : "auto"}
                      className="mt-0.5 text-sm text-muted-foreground"
                    >
                      {body}
                    </p>
                  ) : null}
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
