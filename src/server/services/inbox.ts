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

  let thread = await db.inboxThread.findFirst({
    where: {
      deletedAt: null,
      channel: input.channel,
      status: { not: "CLOSED" },
      ...(input.contactId ? { contactId: input.contactId } : {}),
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
        contactId: input.contactId ?? null,
        externalId: input.externalId ?? null,
      },
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
  if (message.aiGenerated && !message.approvedAt) {
    throw new InboxError(
      "requires_approval",
      "AI-generated messages must be approved before sending",
    );
  }

  let externalId: string | null = null;
  if (message.thread.channel === "EMAIL") {
    const to = message.toAddress ?? (await findEmailRecipient(message.threadId));
    if (!to) {
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

  const sentAt = new Date();
  const [updated] = await unscopedPrisma.$transaction([
    unscopedPrisma.inboxMessage.update({
      where: { id: message.id },
      data: { status: "SENT", sentAt, ...(externalId ? { externalId } : {}) },
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

export async function assignThread(ctx: TenantContext, threadId: string, input: AssignThreadInput) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, assignedToId: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
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
