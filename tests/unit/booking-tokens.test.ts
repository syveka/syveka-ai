import { beforeEach, describe, expect, it, vi } from "vitest";

const { bookingTokenMock } = vi.hoisted(() => ({
  bookingTokenMock: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { bookingToken: bookingTokenMock },
  tenantDb: vi.fn(),
}));

import {
  BookingTokenError,
  consumeToken,
  generateRawToken,
  hashToken,
  invalidateBookingTokens,
  issueToken,
  resolveToken,
} from "@/server/services/booking-tokens";

function tokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "tok-1",
    bookingId: "bk-1",
    tokenHash: "",
    purpose: "MANAGE",
    expiresAt: new Date(Date.now() + 86_400_000),
    usedAt: null,
    booking: { id: "bk-1", bookingType: {}, event: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("token generation", () => {
  it("raw tokens are long, URL-safe and unique", () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("issueToken stores only the SHA-256 hash", async () => {
    bookingTokenMock.create.mockResolvedValue({});
    const raw = await issueToken("bk-1", "MANAGE");
    const stored = bookingTokenMock.create.mock.calls[0]![0].data;
    expect(stored.tokenHash).toBe(hashToken(raw));
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("token validation", () => {
  it("resolves a valid token by hash", async () => {
    const raw = generateRawToken();
    bookingTokenMock.findUnique.mockResolvedValue(tokenRecord({ tokenHash: hashToken(raw) }));
    const record = await resolveToken(raw, "CANCEL"); // MANAGE covers CANCEL
    expect(record.bookingId).toBe("bk-1");
    expect(bookingTokenMock.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashToken(raw) } }),
    );
  });

  it("rejects unknown tokens without leaking existence", async () => {
    bookingTokenMock.findUnique.mockResolvedValue(null);
    await expect(resolveToken(generateRawToken(), "CANCEL")).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("rejects short/garbage input before any query", async () => {
    await expect(resolveToken("abc", "CANCEL")).rejects.toBeInstanceOf(BookingTokenError);
    expect(bookingTokenMock.findUnique).not.toHaveBeenCalled();
  });

  it("rejects expired tokens", async () => {
    const raw = generateRawToken();
    bookingTokenMock.findUnique.mockResolvedValue(
      tokenRecord({ tokenHash: hashToken(raw), expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(resolveToken(raw, "CANCEL")).rejects.toMatchObject({ code: "expired" });
  });

  it("rejects used tokens", async () => {
    const raw = generateRawToken();
    bookingTokenMock.findUnique.mockResolvedValue(
      tokenRecord({ tokenHash: hashToken(raw), usedAt: new Date() }),
    );
    await expect(resolveToken(raw, "CANCEL")).rejects.toMatchObject({ code: "used" });
  });

  it("rejects purpose mismatch for single-purpose tokens", async () => {
    const raw = generateRawToken();
    bookingTokenMock.findUnique.mockResolvedValue(
      tokenRecord({ tokenHash: hashToken(raw), purpose: "CANCEL" }),
    );
    await expect(resolveToken(raw, "RESCHEDULE")).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("token consumption", () => {
  it("consumes single-purpose tokens", async () => {
    bookingTokenMock.update.mockResolvedValue({});
    await consumeToken("tok-1", "CANCEL");
    expect(bookingTokenMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "tok-1" } }),
    );
  });

  it("keeps MANAGE tokens live", async () => {
    await consumeToken("tok-1", "MANAGE");
    expect(bookingTokenMock.update).not.toHaveBeenCalled();
  });

  it("invalidates all outstanding tokens for a booking", async () => {
    bookingTokenMock.updateMany.mockResolvedValue({ count: 2 });
    await invalidateBookingTokens("bk-1");
    expect(bookingTokenMock.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { bookingId: "bk-1", usedAt: null } }),
    );
  });
});
