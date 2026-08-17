import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";

const { unscopedMock } = vi.hoisted(() => ({
  unscopedMock: {
    organizationMember: { findFirst: vi.fn() },
    calendarConnection: { findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    externalCalendar: { upsert: vi.fn() },
  },
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: vi.fn(),
}));

import {
  getFreshTokens,
  buildOAuthState,
  verifyOAuthState,
  ConnectionError,
  completeConnection,
} from "@/server/services/calendar-connections";
import { encryptToken } from "@/server/integrations/calendar/crypto";
import { mockCalendarAdapter, mockProviderTestApi } from "@/server/integrations/calendar/mock";
import type { TenantContext } from "@/server/auth/session";

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

describe("OAuth state signing (fail-closed)", () => {
  const STATE_SECRET_KEYS = ["CALENDAR_OAUTH_STATE_SECRET", "QSTASH_CURRENT_SIGNING_KEY"] as const;
  const snapshot = Object.fromEntries(STATE_SECRET_KEYS.map((key) => [key, process.env[key]]));

  const ctx: TenantContext = {
    userId: "user-a",
    email: "user@example.com",
    orgId: "org-a",
    role: "OWNER",
    locale: "en",
  };

  afterEach(() => {
    for (const key of STATE_SECRET_KEYS) {
      if (snapshot[key] === undefined) delete process.env[key];
      else process.env[key] = snapshot[key];
    }
  });

  it("round-trips a valid state using CALENDAR_OAUTH_STATE_SECRET", () => {
    process.env.CALENDAR_OAUTH_STATE_SECRET = "dedicated-state-secret-at-least-16-chars";
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;

    const state = buildOAuthState(ctx, "GOOGLE");
    const decoded = verifyOAuthState(state);
    expect(decoded).toMatchObject({ orgId: "org-a", userId: "user-a", provider: "GOOGLE" });
  });

  it("falls back to QSTASH_CURRENT_SIGNING_KEY when no dedicated secret is set", () => {
    delete process.env.CALENDAR_OAUTH_STATE_SECRET;
    process.env.QSTASH_CURRENT_SIGNING_KEY = "qstash-signing-key";

    const state = buildOAuthState(ctx, "MICROSOFT");
    const decoded = verifyOAuthState(state);
    expect(decoded).toMatchObject({ orgId: "org-a", userId: "user-a", provider: "MICROSOFT" });
  });

  it("throws ConnectionError with code not_configured when neither secret is configured", () => {
    delete process.env.CALENDAR_OAUTH_STATE_SECRET;
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;

    let error: unknown;
    try {
      buildOAuthState(ctx, "GOOGLE");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).code).toBe("not_configured");
  });

  it("a state signed with the old hardcoded 'dev' literal no longer verifies", () => {
    // Guards against ever reintroducing a static default: even if an attacker
    // knows the literal "dev", verification must not accept it once no
    // secret is configured -- it must throw before ever computing an HMAC
    // that could match.
    delete process.env.CALENDAR_OAUTH_STATE_SECRET;
    delete process.env.QSTASH_CURRENT_SIGNING_KEY;

    const payload = `org-a.user-a.GOOGLE.${Date.now()}.deadbeefdeadbeef`;
    const forgedSig = createHmac("sha256", "dev").update(payload).digest("base64url");
    const forgedState = `${Buffer.from(payload).toString("base64url")}.${forgedSig}`;

    expect(() => verifyOAuthState(forgedState)).toThrow(ConnectionError);
    expect(() => verifyOAuthState(forgedState)).toThrow(/not configured/i);
  });
});

describe("OAuth callback authorization freshness", () => {
  const ctx: TenantContext = {
    userId: "user-a",
    email: "user@example.com",
    orgId: "org-a",
    role: "ADMIN",
    locale: "en",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockProviderTestApi.reset();
    process.env.CALENDAR_OAUTH_STATE_SECRET = "dedicated-state-secret-at-least-16-chars";
    process.env.CALENDAR_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    unscopedMock.calendarConnection.upsert.mockResolvedValue({ id: "conn-1" });
    unscopedMock.externalCalendar.upsert.mockResolvedValue({ id: "cal-1" });
  });

  it("rejects a callback after membership is revoked without exchanging the code", async () => {
    unscopedMock.organizationMember.findFirst.mockResolvedValue(null);
    const exchangeSpy = vi.spyOn(mockCalendarAdapter, "exchangeCode");

    await expect(
      completeConnection({ provider: "MOCK", code: "code", state: buildOAuthState(ctx, "MOCK") }),
    ).rejects.toMatchObject({ code: "bad_state" });
    expect(exchangeSpy).not.toHaveBeenCalled();
    expect(unscopedMock.calendarConnection.upsert).not.toHaveBeenCalled();
  });

  it("rejects a callback after an administrator is downgraded", async () => {
    unscopedMock.organizationMember.findFirst.mockResolvedValue({ role: "VIEWER" });
    await expect(
      completeConnection({ provider: "MOCK", code: "code", state: buildOAuthState(ctx, "MOCK") }),
    ).rejects.toMatchObject({ code: "bad_state" });
    expect(unscopedMock.organizationMember.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-a",
        userId: "user-a",
        organization: { deletedAt: null },
      },
      select: { role: true },
    });
  });

  it("re-checks authorization after provider calls and refuses to persist on mid-flow revocation", async () => {
    unscopedMock.organizationMember.findFirst
      .mockResolvedValueOnce({ role: "ADMIN" })
      .mockResolvedValueOnce(null);
    await expect(
      completeConnection({ provider: "MOCK", code: "code", state: buildOAuthState(ctx, "MOCK") }),
    ).rejects.toMatchObject({ code: "bad_state" });
    expect(unscopedMock.organizationMember.findFirst).toHaveBeenCalledTimes(2);
    expect(unscopedMock.calendarConnection.upsert).not.toHaveBeenCalled();
  });

  it("persists the connection for a current administrator in an active organization", async () => {
    unscopedMock.organizationMember.findFirst.mockResolvedValue({ role: "ADMIN" });
    await expect(
      completeConnection({ provider: "MOCK", code: "code", state: buildOAuthState(ctx, "MOCK") }),
    ).resolves.toEqual({ orgId: "org-a", connectionId: "conn-1" });
    expect(unscopedMock.organizationMember.findFirst).toHaveBeenCalledTimes(2);
    expect(unscopedMock.calendarConnection.upsert).toHaveBeenCalledTimes(1);
  });
});
