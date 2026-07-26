import { beforeEach, describe, expect, it, vi } from "vitest";

const { unscopedMock, getFreshTokensMock } = vi.hoisted(() => ({
  unscopedMock: {
    externalCalendar: { findUnique: vi.fn(), findMany: vi.fn() },
    calendarEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    eventAttendee: { createMany: vi.fn() },
    calendarSyncState: { upsert: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  },
  getFreshTokensMock: vi.fn(async () => ({
    accessToken: "mock-access-token",
    scopes: ["mock:calendar"],
  })),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: unscopedMock,
  tenantDb: vi.fn(),
}));
vi.mock("@/server/services/calendar-connections", () => ({
  getFreshTokens: getFreshTokensMock,
  markConnectionStatus: vi.fn(async () => undefined),
}));

import {
  syncExternalCalendar,
  ensureWebhookSubscription,
  handleProviderWebhook,
  generateWebhookSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
} from "@/server/services/calendar-sync";
import { mockProviderTestApi, mockCalendarAdapter } from "@/server/integrations/calendar/mock";
import type { ExternalEvent } from "@/server/integrations/calendar/types";

function externalCalendar(overrides: Record<string, unknown> = {}) {
  return {
    id: "extcal-1",
    connectionId: "conn-1",
    organizationId: "org-a",
    externalId: "mock-primary",
    name: "Mock Primary",
    syncEnabled: true,
    connection: { id: "conn-1", provider: "MOCK", userId: "owner-1" },
    syncState: null,
    ...overrides,
  };
}

function remoteEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    externalId: "remote-1",
    etag: "etag-v1",
    title: "External meeting",
    startsAt: new Date("2026-02-03T09:00:00Z"),
    endsAt: new Date("2026-02-03T10:00:00Z"),
    allDay: false,
    status: "confirmed",
    attendees: [{ email: "someone@example.com", name: "Someone" }],
    ...overrides,
  };
}

function calendarSyncState(overrides: Record<string, unknown> = {}) {
  return {
    webhookSubscriptionId: null,
    webhookResourceId: null,
    webhookExpiresAt: null,
    webhookVerificationSecretHash: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockProviderTestApi.reset();
  unscopedMock.externalCalendar.findUnique.mockResolvedValue(externalCalendar());
  unscopedMock.externalCalendar.findMany.mockResolvedValue([]);
  unscopedMock.calendarEvent.findUnique.mockResolvedValue(null);
  unscopedMock.calendarEvent.create.mockResolvedValue({ id: "evt-imported" });
  unscopedMock.calendarSyncState.upsert.mockResolvedValue({});
  unscopedMock.calendarSyncState.update.mockResolvedValue({});
  unscopedMock.calendarSyncState.findFirst.mockResolvedValue(null);
});

describe("idempotent import sync", () => {
  it("imports new remote events keyed by (externalCalendarId, externalId)", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    const result = await syncExternalCalendar("extcal-1");
    expect(result.imported).toBe(1);
    expect(unscopedMock.calendarEvent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          externalCalendarId_externalId: {
            externalCalendarId: "extcal-1",
            externalId: "remote-1",
          },
        },
      }),
    );
    expect(unscopedMock.calendarEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          ownerId: "owner-1",
          externalId: "remote-1",
        }),
      }),
    );
    expect(unscopedMock.eventAttendee.createMany).toHaveBeenCalled();
  });

  it("fetches tokens scoped to the calendar's own organization", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    await syncExternalCalendar("extcal-1");
    expect(getFreshTokensMock).toHaveBeenCalledWith("conn-1", "org-a");
  });

  it("replaying the same page is a no-op (same etag → skipped)", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    unscopedMock.calendarEvent.findUnique.mockResolvedValue({
      id: "evt-existing",
      externalEtag: "etag-v1",
      updatedAt: new Date(),
      deletedAt: null,
    });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.imported).toBe(0);
    expect(result.updated).toBe(0);
    expect(unscopedMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(unscopedMock.calendarEvent.update).not.toHaveBeenCalled();
  });

  it("applies remote updates when the etag changed", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent({ etag: "etag-v2" })]);
    unscopedMock.calendarEvent.findUnique.mockResolvedValue({
      id: "evt-existing",
      externalEtag: "etag-v1",
      updatedAt: new Date(),
      deletedAt: null,
    });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.updated).toBe(1);
    expect(unscopedMock.calendarEvent.update).toHaveBeenCalled();
  });

  it("conflict detection: locally deleted events keep their tombstone", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent({ etag: "etag-v3" })]);
    unscopedMock.calendarEvent.findUnique.mockResolvedValue({
      id: "evt-existing",
      externalEtag: "etag-v1",
      updatedAt: new Date(),
      deletedAt: new Date(), // user deleted it locally
    });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.skippedConflicts).toBe(1);
    expect(unscopedMock.calendarEvent.update).not.toHaveBeenCalled();
  });

  it("remote deletions cancel local copies", async () => {
    mockProviderTestApi.markDeleted("mock-primary", ["remote-gone"]);
    unscopedMock.calendarEvent.updateMany.mockResolvedValue({ count: 1 });
    const result = await syncExternalCalendar("extcal-1");
    expect(result.deleted).toBe(1);
    expect(unscopedMock.calendarEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ externalId: { in: ["remote-gone"] } }),
      }),
    );
  });

  it("persists the cursor after each applied page", async () => {
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    await syncExternalCalendar("extcal-1");
    expect(unscopedMock.calendarSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { externalCalendarId: "extcal-1" } }),
    );
  });

  it("expired cursors trigger a transparent full resync", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncState: { syncCursor: "mock-expired" } }),
    );
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);
    const result = await syncExternalCalendar("extcal-1");
    expect(result.cursorReset).toBe(true);
    expect(result.imported).toBe(1); // resynced from scratch
  });

  it("does nothing when sync is disabled", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncEnabled: false }),
    );
    const result = await syncExternalCalendar("extcal-1");
    expect(result.imported).toBe(0);
    expect(getFreshTokensMock).not.toHaveBeenCalled();
  });
});

describe("webhook verification secret helper", () => {
  it("generates non-empty, unique secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a.length).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("persisted value is a hash, not the raw secret", () => {
    const secret = generateWebhookSecret();
    const hash = hashWebhookSecret(secret);
    expect(hash).not.toBe(secret);
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex digest
  });

  it("a valid secret matches its own hash", () => {
    const secret = generateWebhookSecret();
    expect(verifyWebhookSecret(secret, hashWebhookSecret(secret))).toBe(true);
  });

  it("a wrong secret fails", () => {
    const hash = hashWebhookSecret(generateWebhookSecret());
    expect(verifyWebhookSecret(generateWebhookSecret(), hash)).toBe(false);
  });

  it("a missing presented value or missing stored hash fails closed", () => {
    const hash = hashWebhookSecret(generateWebhookSecret());
    expect(verifyWebhookSecret(null, hash)).toBe(false);
    expect(verifyWebhookSecret("", hash)).toBe(false);
    expect(verifyWebhookSecret(generateWebhookSecret(), null)).toBe(false);
    expect(verifyWebhookSecret(generateWebhookSecret(), "")).toBe(false);
  });

  it("arbitrary-length input never throws (hashing first fixes the compared length)", () => {
    const hash = hashWebhookSecret(generateWebhookSecret());
    expect(() => verifyWebhookSecret("x", hash)).not.toThrow();
    expect(() => verifyWebhookSecret("x".repeat(5000), hash)).not.toThrow();
    expect(verifyWebhookSecret("x", hash)).toBe(false);
    expect(verifyWebhookSecret("x".repeat(5000), hash)).toBe(false);
  });
});

describe("ensureWebhookSubscription", () => {
  it("creates a fresh subscription and persists only its secret hash", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncState: calendarSyncState() }),
    );
    const outcome = await ensureWebhookSubscription("extcal-1");
    expect(outcome).toBe("renewed");
    expect(unscopedMock.calendarSyncState.upsert).toHaveBeenCalledTimes(1);
    const call = unscopedMock.calendarSyncState.upsert.mock.calls[0]![0];
    const persistedHash = call.create.webhookVerificationSecretHash as string;
    expect(persistedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.create.webhookSubscriptionId).toEqual(expect.any(String));
    expect(call.create.webhookExpiresAt).toBeInstanceOf(Date);
  });

  it("passes the raw secret to the adapter's subscribeWebhook, never the hash", async () => {
    const spy = vi.spyOn(mockCalendarAdapter, "subscribeWebhook");
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncState: calendarSyncState() }),
    );
    await ensureWebhookSubscription("extcal-1");
    expect(spy).toHaveBeenCalledTimes(1);
    const rawSecretSent = spy.mock.calls[0]![3];
    expect(rawSecretSent).toEqual(expect.any(String));
    const persistedHash = unscopedMock.calendarSyncState.upsert.mock.calls[0]![0].create
      .webhookVerificationSecretHash as string;
    expect(rawSecretSent).not.toBe(persistedHash);
    expect(hashWebhookSecret(rawSecretSent as string)).toBe(persistedHash);
  });

  it("reuses a valid, unexpired subscription that already has a secret hash", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({
        syncState: calendarSyncState({
          webhookSubscriptionId: "existing-sub",
          webhookExpiresAt: new Date(Date.now() + 48 * 3_600_000),
          webhookVerificationSecretHash: hashWebhookSecret("existing-secret"),
        }),
      }),
    );
    const outcome = await ensureWebhookSubscription("extcal-1");
    expect(outcome).toBe("reused");
    expect(unscopedMock.calendarSyncState.upsert).not.toHaveBeenCalled();
  });

  it("renews a valid, unexpired subscription that has a null secret hash", async () => {
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({
        syncState: calendarSyncState({
          webhookSubscriptionId: "existing-sub",
          webhookExpiresAt: new Date(Date.now() + 48 * 3_600_000),
          webhookVerificationSecretHash: null, // pre-P0.2 row
        }),
      }),
    );
    const outcome = await ensureWebhookSubscription("extcal-1");
    expect(outcome).toBe("renewed");
    expect(unscopedMock.calendarSyncState.upsert).toHaveBeenCalledTimes(1);
  });

  it("renewal replaces the old hash: the old secret fails and the new one succeeds", async () => {
    const oldHash = hashWebhookSecret("old-secret");
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({
        syncState: calendarSyncState({
          webhookSubscriptionId: "old-sub",
          webhookExpiresAt: new Date(Date.now() + 1 * 3_600_000), // within the 12h buffer
          webhookVerificationSecretHash: oldHash,
        }),
      }),
    );
    const spy = vi.spyOn(mockCalendarAdapter, "subscribeWebhook");
    const outcome = await ensureWebhookSubscription("extcal-1");
    expect(outcome).toBe("renewed");
    const newRawSecret = spy.mock.calls[0]![3] as string;
    const newHash = unscopedMock.calendarSyncState.upsert.mock.calls[0]![0].create
      .webhookVerificationSecretHash as string;
    expect(newHash).not.toBe(oldHash);
    expect(verifyWebhookSecret("old-secret", newHash)).toBe(false);
    expect(verifyWebhookSecret(newRawSecret, newHash)).toBe(true);
  });
});

describe("handleProviderWebhook", () => {
  it("syncs when the presented secret matches the stored hash", async () => {
    const secret = "correct-secret";
    unscopedMock.calendarSyncState.findFirst.mockResolvedValue({
      externalCalendarId: "extcal-1",
      webhookVerificationSecretHash: hashWebhookSecret(secret),
    });
    const handled = await handleProviderWebhook({
      provider: "MOCK",
      subscriptionId: "sub-1",
      presentedSecret: secret,
    });
    expect(handled).toBe(true);
    expect(getFreshTokensMock).toHaveBeenCalled(); // proves syncExternalCalendar actually ran
  });

  it("does not sync when the presented secret is wrong", async () => {
    unscopedMock.calendarSyncState.findFirst.mockResolvedValue({
      externalCalendarId: "extcal-1",
      webhookVerificationSecretHash: hashWebhookSecret("correct-secret"),
    });
    const handled = await handleProviderWebhook({
      provider: "MOCK",
      subscriptionId: "sub-1",
      presentedSecret: "wrong-secret",
    });
    expect(handled).toBe(false);
    expect(getFreshTokensMock).not.toHaveBeenCalled();
  });

  it("does not sync when the presented secret is missing", async () => {
    unscopedMock.calendarSyncState.findFirst.mockResolvedValue({
      externalCalendarId: "extcal-1",
      webhookVerificationSecretHash: hashWebhookSecret("correct-secret"),
    });
    const handled = await handleProviderWebhook({
      provider: "MOCK",
      subscriptionId: "sub-1",
      presentedSecret: null,
    });
    expect(handled).toBe(false);
    expect(getFreshTokensMock).not.toHaveBeenCalled();
  });

  it("does not sync for an unknown subscription id", async () => {
    unscopedMock.calendarSyncState.findFirst.mockResolvedValue(null);
    const handled = await handleProviderWebhook({
      provider: "MOCK",
      subscriptionId: "no-such-sub",
      presentedSecret: "anything",
    });
    expect(handled).toBe(false);
    expect(getFreshTokensMock).not.toHaveBeenCalled();
  });

  it("looks up by the exact provider/subscription pairing", async () => {
    unscopedMock.calendarSyncState.findFirst.mockResolvedValue(null);
    await handleProviderWebhook({
      provider: "GOOGLE",
      subscriptionId: "sub-1",
      presentedSecret: "secret",
    });
    expect(unscopedMock.calendarSyncState.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          webhookSubscriptionId: "sub-1",
          externalCalendar: { connection: { provider: "GOOGLE" } },
        }),
      }),
    );
  });
});

describe("MOCK round trip (no real provider credentials)", () => {
  it("generate → subscribe → persist hash → present secret → verify → sync", async () => {
    // 1. Create: ensureWebhookSubscription generates a secret and hands it to the real
    // MOCK adapter (spied, not stubbed, so the real subscribeWebhook still runs).
    unscopedMock.externalCalendar.findUnique.mockResolvedValue(
      externalCalendar({ syncState: calendarSyncState() }),
    );
    const subscribeSpy = vi.spyOn(mockCalendarAdapter, "subscribeWebhook");
    const outcome = await ensureWebhookSubscription("extcal-1");
    expect(outcome).toBe("renewed");

    const rawSecretSentToProvider = subscribeSpy.mock.calls[0]![3] as string;
    const persistedCall = unscopedMock.calendarSyncState.upsert.mock.calls[0]![0];
    const persistedHash = persistedCall.create.webhookVerificationSecretHash as string;
    const subscriptionId = persistedCall.create.webhookSubscriptionId as string;

    // 2. A real notification arrives, presenting exactly the secret the provider was
    // given. Wire the lookup to return the row just "persisted" above.
    unscopedMock.calendarSyncState.findFirst.mockResolvedValue({
      externalCalendarId: "extcal-1",
      webhookVerificationSecretHash: persistedHash,
    });
    mockProviderTestApi.seedEvents("mock-primary", [remoteEvent()]);

    const handled = await handleProviderWebhook({
      provider: "MOCK",
      subscriptionId,
      presentedSecret: rawSecretSentToProvider,
    });

    expect(handled).toBe(true);
    expect(getFreshTokensMock).toHaveBeenCalledWith("conn-1", "org-a");
  });
});
