import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

const { unscopedMock } = vi.hoisted(() => ({
  unscopedMock: {
    calendarConnection: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: vi.fn(),
}));

import { getFreshTokens, ConnectionError } from "@/server/services/calendar-connections";
import { encryptToken } from "@/server/integrations/calendar/crypto";

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn-1",
    organizationId: "org-a",
    provider: "MOCK",
    accessTokenEnc: encryptToken("mock-access-token"),
    refreshTokenEnc: encryptToken("mock-refresh-token"),
    tokenExpiresAt: new Date(Date.now() + 3_600_000), // valid for another hour
    scopes: ["mock:calendar"],
    accountEmail: "user@example.com",
    ...overrides,
  };
}

describe("getFreshTokens org scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  it("queries by both connectionId and orgId, not connectionId alone", async () => {
    unscopedMock.calendarConnection.findFirst.mockResolvedValue(connectionRow());
    await getFreshTokens("conn-1", "org-a");
    expect(unscopedMock.calendarConnection.findFirst).toHaveBeenCalledWith({
      where: { id: "conn-1", organizationId: "org-a" },
    });
  });

  it("returns tokens when the connection belongs to the given org", async () => {
    unscopedMock.calendarConnection.findFirst.mockResolvedValue(connectionRow());
    const tokens = await getFreshTokens("conn-1", "org-a");
    expect(tokens.accessToken).toBe("mock-access-token");
  });

  it("rejects as not_found when the connection belongs to a different org", async () => {
    // A tenant-scoped query for the wrong org never matches the row → Prisma returns null,
    // exactly like a non-existent connection. This is the regression this fix closes: the
    // old `findUnique({ where: { id } })` had no org filter and would have returned org-a's
    // tokens to a caller that only ever validated the id against org-b.
    unscopedMock.calendarConnection.findFirst.mockResolvedValue(null);
    await expect(getFreshTokens("conn-1", "org-b")).rejects.toThrow(ConnectionError);
    await expect(getFreshTokens("conn-1", "org-b")).rejects.toMatchObject({ code: "not_found" });
  });
});
