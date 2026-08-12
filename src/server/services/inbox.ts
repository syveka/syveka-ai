import "server-only";

import { Prisma } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { audit } from "./audit";
import { createContact, listContacts } from "./contacts";
import { EmailChannelError } from "@/server/channels/email";
import { getChannelAdapter } from "@/server/channels/registry";
import type { TenantContext } from "@/server/auth/session";
import type {
  AssignThreadInput,
  CreateContactFromThreadInput,
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
      | "draft_generation_failed"
      | "already_linked"
      | "no_sender_address"
      | "contact_not_found",
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

/**
 * Read-only, display-only lookup of the linked contact's next confirmed
 * booking — mirrors the lookup `inbox-ai.ts` uses internally to give AI
 * drafts booking context, kept as a separate copy rather than shared so the
 * UI-display concern here and the AI-prompt concern there stay decoupled.
 */
async function findUpcomingBookingContext(
  db: ReturnType<typeof tenantDb>,
  guestEmail: string | undefined,
): Promise<{ typeName: string; startsAt: Date } | null> {
  if (!guestEmail) return null;
  const booking = await db.booking.findFirst({
    where: {
      guestEmail: { equals: guestEmail, mode: "insensitive" },
      status: "CONFIRMED",
      startsAt: { gte: new Date() },
    },
    orderBy: { startsAt: "asc" },
    select: { startsAt: true, bookingType: { select: { name: true } } },
  });
  return booking ? { typeName: booking.bookingType.name, startsAt: booking.startsAt } : null;
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
  const [messages, upcomingBooking] = await Promise.all([
    unscopedPrisma.inboxMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "asc" },
    }),
    findUpcomingBookingContext(db, thread.contact?.email ?? undefined),
  ]);

  return { ...thread, messages, upcomingBooking };
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

/**
 * Reply-to-sender: the most recent inbound message's `fromAddress`.
 * Channel-agnostic — works for an email address, phone number, or chat
 * session id alike.
 */
async function findLastInboundFromAddress(threadId: string): Promise<string | null> {
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

  const updated = await db.inboxThread.update({
    where: { id: thread.id },
    data: { readAt: new Date() },
  });

  await audit(ctx, {
    action: "inbox.thread.read",
    resourceType: "inbox_thread",
    resourceId: thread.id,
  });

  return updated;
}

/**
 * Explicit "mark as unread" — an operator flagging a thread for follow-up
 * after already reading it. Opening the thread again re-marks it read (see
 * `markThreadRead`), matching common inbox UX.
 */
export async function markThreadUnread(ctx: TenantContext, threadId: string) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }

  const updated = await db.inboxThread.update({
    where: { id: thread.id },
    data: { readAt: null },
  });

  await audit(ctx, {
    action: "inbox.thread.unread",
    resourceType: "inbox_thread",
    resourceId: thread.id,
  });

  return updated;
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

/**
 * Creates a new AI draft, or — when an unsent AI draft already exists for
 * this thread — replaces it in place ("regenerate") instead of
 * accumulating duplicate drafts an operator would have to sort through.
 * Regenerating always resets status to DRAFT and clears any prior
 * approval, since the previously-approved text no longer exists.
 */
export async function upsertAiDraftMessage(ctx: TenantContext, threadId: string, body: string) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }

  const existingDraft = await unscopedPrisma.inboxMessage.findFirst({
    where: {
      threadId: thread.id,
      direction: "OUTBOUND",
      aiGenerated: true,
      status: { not: "SENT" },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existingDraft) {
    const updated = await unscopedPrisma.inboxMessage.update({
      where: { id: existingDraft.id },
      data: { body, status: "DRAFT", approvedAt: null, approvedById: null },
    });
    await audit(ctx, {
      action: "inbox.message.drafted",
      resourceType: "inbox_message",
      resourceId: updated.id,
      after: { threadId: thread.id, aiGenerated: true, regenerated: true },
    });
    return updated;
  }

  return createDraftMessage(ctx, { threadId: thread.id, body, aiGenerated: true });
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
 * Edits an unsent outbound message's body. Always resets status to DRAFT
 * and clears any prior approval — a human approved specific text, not
 * "whatever this message currently says", so an edited AI-generated draft
 * must be re-approved before it can be sent.
 */
export async function editDraftMessage(ctx: TenantContext, messageId: string, body: string) {
  const message = await requireTenantMessage(ctx, messageId);
  if (message.direction !== "OUTBOUND") {
    throw new InboxError("not_outbound", "Only outbound messages can be edited");
  }
  if (message.status === "SENT") {
    throw new InboxError("already_sent", "Sent messages cannot be edited");
  }

  const updated = await unscopedPrisma.inboxMessage.update({
    where: { id: message.id },
    data: { body, status: "DRAFT", approvedAt: null, approvedById: null },
  });

  await audit(ctx, {
    action: "inbox.message.drafted",
    resourceType: "inbox_message",
    resourceId: message.id,
    after: { edited: true },
  });

  return updated;
}

/**
 * Marks a message sent, dispatching it through the thread channel's adapter
 * first (`getChannelAdapter`). Channels with no adapter registered yet (SMS,
 * WhatsApp, web chat) return `null` — those threads are marked sent without
 * dispatch until a provider is wired up for them. A human-authored reply may
 * be sent directly; an AI-generated draft must go through `approveMessage`
 * first.
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
  const adapter = getChannelAdapter(message.thread.channel);
  if (adapter) {
    const to = message.toAddress ?? (await findLastInboundFromAddress(message.threadId));
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
      const sent = await adapter.send({
        to,
        subject,
        body: message.body,
        replyToExternalId: message.externalId ?? undefined,
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

/**
 * Explicit operator action for the case the read-only exact-email auto-match
 * (`findContactByEmail`, run at inbound-message time) found nothing: creates
 * a new CRM contact from the thread's sender address and links it. Never
 * runs automatically — only ever in response to a deliberate operator
 * click, so a spam or unknown sender never silently becomes a CRM contact.
 * Reuses `createContact` (entitlement check, audit log) rather than a
 * parallel contact-creation path.
 */
export async function createContactFromThread(
  ctx: TenantContext,
  threadId: string,
  input: CreateContactFromThreadInput,
) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, contactId: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }
  if (thread.contactId) {
    throw new InboxError("already_linked", "This thread is already linked to a contact");
  }

  const email = await findLastInboundFromAddress(threadId);
  if (!email) {
    throw new InboxError("no_sender_address", "This thread has no inbound sender address to link");
  }

  const contact = await createContact(ctx, {
    firstName: input.firstName,
    lastName: input.lastName,
    email,
    status: "LEAD",
    gdprConsent: false,
  });

  const updated = await db.inboxThread.update({
    where: { id: thread.id },
    data: { contactId: contact.id },
  });

  await audit(ctx, {
    action: "inbox.thread.contact_linked",
    resourceType: "inbox_thread",
    resourceId: thread.id,
    after: { contactId: contact.id, source: "operator_created" },
  });

  return { thread: updated, contact };
}

/**
 * Explicit operator action linking a thread to an already-existing CRM
 * contact — the counterpart to `createContactFromThread` for the case the
 * customer is already a known contact under a different address than the
 * one auto-match compares against. `contact.findFirst` runs through
 * `tenantDb`, so a contact id from another organization simply doesn't
 * resolve (`contact_not_found`) rather than ever cross-tenant linking.
 */
export async function linkThreadToContact(ctx: TenantContext, threadId: string, contactId: string) {
  const db = tenantDb(ctx.orgId);
  const thread = await db.inboxThread.findFirst({
    where: { id: threadId, deletedAt: null },
    select: { id: true, contactId: true },
  });
  if (!thread) {
    throw new InboxError("thread_not_found", "Thread does not belong to this organization");
  }
  if (thread.contactId) {
    throw new InboxError("already_linked", "This thread is already linked to a contact");
  }

  const contact = await db.contact.findFirst({
    where: { id: contactId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true },
  });
  if (!contact) {
    throw new InboxError("contact_not_found", "Contact does not belong to this organization");
  }

  const updated = await db.inboxThread.update({
    where: { id: thread.id },
    data: { contactId: contact.id },
  });

  await audit(ctx, {
    action: "inbox.thread.contact_linked",
    resourceType: "inbox_thread",
    resourceId: thread.id,
    after: { contactId: contact.id, source: "operator_selected" },
  });

  return { thread: updated, contact };
}

/**
 * Read-only contact search for the thread-linking UI — thin wrapper over
 * `listContacts` returning just the fields the picker needs. Tenant-scoped
 * via `listContacts`'s own `tenantDb` usage.
 */
export async function searchContactsForLink(ctx: TenantContext, query: string) {
  const { data } = await listContacts(ctx, {
    q: query,
    limit: 5,
    archived: "active",
  });
  return data.map((c) => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || c.id,
    email: c.email,
  }));
}
