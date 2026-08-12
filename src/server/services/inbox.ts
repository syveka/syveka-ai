import "server-only";

import { Prisma } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { audit } from "./audit";
import { EmailChannelError, getEmailChannelAdapter } from "@/server/channels/email";
import type { TenantContext } from "@/server/auth/session";
import type {
  AssignThreadInput,
  CreateDraftMessageInput,
  RecordInboundMessageInput,
  ThreadListQuery,
  UpdateThreadStatusInput,
} from "@/lib/validators/inbox";

export class InboxError extends Error {
  constructor(
    public readonly code:
      | "thread_not_found"
      | "message_not_found"
      | "not_outbound"
      | "requires_approval"
      | "already_sent"
      | "not_org_member"
      | "draft_generation_failed",
    message: string,
  ) {
    super(message);
    this.name = "InboxError";
  }
}

export async function listThreads(ctx: TenantContext, query: ThreadListQuery) {
  const db = tenantDb(ctx.orgId);
  const where: Prisma.InboxThreadWhereInput = {
    deletedAt: null,
    ...(query.status ? { status: query.status } : {}),
    ...(query.channel ? { channel: query.channel } : {}),
  };

  const rows = await db.inboxThread.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    include: {
      contact: { select: { id: true, firstName: true, lastName: true } },
      assignedTo: { select: { id: true, fullName: true } },
      _count: { select: { messages: true } },
    },
  });

  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1]?.id : undefined };
}

export async function getThread(ctx: TenantContext, threadId: string) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    include: {
      contact: { select: { id: true, firstName: true, lastName: true, email: true } },
      assignedTo: { select: { id: true, fullName: true } },
    },
  });
  if (!thread) return null;

  // Safe without a manual tenant check: `thread` was already resolved through
  // tenantDb above, so `thread.id` is guaranteed to belong to this org.
  const messages = await unscopedPrisma.inboxMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "asc" },
  });

  return { ...thread, messages };
}

/**
 * Unlike a message looked up by ID directly (see `requireTenantMessage`),
 * `InboxMessage` has no `organizationId` of its own (scoped via `threadId`,
 * like `Message` via `conversationId`) — this is the one place in this
 * service that must manually verify tenancy instead of relying on tenantDb.
 */
async function requireTenantMessage(ctx: TenantContext, messageId: string) {
  const message = await unscopedPrisma.inboxMessage.findFirst({
    where: { id: messageId },
    include: {
      thread: { select: { id: true, organizationId: true, channel: true, subject: true } },
    },
  });
  if (!message || message.thread.organizationId !== ctx.orgId) {
    throw new InboxError("message_not_found", "Message does not belong to this organization");
  }
  return message;
}

/** Reply-to-sender: the most recent inbound message's `fromAddress`. */
async function findEmailRecipient(threadId: string): Promise<string | null> {
  const lastInbound = await unscopedPrisma.inboxMessage.findFirst({
    where: { threadId, direction: "INBOUND", fromAddress: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { fromAddress: true },
  });
  return lastInbound?.fromAddress ?? null;
}

export class DuplicateInboundMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuplicateInboundMessageError";
  }
}

/**
 * Best-effort CRM contact match by exact email (case-insensitive), scoped to
 * the org. Read-only — never creates a contact. A sender with no matching
 * contact simply leaves the thread unlinked; a human can link one manually.
 */
async function findContactByEmail(
  db: ReturnType<typeof tenantDb>,
  email: string | undefined,
): Promise<string | null> {
  if (!email) return null;
  const contact = await db.contact.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
    select: { id: true },
  });
  return contact?.id ?? null;
}

/**
 * Simulates a message arriving on a channel. Called by the inbound-email
 * webhook (and any future channel webhook) once a provider is chosen. Takes
 * a plain `orgId` rather than a `TenantContext` because a webhook has no
 * human user session to derive one from.
 *
 * Idempotent on `input.externalId` (the provider's message id, e.g. an RFC
 * 5322 Message-ID): a webhook redelivery of the same message hits the
 * database's unique constraint on `inbox_messages.external_id` rather than
 * creating a duplicate. The redelivery is detected by catching that
 * constraint violation (concurrency-safe, unlike a check-then-insert) and
 * the existing thread + message are returned instead of running the
 * thread-update/audit side effects a second time.
 */
export async function recordInboundMessage(orgId: string, input: RecordInboundMessageInput) {
  const db = tenantDb(orgId);

  // Auto-match to an existing CRM contact by sender email when the caller
  // didn't already resolve one — never fabricates or creates a contact.
  const contactId = input.contactId ?? (await findContactByEmail(db, input.fromAddress));

  let thread = await db.inboxThread.findFirst({
    where: {
      deletedAt: null,
      channel: input.channel,
      status: { not: "CLOSED" },
      ...(contactId ? { contactId } : {}),
      ...(input.externalId ? { externalId: input.externalId } : {}),
    },
    orderBy: { lastMessageAt: "desc" },
  });

  if (!thread) {
    thread = await db.inboxThread.create({
      data: {
        organizationId: orgId,
        channel: input.channel,
        subject: input.subject ?? null,
        contactId: contactId ?? null,
        externalId: input.externalId ?? null,
      },
    });
  } else if (!thread.contactId && contactId) {
    // A later message from the same sender resolved a contact match the
    // first message couldn't (e.g. the contact was created afterwards) —
    // link it retroactively rather than leaving the thread permanently
    // unlinked.
    thread = await db.inboxThread.update({
      where: { id: thread.id },
      data: { contactId },
    });
  }

  let message;
  try {
    message = await unscopedPrisma.inboxMessage.create({
      data: {
        threadId: thread.id,
        direction: "INBOUND",
        status: "RECEIVED",
        fromAddress: input.fromAddress ?? null,
        toAddress: input.toAddress ?? null,
        body: input.body,
        externalId: input.externalId ?? null,
      },
    });
  } catch (err) {
    if (
      input.externalId &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await unscopedPrisma.inboxMessage.findFirst({
        where: { externalId: input.externalId },
        include: { thread: { select: { id: true, organizationId: true } } },
      });
      if (existing && existing.thread.organizationId === orgId) {
        const { thread: existingThread, ...existingMessage } = existing;
        return {
          thread: { ...thread, id: existingThread.id },
          message: existingMessage,
          duplicate: true as const,
        };
      }
      throw new DuplicateInboundMessageError(
        `Inbound message externalId ${input.externalId} already exists for a different organization`,
      );
    }
    throw err;
  }

  await db.inboxThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: message.createdAt, status: "OPEN", readAt: null },
  });

  await audit(
    { orgId, userId: "" },
    {
      action: "inbox.message.received",
      resourceType: "inbox_thread",
      resourceId: thread.id,
      actorType: "system",
    },
  );

  return { thread, message, duplicate: false as const };
}

/** Opening a thread marks it read. Idempotent — safe to call on every view. */
export async function markThreadRead(ctx: TenantContext, threadId: string) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, readAt: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }
  if (thread.readAt) return thread;

  return db.inboxThread.update({
    where: { id: thread.id },
    data: { readAt: new Date() },
  });
}

export async function createDraftMessage(ctx: TenantContext, input: CreateDraftMessageInput) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: input.threadId, deletedAt: null },
    select: { id: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }

  const message = await unscopedPrisma.inboxMessage.create({
    data: {
      threadId: thread.id,
      direction: "OUTBOUND",
      status: "DRAFT",
      body: input.body,
      aiGenerated: input.aiGenerated,
    },
  });

  await audit(ctx, {
    action: "inbox.message.drafted",
    resourceType: "inbox_message",
    resourceId: message.id,
    after: { threadId: thread.id, aiGenerated: input.aiGenerated },
  });

  return message;
}

/** Required before `sendMessage` will send an AI-generated draft. */
export async function approveMessage(ctx: TenantContext, messageId: string) {
  const message = await requireTenantMessage(ctx, messageId);
  if (message.direction !== "OUTBOUND") {
    throw new InboxError("not_outbound", "Only outbound messages can be approved");
  }

  const updated = await unscopedPrisma.inboxMessage.update({
    where: { id: message.id },
    data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date() },
  });

  await audit(ctx, {
    action: "inbox.message.approved",
    resourceType: "inbox_message",
    resourceId: message.id,
  });

  return updated;
}

/**
 * Marks a message sent, dispatching it through the channel adapter first.
 * Other channels (SMS, WhatsApp, web chat) have no adapter yet — those
 * threads are marked sent without dispatch until a provider is chosen for
 * them. A human-authored reply may be sent directly; an AI-generated draft
 * must go through `approveMessage` first.
 */
export async function sendMessage(ctx: TenantContext, messageId: string) {
  const message = await requireTenantMessage(ctx, messageId);
  if (message.direction !== "OUTBOUND") {
    throw new InboxError("not_outbound", "Only outbound messages can be sent");
  }
  if (message.status === "SENT") {
    throw new InboxError("already_sent", "This message has already been sent");
  }
  if (message.aiGenerated && !message.approvedAt) {
    throw new InboxError(
      "requires_approval",
      "AI-generated messages must be approved before sending",
    );
  }

  const sentAt = new Date();
  // Atomic claim BEFORE dispatch: a compare-and-swap on the exact status
  // just read. Two concurrent sendMessage calls (double form submit, a
  // retried request) can both pass the checks above, but only one can win
  // this conditional update — the loser sees count === 0 and never
  // dispatches, closing the race a simple pre-check would miss.
  const claim = await unscopedPrisma.inboxMessage.updateMany({
    where: { id: message.id, status: message.status },
    data: { status: "SENT", sentAt },
  });
  if (claim.count === 0) {
    throw new InboxError("already_sent", "This message has already been sent");
  }

  let externalId: string | null = null;
  if (message.thread.channel === "EMAIL") {
    const to = message.toAddress ?? (await findEmailRecipient(message.threadId));
    if (!to) {
      await unscopedPrisma.inboxMessage.update({
        where: { id: message.id },
        data: { status: "FAILED" },
      });
      throw new InboxError("not_outbound", "No recipient address found for this thread's reply");
    }
    try {
      const subject = message.thread.subject
        ? message.thread.subject.startsWith("Re:")
          ? message.thread.subject
          : `Re: ${message.thread.subject}`
        : "Re: your message";
      const sent = await getEmailChannelAdapter().send({
        to,
        subject,
        text: message.body,
        inReplyToExternalId: message.externalId ?? undefined,
      });
      externalId = sent.externalId;
    } catch (err) {
      await unscopedPrisma.inboxMessage.update({
        where: { id: message.id },
        data: { status: "FAILED" },
      });
      await audit(ctx, {
        action: "inbox.message.send_failed",
        resourceType: "inbox_message",
        resourceId: message.id,
        after: { code: err instanceof EmailChannelError ? err.code : "unknown" },
      });
      throw err;
    }
  }

  const [updated] = await unscopedPrisma.$transaction([
    unscopedPrisma.inboxMessage.update({
      where: { id: message.id },
      data: externalId ? { externalId } : {},
    }),
    unscopedPrisma.inboxThread.update({
      where: { id: message.threadId },
      data: { lastMessageAt: sentAt },
    }),
  ]);

  await audit(ctx, {
    action: "inbox.message.sent",
    resourceType: "inbox_message",
    resourceId: message.id,
  });

  return updated;
}

export async function updateThreadStatus(
  ctx: TenantContext,
  threadId: string,
  input: UpdateThreadStatusInput,
) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }

  const updated = await db.inboxThread.update({
    where: { id: thread.id },
    data: { status: input.status },
  });

  await audit(ctx, {
    action: "inbox.thread.status_changed",
    resourceType: "inbox_thread",
    resourceId: thread.id,
    before: { status: thread.status },
    after: { status: input.status },
  });

  return updated;
}

/** Assignable operators = members of the organization (mirrors listOwnerOptions in deals.ts). */
export async function listAssignableMembers(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  const members = await db.organizationMember.findMany({
    include: { user: { select: { id: true, fullName: true, email: true } } },
    orderBy: { joinedAt: "asc" },
    take: 500,
  });
  return members.map((m) => ({
    id: m.user.id,
    name: m.user.fullName ?? m.user.email,
  }));
}

export async function assignThread(ctx: TenantContext, threadId: string, input: AssignThreadInput) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, assignedToId: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }

  // Never trust a browser-supplied user id: a thread can only be assigned
  // to someone who is actually a member of this organization.
  if (input.assignedToId) {
    const member = await db.organizationMember.findFirst({
      where: { userId: input.assignedToId },
      select: { id: true },
    });
    if (!member) {
      throw new InboxError("not_org_member", "assignedToId is not a member of this organization");
    }
  }

  const updated = await db.inboxThread.update({
    where: { id: thread.id },
    data: { assignedToId: input.assignedToId ?? null },
  });

  await audit(ctx, {
    action: "inbox.thread.assigned",
    resourceType: "inbox_thread",
    resourceId: thread.id,
    before: { assignedToId: thread.assignedToId },
    after: { assignedToId: input.assignedToId ?? null },
  });

  return updated;
}
