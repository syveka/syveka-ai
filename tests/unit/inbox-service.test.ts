import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const {
  tenantDbMock,
  unscopedMock,
  auditMock,
  emailAdapterMock,
  EmailChannelErrorMock,
  createContactMock,
} = vi.hoisted(() => {
  class EmailChannelErrorMock extends Error {
    constructor(
      message: string,
      public readonly code: string,
      public readonly retryable = false,
    ) {
      super(message);
      this.name = "EmailChannelError";
    }
  }
  return {
    tenantDbMock: vi.fn(),
    unscopedMock: {
      inboxMessage: {
        create: vi.fn(),
        findMany: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      inboxThread: {
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    },
    auditMock: vi.fn(async () => undefined),
    emailAdapterMock: { send: vi.fn(async () => ({ externalId: "ext-sent-1" })) },
    EmailChannelErrorMock,
    createContactMock: vi.fn(async (_ctx: unknown, input: { firstName: string }) => ({
      id: "new-contact-1",
      firstName: input.firstName,
    })),
  };
});

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: unscopedMock,
}));

vi.mock("@/server/services/audit", () => ({
  audit: auditMock,
}));

vi.mock("@/server/channels/email", () => ({
  getEmailChannelAdapter: () => emailAdapterMock,
  EmailChannelError: EmailChannelErrorMock,
}));

vi.mock("@/server/services/contacts", () => ({
  createContact: createContactMock,
}));

import { Prisma } from "@prisma/client";
import {
  approveMessage,
  assignThread,
  createContactFromThread,
  createDraftMessage,
  DuplicateInboundMessageError,
  editDraftMessage,
  getThread,
  InboxError,
  listAssignableMembers,
  listThreads,
  markThreadRead,
  markThreadUnread,
  recordInboundMessage,
  sendMessage,
  updateThreadStatus,
  upsertAiDraftMessage,
} from "@/server/services/inbox";

function uniqueConstraintError(target: string) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: [target] },
  });
}

function ctx(orgId = "org-a", userId = "user-1"): TenantContext {
  return { userId, email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

type QueryArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  include?: Record<string, unknown>;
  select?: Record<string, unknown>;
  take?: number;
  skip?: number;
  cursor?: { id: string };
  orderBy?: unknown;
};

type ThreadRow = {
  id: string;
  organizationId: string;
  channel: string;
  status: string;
  contactId: string | null;
  assignedToId: string | null;
  externalId: string | null;
  lastMessageAt: Date | null;
  deletedAt: Date | null;
  [extra: string]: unknown;
};

function threadRow(id: string, orgId: string, overrides: Record<string, unknown> = {}): ThreadRow {
  return {
    id,
    organizationId: orgId,
    channel: "EMAIL",
    status: "OPEN",
    contactId: null,
    assignedToId: null,
    externalId: null,
    lastMessageAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function createMockDb(orgId: string) {
  return {
    inboxThread: {
      findMany: vi.fn(async (_args: QueryArgs) => [threadRow(`${orgId}-t1`, orgId)]),
      findFirst: vi.fn(
        async (_args: QueryArgs) => threadRow(`${orgId}-t1`, orgId) as ThreadRow | null,
      ),
      create: vi.fn(async ({ data }: QueryArgs) => threadRow("new-thread", orgId, data)),
      update: vi.fn(async ({ data }: QueryArgs) => threadRow(`${orgId}-t1`, orgId, data)),
    },
    contact: {
      findFirst: vi.fn(async (_args: QueryArgs) => null as { id: string } | null),
    },
    booking: {
      findFirst: vi.fn(
        async (_args: QueryArgs) =>
          null as { startsAt: Date; bookingType: { name: string } } | null,
      ),
    },
    organizationMember: {
      findFirst: vi.fn(async (_args: QueryArgs) => ({ id: "member-1" }) as { id: string } | null),
      findMany: vi.fn(async (_args: QueryArgs) => [
        { user: { id: "user-1", fullName: "Ada Lovelace", email: "ada@example.com" } },
        { user: { id: "user-2", fullName: null, email: "no-name@example.com" } },
      ]),
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

describe("inbox service", () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb("org-a");
    tenantDbMock.mockReturnValue(db);
    unscopedMock.inboxMessage.create.mockImplementation(async ({ data }: QueryArgs) => ({
      id: "msg-1",
      status: data.status,
      direction: data.direction,
      aiGenerated: data.aiGenerated ?? false,
      approvedAt: null,
      threadId: data.threadId,
      ...data,
    }));
    unscopedMock.inboxMessage.update.mockImplementation(async ({ data }: QueryArgs) => ({
      id: "msg-1",
      ...data,
    }));
    unscopedMock.inboxMessage.updateMany.mockResolvedValue({ count: 1 });
    unscopedMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
  });

  describe("listThreads", () => {
    it("scopes the query to the caller's tenant", async () => {
      await listThreads(ctx("org-a"), { limit: 25 });
      expect(tenantDbMock).toHaveBeenCalledWith("org-a");
      const args = db.inboxThread.findMany.mock.calls[0]![0]!;
      expect(args.where).toMatchObject({ deletedAt: null });
    });

    it("applies status and channel filters", async () => {
      await listThreads(ctx(), { status: "OPEN", channel: "WHATSAPP", limit: 25 });
      const args = db.inboxThread.findMany.mock.calls[0]![0]!;
      expect(args.where).toMatchObject({ status: "OPEN", channel: "WHATSAPP" });
    });

    it("uses the caller's org for every operation (tenant isolation)", async () => {
      const dbB = createMockDb("org-b");
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      const result = await listThreads(ctx("org-b"), { limit: 25 });

      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
      expect(result.data[0]?.id).toBe("org-b-t1");
      expect(db.inboxThread.findMany).not.toHaveBeenCalled();
    });
  });

  describe("getThread", () => {
    it("returns null when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      const result = await getThread(ctx(), "missing-thread");
      expect(result).toBeNull();
      expect(unscopedMock.inboxMessage.findMany).not.toHaveBeenCalled();
    });

    it("fetches messages only after the thread is confirmed tenant-scoped", async () => {
      unscopedMock.inboxMessage.findMany.mockResolvedValueOnce([{ id: "m1" }]);
      const result = await getThread(ctx("org-a"), "org-a-t1");
      expect(db.inboxThread.findFirst).toHaveBeenCalled();
      expect(unscopedMock.inboxMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { threadId: "org-a-t1" } }),
      );
      expect(result?.messages).toEqual([{ id: "m1" }]);
    });

    it("returns null upcomingBooking when the thread has no linked contact", async () => {
      const result = await getThread(ctx("org-a"), "org-a-t1");
      expect(db.booking.findFirst).not.toHaveBeenCalled();
      expect(result?.upcomingBooking).toBeNull();
    });

    it("includes the contact's next confirmed upcoming booking for display", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { contact: { email: "jane@example.com" } }),
      );
      db.booking.findFirst.mockResolvedValueOnce({
        startsAt: new Date("2026-09-01T10:00:00.000Z"),
        bookingType: { name: "Consultation" },
      });

      const result = await getThread(ctx("org-a"), "org-a-t1");

      expect(db.booking.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            guestEmail: { equals: "jane@example.com", mode: "insensitive" },
            status: "CONFIRMED",
          }),
        }),
      );
      expect(result?.upcomingBooking).toEqual({
        typeName: "Consultation",
        startsAt: new Date("2026-09-01T10:00:00.000Z"),
      });
    });
  });

  describe("recordInboundMessage", () => {
    it("creates a new thread when none matches and reopens it as OPEN", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await recordInboundMessage("org-a", { channel: "EMAIL", body: "Hi there" });

      expect(db.inboxThread.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ organizationId: "org-a" }) }),
      );
      expect(unscopedMock.inboxMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ direction: "INBOUND", status: "RECEIVED" }),
        }),
      );
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "OPEN" }) }),
      );
    });

    it("auto-matches an existing CRM contact by sender email when no contactId is given", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      db.contact.findFirst.mockResolvedValueOnce({ id: "contact-42" });

      await recordInboundMessage("org-a", {
        channel: "EMAIL",
        fromAddress: "jane@example.com",
        body: "Hi there",
      });

      expect(db.contact.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            email: { equals: "jane@example.com", mode: "insensitive" },
          }),
        }),
      );
      expect(db.inboxThread.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ contactId: "contact-42" }) }),
      );
    });

    it("leaves the thread unlinked when no CRM contact matches the sender email", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      db.contact.findFirst.mockResolvedValueOnce(null);

      await recordInboundMessage("org-a", {
        channel: "EMAIL",
        fromAddress: "stranger@example.com",
        body: "Hi there",
      });

      expect(db.inboxThread.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ contactId: null }) }),
      );
    });

    it("does not query for a contact match when fromAddress is absent", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await recordInboundMessage("org-a", { channel: "SMS", body: "Hi there" });
      expect(db.contact.findFirst).not.toHaveBeenCalled();
    });

    it("prefers an explicitly given contactId over email auto-matching", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await recordInboundMessage("org-a", {
        channel: "EMAIL",
        contactId: "explicit-contact",
        fromAddress: "jane@example.com",
        body: "Hi there",
      });
      expect(db.contact.findFirst).not.toHaveBeenCalled();
      expect(db.inboxThread.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contactId: "explicit-contact" }),
        }),
      );
    });

    it("retroactively links an existing unlinked thread when a later message's sender now matches a contact", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { contactId: null }),
      );
      db.contact.findFirst.mockResolvedValueOnce({ id: "contact-42" });

      await recordInboundMessage("org-a", {
        channel: "EMAIL",
        fromAddress: "jane@example.com",
        body: "Follow-up",
      });

      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { contactId: "contact-42" } }),
      );
    });

    it("does not re-link a thread that already has a contact", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { contactId: "existing-contact" }),
      );
      db.contact.findFirst.mockResolvedValueOnce({ id: "different-contact" });

      await recordInboundMessage("org-a", {
        channel: "EMAIL",
        fromAddress: "jane@example.com",
        body: "Follow-up",
      });

      // Only the readAt/lastMessageAt/status update should have happened —
      // never an update that overwrites an already-linked contactId.
      for (const call of db.inboxThread.update.mock.calls) {
        expect((call[0] as QueryArgs).data).not.toHaveProperty("contactId");
      }
    });

    it("reuses an existing matching thread instead of creating a new one", async () => {
      await recordInboundMessage("org-a", {
        channel: "EMAIL",
        contactId: "11111111-1111-4111-8111-111111111111",
        body: "Follow-up",
      });
      expect(db.inboxThread.create).not.toHaveBeenCalled();
      expect(db.inboxThread.update).toHaveBeenCalled();
    });

    it("audits with a system actor, not a real user", async () => {
      await recordInboundMessage("org-a", { channel: "SMS", body: "Hi" });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({ action: "inbox.message.received", actorType: "system" }),
      );
    });

    it("resets the thread to unread (readAt: null) when a new inbound message arrives", async () => {
      await recordInboundMessage("org-a", { channel: "EMAIL", body: "Hi there" });
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ readAt: null }) }),
      );
    });

    it("is idempotent on a webhook redelivery: returns the existing message instead of erroring", async () => {
      unscopedMock.inboxMessage.create.mockRejectedValueOnce(
        uniqueConstraintError("inbox_messages_external_id_key"),
      );
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "existing-msg",
        threadId: "org-a-t1",
        externalId: "ext-1",
        thread: { id: "org-a-t1", organizationId: "org-a" },
      });

      const result = await recordInboundMessage("org-a", {
        channel: "EMAIL",
        body: "Hi there",
        externalId: "ext-1",
      });

      expect(result.duplicate).toBe(true);
      expect(result.message).toMatchObject({ id: "existing-msg" });
      // No second thread-status update or audit entry for the redelivery.
      expect(db.inboxThread.update).not.toHaveBeenCalled();
      expect(auditMock).not.toHaveBeenCalled();
    });

    it("rejects a cross-organization externalId collision instead of returning another tenant's message", async () => {
      unscopedMock.inboxMessage.create.mockRejectedValueOnce(
        uniqueConstraintError("inbox_messages_external_id_key"),
      );
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "other-org-msg",
        threadId: "org-b-t1",
        externalId: "ext-1",
        thread: { id: "org-b-t1", organizationId: "org-b" },
      });

      await expect(
        recordInboundMessage("org-a", { channel: "EMAIL", body: "Hi there", externalId: "ext-1" }),
      ).rejects.toBeInstanceOf(DuplicateInboundMessageError);
    });

    it("does not swallow unrelated database errors", async () => {
      unscopedMock.inboxMessage.create.mockRejectedValueOnce(new Error("connection reset"));
      await expect(
        recordInboundMessage("org-a", { channel: "EMAIL", body: "Hi there" }),
      ).rejects.toThrow("connection reset");
    });
  });

  describe("markThreadRead", () => {
    it("throws when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await expect(markThreadRead(ctx(), "missing")).rejects.toBeInstanceOf(InboxError);
    });

    it("stamps readAt when the thread is unread", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { readAt: null }),
      );
      await markThreadRead(ctx("org-a"), "org-a-t1");
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { readAt: expect.any(Date) } }),
      );
    });

    it("is a no-op when the thread is already read", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { readAt: new Date() }),
      );
      await markThreadRead(ctx("org-a"), "org-a-t1");
      expect(db.inboxThread.update).not.toHaveBeenCalled();
    });

    it("uses the caller's org for tenant verification (tenant isolation)", async () => {
      const dbB = createMockDb("org-b");
      dbB.inboxThread.findFirst.mockResolvedValueOnce(null);
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      await expect(markThreadRead(ctx("org-b"), "org-a-t1")).rejects.toBeInstanceOf(InboxError);
      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    });
  });

  describe("markThreadUnread", () => {
    it("throws when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await expect(markThreadUnread(ctx(), "missing")).rejects.toBeInstanceOf(InboxError);
    });

    it("clears readAt even when the thread is already unread", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { readAt: null }),
      );
      await markThreadUnread(ctx("org-a"), "org-a-t1");
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { readAt: null } }),
      );
    });

    it("uses the caller's org for tenant verification (tenant isolation)", async () => {
      const dbB = createMockDb("org-b");
      dbB.inboxThread.findFirst.mockResolvedValueOnce(null);
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      await expect(markThreadUnread(ctx("org-b"), "org-a-t1")).rejects.toBeInstanceOf(InboxError);
      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    });
  });

  describe("createDraftMessage", () => {
    it("throws when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await expect(
        createDraftMessage(ctx(), { threadId: "nope", body: "Hi", aiGenerated: false }),
      ).rejects.toBeInstanceOf(InboxError);
      expect(unscopedMock.inboxMessage.create).not.toHaveBeenCalled();
    });

    it("creates an OUTBOUND DRAFT message", async () => {
      await createDraftMessage(ctx("org-a"), {
        threadId: "org-a-t1",
        body: "Thanks!",
        aiGenerated: true,
      });
      expect(unscopedMock.inboxMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: "OUTBOUND",
            status: "DRAFT",
            aiGenerated: true,
          }),
        }),
      );
    });
  });

  describe("upsertAiDraftMessage", () => {
    it("throws when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await expect(upsertAiDraftMessage(ctx(), "missing", "Hi")).rejects.toBeInstanceOf(InboxError);
    });

    it("creates a new AI draft when none exists yet", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce(null);
      await upsertAiDraftMessage(ctx("org-a"), "org-a-t1", "Hello there");
      expect(unscopedMock.inboxMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: "OUTBOUND",
            status: "DRAFT",
            aiGenerated: true,
            body: "Hello there",
          }),
        }),
      );
    });

    it("only matches an unsent AI-generated draft to replace (excludes SENT messages)", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce(null);
      await upsertAiDraftMessage(ctx("org-a"), "org-a-t1", "Hello");
      expect(unscopedMock.inboxMessage.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            threadId: "org-a-t1",
            direction: "OUTBOUND",
            aiGenerated: true,
            status: { not: "SENT" },
          }),
        }),
      );
    });

    it("replaces an existing unsent AI draft in place, resetting status and clearing approval, instead of creating a duplicate", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "draft-1",
        status: "APPROVED",
        approvedAt: new Date(),
        approvedById: "user-1",
      });
      await upsertAiDraftMessage(ctx("org-a"), "org-a-t1", "Updated text");
      expect(unscopedMock.inboxMessage.update).toHaveBeenCalledWith({
        where: { id: "draft-1" },
        data: { body: "Updated text", status: "DRAFT", approvedAt: null, approvedById: null },
      });
      expect(unscopedMock.inboxMessage.create).not.toHaveBeenCalled();
    });
  });

  describe("editDraftMessage", () => {
    it("rejects editing a message belonging to a different organization", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        status: "DRAFT",
        thread: { id: "t1", organizationId: "org-b" },
      });
      await expect(editDraftMessage(ctx("org-a"), "msg-1", "New body")).rejects.toBeInstanceOf(
        InboxError,
      );
      expect(unscopedMock.inboxMessage.update).not.toHaveBeenCalled();
    });

    it("rejects editing an INBOUND message", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "INBOUND",
        status: "RECEIVED",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await expect(editDraftMessage(ctx("org-a"), "msg-1", "New body")).rejects.toMatchObject({
        code: "not_outbound",
      });
    });

    it("rejects editing an already-sent message", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        status: "SENT",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await expect(editDraftMessage(ctx("org-a"), "msg-1", "New body")).rejects.toMatchObject({
        code: "already_sent",
      });
    });

    it("resets status to DRAFT and clears prior approval when an approved draft is edited", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        status: "APPROVED",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await editDraftMessage(ctx("org-a"), "msg-1", "New body");
      expect(unscopedMock.inboxMessage.update).toHaveBeenCalledWith({
        where: { id: "msg-1" },
        data: { body: "New body", status: "DRAFT", approvedAt: null, approvedById: null },
      });
    });
  });

  describe("approveMessage / sendMessage — cross-tenant and approval-gate safety", () => {
    it("rejects approving a message belonging to a different organization", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        thread: { id: "t1", organizationId: "org-b" },
      });
      await expect(approveMessage(ctx("org-a"), "msg-1")).rejects.toBeInstanceOf(InboxError);
      expect(unscopedMock.inboxMessage.update).not.toHaveBeenCalled();
    });

    it("rejects sending a message belonging to a different organization", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        aiGenerated: false,
        approvedAt: null,
        thread: { id: "t1", organizationId: "org-b" },
      });
      await expect(sendMessage(ctx("org-a"), "msg-1")).rejects.toBeInstanceOf(InboxError);
    });

    it("rejects approving an INBOUND message", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "INBOUND",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await expect(approveMessage(ctx("org-a"), "msg-1")).rejects.toMatchObject({
        code: "not_outbound",
      });
    });

    it("blocks sending an AI-generated draft that has not been approved", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        aiGenerated: true,
        approvedAt: null,
        threadId: "t1",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await expect(sendMessage(ctx("org-a"), "msg-1")).rejects.toMatchObject({
        code: "requires_approval",
      });
      expect(unscopedMock.$transaction).not.toHaveBeenCalled();
    });

    it("allows sending a human-authored draft without approval", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        aiGenerated: false,
        approvedAt: null,
        threadId: "t1",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await sendMessage(ctx("org-a"), "msg-1");
      expect(unscopedMock.$transaction).toHaveBeenCalled();
    });

    it("allows sending an AI-generated draft once approved", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        aiGenerated: true,
        approvedAt: new Date(),
        threadId: "t1",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await sendMessage(ctx("org-a"), "msg-1");
      expect(unscopedMock.$transaction).toHaveBeenCalled();
    });

    it("stamps the approving user and audits", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        thread: { id: "t1", organizationId: "org-a" },
      });
      await approveMessage(ctx("org-a", "approver-1"), "msg-1");
      expect(unscopedMock.inboxMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "APPROVED", approvedById: "approver-1" }),
        }),
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "inbox.message.approved" }),
      );
    });
  });

  describe("sendMessage — email channel dispatch", () => {
    it("dispatches through the email adapter and stores the returned externalId", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        status: "DRAFT",
        aiGenerated: false,
        approvedAt: null,
        threadId: "t1",
        toAddress: "customer@example.com",
        externalId: null,
        body: "Thanks!",
        thread: { id: "t1", organizationId: "org-a", channel: "EMAIL", subject: "Order #42" },
      });

      await sendMessage(ctx("org-a"), "msg-1");

      expect(emailAdapterMock.send).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "customer@example.com",
          subject: "Re: Order #42",
          text: "Thanks!",
        }),
      );
      // The atomic claim (compare-and-swap on the message's current status)
      // is what actually transitions it to SENT, before dispatch.
      expect(unscopedMock.inboxMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "msg-1", status: "DRAFT" },
          data: expect.objectContaining({ status: "SENT" }),
        }),
      );
      expect(unscopedMock.inboxMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ externalId: "ext-sent-1" }),
        }),
      );
    });

    it("falls back to the last inbound message's fromAddress when toAddress is unset", async () => {
      unscopedMock.inboxMessage.findFirst
        .mockResolvedValueOnce({
          id: "msg-1",
          direction: "OUTBOUND",
          aiGenerated: false,
          approvedAt: null,
          threadId: "t1",
          toAddress: null,
          externalId: null,
          body: "Thanks!",
          thread: { id: "t1", organizationId: "org-a", channel: "EMAIL", subject: null },
        })
        .mockResolvedValueOnce({ fromAddress: "sender@example.com" });

      await sendMessage(ctx("org-a"), "msg-1");

      expect(emailAdapterMock.send).toHaveBeenCalledWith(
        expect.objectContaining({ to: "sender@example.com", subject: "Re: your message" }),
      );
    });

    it("throws without dispatching when no recipient address can be found", async () => {
      unscopedMock.inboxMessage.findFirst
        .mockResolvedValueOnce({
          id: "msg-1",
          direction: "OUTBOUND",
          aiGenerated: false,
          approvedAt: null,
          threadId: "t1",
          toAddress: null,
          externalId: null,
          body: "Thanks!",
          thread: { id: "t1", organizationId: "org-a", channel: "EMAIL", subject: null },
        })
        .mockResolvedValueOnce(null);

      await expect(sendMessage(ctx("org-a"), "msg-1")).rejects.toBeInstanceOf(InboxError);
      expect(emailAdapterMock.send).not.toHaveBeenCalled();
    });

    it("marks the message FAILED and audits the failure when the adapter throws, without marking it SENT", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        aiGenerated: false,
        approvedAt: null,
        threadId: "t1",
        toAddress: "customer@example.com",
        externalId: null,
        body: "Thanks!",
        thread: { id: "t1", organizationId: "org-a", channel: "EMAIL", subject: "Hi" },
      });
      emailAdapterMock.send.mockRejectedValueOnce(
        new EmailChannelErrorMock("boom", "remote_error", true),
      );

      await expect(sendMessage(ctx("org-a"), "msg-1")).rejects.toThrow("boom");

      expect(unscopedMock.inboxMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "FAILED" } }),
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "inbox.message.send_failed",
          after: { code: "remote_error" },
        }),
      );
      expect(unscopedMock.$transaction).not.toHaveBeenCalled();
    });

    it("does not dispatch through the email adapter for non-email channels", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        aiGenerated: false,
        approvedAt: null,
        threadId: "t1",
        thread: { id: "t1", organizationId: "org-a", channel: "WHATSAPP", subject: null },
      });

      await sendMessage(ctx("org-a"), "msg-1");

      expect(emailAdapterMock.send).not.toHaveBeenCalled();
      expect(unscopedMock.$transaction).toHaveBeenCalled();
    });
  });

  describe("sendMessage — duplicate-send prevention", () => {
    it("rejects re-sending a message that is already SENT, without dispatching", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        status: "SENT",
        aiGenerated: false,
        approvedAt: null,
        threadId: "t1",
        thread: { id: "t1", organizationId: "org-a", channel: "EMAIL", subject: null },
      });

      await expect(sendMessage(ctx("org-a"), "msg-1")).rejects.toMatchObject({
        code: "already_sent",
      });
      expect(unscopedMock.inboxMessage.updateMany).not.toHaveBeenCalled();
      expect(emailAdapterMock.send).not.toHaveBeenCalled();
    });

    it("loses the race and never dispatches when a concurrent call already claimed the send", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        id: "msg-1",
        direction: "OUTBOUND",
        status: "DRAFT",
        aiGenerated: false,
        approvedAt: null,
        threadId: "t1",
        toAddress: "customer@example.com",
        thread: { id: "t1", organizationId: "org-a", channel: "EMAIL", subject: null },
      });
      // Simulates a concurrent sendMessage call winning the compare-and-swap
      // first: the conditional update matches zero rows.
      unscopedMock.inboxMessage.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(sendMessage(ctx("org-a"), "msg-1")).rejects.toMatchObject({
        code: "already_sent",
      });
      expect(emailAdapterMock.send).not.toHaveBeenCalled();
    });
  });

  describe("listAssignableMembers", () => {
    it("lists the caller's org members as assignable options, falling back to email when no name is set", async () => {
      const result = await listAssignableMembers(ctx("org-a"));
      expect(tenantDbMock).toHaveBeenCalledWith("org-a");
      expect(result).toEqual([
        { id: "user-1", name: "Ada Lovelace" },
        { id: "user-2", name: "no-name@example.com" },
      ]);
    });

    it("uses the caller's org for tenant isolation", async () => {
      const dbB = createMockDb("org-b");
      dbB.organizationMember.findMany.mockResolvedValueOnce([]);
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      const result = await listAssignableMembers(ctx("org-b"));

      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
      expect(result).toEqual([]);
      expect(db.organizationMember.findMany).not.toHaveBeenCalled();
    });
  });

  describe("updateThreadStatus / assignThread", () => {
    it("throws when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await expect(
        updateThreadStatus(ctx(), "missing", { status: "CLOSED" }),
      ).rejects.toBeInstanceOf(InboxError);
    });

    it("updates status and audits before/after", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { status: "OPEN" }),
      );
      await updateThreadStatus(ctx("org-a"), "org-a-t1", { status: "CLOSED" });
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "CLOSED" } }),
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: "inbox.thread.status_changed",
          before: { status: "OPEN" },
          after: { status: "CLOSED" },
        }),
      );
    });

    it("clears assignment when assignedToId is omitted", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { assignedToId: "user-2" }),
      );
      await assignThread(ctx("org-a"), "org-a-t1", {});
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { assignedToId: null } }),
      );
      expect(db.organizationMember.findFirst).not.toHaveBeenCalled();
    });

    it("assigns to a verified organization member", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(threadRow("org-a-t1", "org-a"));
      db.organizationMember.findFirst.mockResolvedValueOnce({ id: "member-1" });

      await assignThread(ctx("org-a"), "org-a-t1", { assignedToId: "user-2" });

      expect(db.organizationMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-2" } }),
      );
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { assignedToId: "user-2" } }),
      );
    });

    it("rejects assigning to a user id that is not a member of this organization — never trusts a browser-supplied id", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(threadRow("org-a-t1", "org-a"));
      db.organizationMember.findFirst.mockResolvedValueOnce(null);

      await expect(
        assignThread(ctx("org-a"), "org-a-t1", { assignedToId: "outsider-user" }),
      ).rejects.toMatchObject({ code: "not_org_member" });
      expect(db.inboxThread.update).not.toHaveBeenCalled();
    });

    it("rejects assigning to a user who belongs to a different organization", async () => {
      const dbB = createMockDb("org-b");
      dbB.inboxThread.findFirst.mockResolvedValueOnce(threadRow("org-b-t1", "org-b"));
      dbB.organizationMember.findFirst.mockResolvedValueOnce(null);
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      await expect(
        assignThread(ctx("org-b"), "org-b-t1", { assignedToId: "org-a-user" }),
      ).rejects.toMatchObject({ code: "not_org_member" });
      expect(dbB.organizationMember.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "org-a-user" } }),
      );
    });

    it("uses the caller's org for tenant verification (tenant isolation)", async () => {
      const dbB = createMockDb("org-b");
      dbB.inboxThread.findFirst.mockResolvedValueOnce(null);
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      await expect(
        updateThreadStatus(ctx("org-b"), "org-a-t1", { status: "CLOSED" }),
      ).rejects.toBeInstanceOf(InboxError);
      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    });
  });

  describe("createContactFromThread", () => {
    it("throws when the thread does not belong to the tenant", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(null);
      await expect(
        createContactFromThread(ctx("org-a"), "missing", { firstName: "Jane" }),
      ).rejects.toMatchObject({ code: "thread_not_found" });
      expect(createContactMock).not.toHaveBeenCalled();
    });

    it("refuses to overwrite an already-linked thread", async () => {
      db.inboxThread.findFirst.mockResolvedValueOnce(
        threadRow("org-a-t1", "org-a", { contactId: "existing-contact" }),
      );
      await expect(
        createContactFromThread(ctx("org-a"), "org-a-t1", { firstName: "Jane" }),
      ).rejects.toMatchObject({ code: "already_linked" });
      expect(createContactMock).not.toHaveBeenCalled();
    });

    it("throws when the thread has no inbound sender address", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce(null);
      await expect(
        createContactFromThread(ctx("org-a"), "org-a-t1", { firstName: "Jane" }),
      ).rejects.toMatchObject({ code: "no_sender_address" });
      expect(createContactMock).not.toHaveBeenCalled();
    });

    it("creates a contact from the sender's address, links the thread, and audits", async () => {
      unscopedMock.inboxMessage.findFirst.mockResolvedValueOnce({
        fromAddress: "jane@example.com",
      });

      const result = await createContactFromThread(ctx("org-a"), "org-a-t1", {
        firstName: "Jane",
        lastName: "Doe",
      });

      expect(createContactMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
          status: "LEAD",
          gdprConsent: false,
        }),
      );
      expect(db.inboxThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { contactId: "new-contact-1" } }),
      );
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "inbox.thread.contact_linked" }),
      );
      expect(result.contact.id).toBe("new-contact-1");
    });

    it("uses the caller's org for tenant verification (tenant isolation)", async () => {
      const dbB = createMockDb("org-b");
      dbB.inboxThread.findFirst.mockResolvedValueOnce(null);
      tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

      await expect(
        createContactFromThread(ctx("org-b"), "org-a-t1", { firstName: "Jane" }),
      ).rejects.toBeInstanceOf(InboxError);
      expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
      expect(createContactMock).not.toHaveBeenCalled();
    });
  });
});
