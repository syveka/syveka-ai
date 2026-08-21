import { beforeEach, describe, expect, it, vi } from "vitest";

const { txMock, transactionMock, auditMock, tenantDbMock, serviceFindFirstMock } = vi.hoisted(
  () => {
    const txMock = {
      $executeRaw: vi.fn(async () => 0),
      calendarEvent: { findFirst: vi.fn(), create: vi.fn() },
      contact: { findFirstOrThrow: vi.fn() },
    };
    return {
      txMock,
      transactionMock: vi.fn(async (fn: (tx: typeof txMock) => Promise<unknown>) => fn(txMock)),
      auditMock: vi.fn(async () => undefined),
      tenantDbMock: vi.fn(),
      serviceFindFirstMock: vi.fn(async () => null as { durationMinutes: number | null } | null),
    };
  },
);

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: { $transaction: transactionMock },
}));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));

import { TOOL_REGISTRY, type ToolIdentity } from "@/server/ai/tools";

const bookMeeting = TOOL_REGISTRY.find((t) => t.name === "bookMeeting")!;

function identity(overrides: Partial<ToolIdentity> = {}): ToolIdentity {
  return { orgId: "org-a", userId: "user-1", role: "MANAGER", actorType: "user", ...overrides };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    title: "Intro call",
    startsAt: "2026-08-17T10:00:00.000Z",
    durationMinutes: 30,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txMock.calendarEvent.findFirst.mockResolvedValue(null); // no conflict
  txMock.calendarEvent.create.mockResolvedValue({ id: "evt-1" });
  txMock.contact.findFirstOrThrow.mockResolvedValue({ id: "contact-1" });
  serviceFindFirstMock.mockResolvedValue(null);
  tenantDbMock.mockReturnValue({ businessDnaService: { findFirst: serviceFindFirstMock } });
});

describe("bookMeeting tool", () => {
  it("books a meeting when the shared org calendar has no conflict", async () => {
    const result = await bookMeeting.execute(identity(), input());
    expect(result).toMatchObject({ booked: true, eventId: "evt-1" });
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: "org-a", title: "Intro call" }),
      }),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "calendar.book", resourceId: "evt-1" }),
    );
  });

  it("re-check guard: rejects when the in-transaction conflict query finds a row", async () => {
    // Proves the guard clause fires when the conflict query returns a row - not
    // concurrency safety itself, since a mocked single-threaded transaction can't
    // reproduce two real Postgres transactions racing under READ COMMITTED. See
    // the "serializes concurrent" test below for the lock-ordering regression
    // coverage, and tests/integration/ai-book-meeting-concurrency.sh for a
    // real-Postgres proof.
    txMock.calendarEvent.findFirst.mockResolvedValue({ id: "concurrent-evt" });
    const result = await bookMeeting.execute(identity(), input());
    expect(result).toEqual({ booked: false, reason: "slot_taken" });
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent bookMeeting calls: acquires the org-calendar advisory lock before checking/writing, keyed on the trusted orgId", async () => {
    const callOrder: string[] = [];
    txMock.$executeRaw.mockImplementationOnce(async () => {
      callOrder.push("lock");
      return 0;
    });
    txMock.calendarEvent.findFirst.mockImplementationOnce(async () => {
      callOrder.push("conflict-check");
      return null;
    });
    txMock.calendarEvent.create.mockImplementationOnce(async () => {
      callOrder.push("create-event");
      return { id: "evt-1" };
    });

    await bookMeeting.execute(identity({ orgId: "org-a" }), input());

    // Lock must be the *first* statement in the transaction, before the
    // conflict re-check and before any write - otherwise a second concurrent
    // transaction could race assertConflict's SELECT under READ COMMITTED.
    expect(callOrder).toEqual(["lock", "conflict-check", "create-event"]);
    expect(txMock.$executeRaw).toHaveBeenCalledTimes(1);
    // The lock's key is the caller's trusted identity.orgId, not anything from
    // the model-supplied tool input (which has no org/owner field at all).
    expect(txMock.$executeRaw).toHaveBeenCalledWith(expect.anything(), "org-a");
  });

  it("rejects a contactId that does not belong to the caller's organization", async () => {
    txMock.contact.findFirstOrThrow.mockRejectedValue(new Error("No Contact found"));
    await expect(
      bookMeeting.execute(identity(), input({ contactId: "22222222-2222-4222-8222-222222222222" })),
    ).rejects.toThrow();
    expect(txMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("links a contactId that does belong to the caller's organization", async () => {
    const result = await bookMeeting.execute(
      identity(),
      input({ contactId: "33333333-3333-4333-8333-333333333333" }),
    );
    expect(result).toMatchObject({ booked: true });
    expect(txMock.contact.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "33333333-3333-4333-8333-333333333333", organizationId: "org-a" },
    });
    expect(txMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ contactId: "33333333-3333-4333-8333-333333333333" }),
      }),
    );
  });

  describe("serviceName duration resolution (First Customer Readiness milestone)", () => {
    it("books using the named service's real duration instead of a caller-guessed default", async () => {
      serviceFindFirstMock.mockResolvedValueOnce({ durationMinutes: 45 });

      const result = await bookMeeting.execute(
        identity(),
        input({ durationMinutes: undefined, serviceName: "Haircut" }),
      );

      expect(result).toMatchObject({ booked: true });
      expect(serviceFindFirstMock).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, name: { equals: "Haircut", mode: "insensitive" } },
        }),
      );
      const created = txMock.calendarEvent.create.mock.calls[0]![0].data;
      expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(45 * 60_000);
    });

    it("an explicit durationMinutes overrides service-name resolution", async () => {
      serviceFindFirstMock.mockResolvedValueOnce({ durationMinutes: 45 });
      await bookMeeting.execute(identity(), input({ durationMinutes: 15, serviceName: "Haircut" }));
      expect(serviceFindFirstMock).not.toHaveBeenCalled();
      const created = txMock.calendarEvent.create.mock.calls[0]![0].data;
      expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(15 * 60_000);
    });

    it("falls back to 30 minutes when neither durationMinutes nor a matching service is given", async () => {
      await bookMeeting.execute(identity(), input({ durationMinutes: undefined }));
      const created = txMock.calendarEvent.create.mock.calls[0]![0].data;
      expect(created.endsAt.getTime() - created.startsAt.getTime()).toBe(30 * 60_000);
    });
  });
});
