export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import { getThread, listAssignableMembers, markThreadRead } from "@/server/services/inbox";
import { listBookingTypes } from "@/server/services/booking";
import { approveMessageAction, markThreadUnreadAction, sendMessageAction } from "@/actions/inbox";
import { tenantDb } from "@/server/db/tenant";
import { clientEnv } from "@/env";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ReplyForm } from "./reply-form";
import { AssignmentControls } from "./assignment-controls";
import { StatusControls } from "./status-controls";
import { GenerateDraftButton } from "./generate-draft-button";
import { DraftMessageBody } from "./draft-message-body";
import { CreateContactFromThread } from "./create-contact-from-thread";
import { LinkExistingContact } from "./link-existing-contact";

const MESSAGE_BADGE_KEY: Record<string, string> = {
  DRAFT: "draftBadge",
  SENT: "sentBadge",
  FAILED: "failedBadge",
};

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-primary/10 text-primary",
  PENDING: "bg-amber-500/10 text-amber-600",
  CLOSED: "bg-muted text-muted-foreground",
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
  const canCreateContact = canWrite && can(ctx.role, "crm:write");
  const canLinkContact = canWrite && can(ctx.role, "crm:read");
  const canInsertBookingLink = canWrite && can(ctx.role, "booking:manage");
  const members = canWrite ? await listAssignableMembers(ctx) : [];
  const [bookingTypes, org] = canInsertBookingLink
    ? await Promise.all([
        listBookingTypes(ctx),
        tenantDb(ctx.orgId).organization.findFirst({
          where: { id: ctx.orgId },
          select: { slug: true },
        }),
      ])
    : [[], null];
  const activeBookingTypes = bookingTypes
    .filter((bt) => bt.isActive)
    .map((bt) => ({ slug: bt.slug, name: bt.name }));
  const bookingBaseUrl = `${clientEnv.NEXT_PUBLIC_APP_URL}/book/${org?.slug ?? ""}`;
  const contactName = thread.contact
    ? [thread.contact.firstName, thread.contact.lastName].filter(Boolean).join(" ")
    : null;
  const assigneeName = thread.assignedTo?.fullName ?? null;
  const hasUnsentDraft = thread.messages.some(
    (m) => m.direction === "OUTBOUND" && m.aiGenerated && m.status !== "SENT",
  );

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link href="/inbox" className="text-sm text-muted-foreground hover:underline">
          {t("detail.back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{thread.subject || t("noSubject")}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              STATUS_STYLES[thread.status] ?? STATUS_STYLES.OPEN
            }`}
          >
            {t(`status.${thread.status}`)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(`channel.${thread.channel}`)}
          {thread.contact ? (
            <>
              {" · "}
              <Link href={`/crm/contacts/${thread.contact.id}`} className="hover:underline">
                {contactName || thread.contact.email}
              </Link>
              {contactName && thread.contact.email ? ` · ${thread.contact.email}` : ""}
            </>
          ) : null}
        </p>
        {!thread.contact && canCreateContact ? (
          <CreateContactFromThread threadId={thread.id} />
        ) : null}
        {!thread.contact && canLinkContact ? <LinkExistingContact threadId={thread.id} /> : null}
        {thread.upcomingBooking ? (
          <p className="text-sm text-muted-foreground">
            {t("detail.upcomingBooking", {
              type: thread.upcomingBooking.typeName,
              date: new Date(thread.upcomingBooking.startsAt).toLocaleString(),
            })}
          </p>
        ) : null}
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-4 pt-1">
            <StatusControls threadId={thread.id} status={thread.status} />
            <AssignmentControls
              threadId={thread.id}
              assignedToId={thread.assignedToId}
              currentUserId={ctx.userId}
              members={members}
            />
            <form action={markThreadUnreadAction.bind(null, thread.id)}>
              <Button type="submit" size="sm" variant="ghost">
                {t("detail.markUnread")}
              </Button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {assigneeName ? t("detail.assignedTo", { name: assigneeName }) : t("detail.unassigned")}
          </p>
        )}
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
                      {canWrite && !isInbound && message.status !== "SENT" ? (
                        <DraftMessageBody
                          messageId={message.id}
                          body={message.body}
                          bookingTypes={activeBookingTypes}
                          bookingBaseUrl={bookingBaseUrl}
                        />
                      ) : (
                        <p className="whitespace-pre-wrap text-sm">{message.body}</p>
                      )}
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
          <GenerateDraftButton threadId={thread.id} hasUnsentDraft={hasUnsentDraft} />
          <ReplyForm
            threadId={thread.id}
            bookingTypes={activeBookingTypes}
            bookingBaseUrl={bookingBaseUrl}
          />
        </div>
      ) : null}
    </div>
  );
}
