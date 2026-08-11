import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, unscopedMock, auditMock, emailAdapterMock, EmailChannelErrorMock } =
  vi.hoisted(() => {
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
        },
        inboxThread: {
          update: vi.fn(),
        },
        $transaction: vi.fn(),
      },
      auditMock: vi.fn(async () => undefined),
      emailAdapterMock: { send: vi.fn(async () => ({ externalId: "ext-sent-1" })) },
      EmailChannelErrorMock,
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

import {
  approveMessage,
  assignThread,
  createDraftMessage,
  getThread,
  InboxError,
  listThreads,
  recordInboundMessage,
  sendMessage,
  updateThreadStatus,
} from "@/server/services/inbox";

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
      expect(unscopedMock.inboxMessage.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SENT", externalId: "ext-sent-1" }),
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
});
