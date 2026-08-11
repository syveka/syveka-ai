import "server-only";

import type { Prisma } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { audit } from "./audit";
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
      "thread_not_found" | "message_not_found" | "not_outbound" | "requires_approval",
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
    include: { thread: { select: { id: true, organizationId: true } } },
  });
  if (!message || message.thread.organizationId !== ctx.orgId) {
    throw new InboxError("message_not_found", "Message does not belong to this organization");
  }
  return message;
}

/**
 * Simulates a message arriving on a channel. Not wired to any route in this
 * foundation slice — it's the extension point a future channel webhook
 * calls once a provider is chosen (deliberately out of scope here; picking
 * a provider is a product decision, not an engineering one). Takes a plain
 * `orgId` rather than a `TenantContext` because a webhook has no human user
 * session to derive one from.
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

  const message = await unscopedPrisma.inboxMessage.create({
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

  await db.inboxThread.update({
    where: { id: thread.id },
    data: { lastMessageAt: message.createdAt, status: "OPEN" },
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

  return { thread, message };
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
 * Marks a message sent. Actual channel dispatch (SMTP, WhatsApp Business
 * API, Twilio, ...) is intentionally not implemented here — this is the
 * extension point a future provider integration calls into once one is
 * chosen. A human-authored reply may be sent directly; an AI-generated
 * draft must go through `approveMessage` first.
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

  const sentAt = new Date();
  const [updated] = await unscopedPrisma.$transaction([
    unscopedPrisma.inboxMessage.update({
      where: { id: message.id },
      data: { status: "SENT", sentAt },
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
