export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getThread, markThreadRead } from "@/server/services/inbox";
import { approveMessageAction, generateDraftAction, sendMessageAction } from "@/actions/inbox";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ReplyForm } from "./reply-form";

const MESSAGE_BADGE_KEY: Record<string, string> = {
  DRAFT: "draftBadge",
  SENT: "sentBadge",
  FAILED: "failedBadge",
};

export default async function InboxThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = await params;
  const ctx = await requirePermission("inbox:read");
  const t = await getTranslations("inbox");
  const thread = await getThread(ctx, threadId);
  if (!thread) notFound();
  await markThreadRead(ctx, threadId);

  const canWrite = can(ctx.role, "inbox:write");
  const canApprove = can(ctx.role, "inbox:approve");
  const contactName = thread.contact
    ? [thread.contact.firstName, thread.contact.lastName].filter(Boolean).join(" ")
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link href="/inbox" className="text-sm text-muted-foreground hover:underline">
          {t("detail.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{thread.subject || t("noSubject")}</h1>
        <p className="text-sm text-muted-foreground">
          {t(`channel.${thread.channel}`)}
          {contactName ? ` · ${contactName}` : ""}
          {thread.contact?.email ? ` · ${thread.contact.email}` : ""}
        </p>
      </div>

      <div className="space-y-3">
        {thread.messages.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              {t("detail.noMessages")}
            </CardContent>
          </Card>
        ) : (
          thread.messages.map((message) => {
            const isInbound = message.direction === "INBOUND";
            const needsApproval = message.aiGenerated && !message.approvedAt;
            return (
              <div
                key={message.id}
                className={isInbound ? "flex justify-start" : "flex justify-end"}
              >
                <div className="max-w-[85%] space-y-2">
                  <Card className={isInbound ? "" : "bg-primary/5"}>
                    <CardContent className="space-y-2 p-4">
                      <p className="whitespace-pre-wrap text-sm">{message.body}</p>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {message.aiGenerated ? (
                          <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground">
                            {needsApproval ? t("detail.aiDraftBadge") : t("detail.aiApprovedBadge")}
                          </span>
                        ) : !isInbound && message.status !== "SENT" ? (
                          <span className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground">
                            {t(`detail.${MESSAGE_BADGE_KEY[message.status] ?? "draftBadge"}`)}
                          </span>
                        ) : null}
                        {message.status === "FAILED" ? (
                          <span className="text-destructive">{t("detail.failedBadge")}</span>
                        ) : null}
                        <span>{new Date(message.createdAt).toLocaleString()}</span>
                      </div>
                    </CardContent>
                  </Card>
                  {!isInbound && message.status !== "SENT" ? (
                    <div className="flex justify-end gap-2">
                      {needsApproval && canApprove ? (
                        <form action={approveMessageAction.bind(null, message.id)}>
                          <Button type="submit" size="sm" variant="outline">
                            {t("detail.approve")}
                          </Button>
                        </form>
                      ) : null}
                      {canWrite && !needsApproval ? (
                        <form action={sendMessageAction.bind(null, message.id)}>
                          <Button type="submit" size="sm">
                            {t("detail.send")}
                          </Button>
                        </form>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>

      {canWrite ? (
        <div className="space-y-3 border-t pt-4">
          <form action={generateDraftAction.bind(null, thread.id)}>
            <Button type="submit" variant="outline">
              {t("detail.generateDraft")}
            </Button>
          </form>
          <ReplyForm threadId={thread.id} />
        </div>
      ) : null}
    </div>
  );
}
