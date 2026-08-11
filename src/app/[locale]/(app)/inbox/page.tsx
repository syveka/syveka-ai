export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { listThreads } from "@/server/services/inbox";
import { threadListQuerySchema } from "@/lib/validators/inbox";
import { Link } from "@/i18n/routing";
import { Card, CardContent } from "@/components/ui/card";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-primary/10 text-primary",
  PENDING: "bg-amber-500/10 text-amber-600",
  CLOSED: "bg-muted text-muted-foreground",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const ctx = await requirePermission("inbox:read");
  const t = await getTranslations("inbox");
  const query = threadListQuerySchema.parse(await searchParams);
  const { data } = await listThreads(ctx, query);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {data.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">{t("empty")}</CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.map((thread) => {
            const contactName = thread.contact
              ? [thread.contact.firstName, thread.contact.lastName].filter(Boolean).join(" ")
              : null;
            const unread = thread.readAt === null;
            return (
              <Link
                key={thread.id}
                href={`/inbox/${thread.id}`}
                className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="transition-colors hover:bg-accent/50">
                  <CardContent className="flex items-center gap-4 p-4">
                    {unread ? (
                      <span className="sr-only">{t("unread")}</span>
                    ) : (
                      <span className="sr-only">{t("read")}</span>
                    )}
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-transparent"}`}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={`truncate ${unread ? "font-semibold" : "font-medium"}`}>
                          {thread.subject || t("noSubject")}
                        </span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            STATUS_STYLES[thread.status] ?? STATUS_STYLES.OPEN
                          }`}
                        >
                          {t(`status.${thread.status}`)}
                        </span>
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {t(`channel.${thread.channel}`)}
                        {contactName ? ` · ${contactName}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-end text-xs text-muted-foreground">
                      {thread.lastMessageAt
                        ? new Date(thread.lastMessageAt).toLocaleString()
                        : null}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
