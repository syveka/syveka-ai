import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { TenantContext } from "@/server/auth/session";
import type * as CreatorCreditsModule from "@/server/services/creator-credits";

/**
 * Request-level idempotency (P1) for Creator Studio's generation endpoints.
 * The database is the concurrency authority: a unique (organizationId,
 * generationType, idempotencyKey) constraint on CreatorGeneration means the
 * `create()` insert itself decides who wins a race, never a separate
 * check-then-create. This FakeGenerationStore simulates that exact
 * constraint (including Postgres's NULL-is-distinct semantics for rows
 * with no idempotency key) so these tests exercise the real race-handling
 * code path (catching Prisma's P2002), not just its happy path.
 */

const { tenantDbMock, auditMock, reserveMock, commitMock, releaseMock, providerMock } = vi.hoisted(
  () => ({
    tenantDbMock: vi.fn(),
    auditMock: vi.fn(async () => undefined),
    reserveMock: vi.fn(async () => undefined),
    commitMock: vi.fn(async () => ({ applied: true })),
    releaseMock: vi.fn(async () => ({ applied: true })),
    providerMock: {
      name: "mock",
      generateCharacterImage: vi.fn(),
      generateImageFromCharacter: vi.fn(),
      generateVideoFromImage: vi.fn(),
      cleanupGeneratedOutput: vi.fn(async () => undefined),
    },
  }),
);

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock }));
vi.mock("@/server/services/audit", () => ({ audit: auditMock }));
vi.mock("@/server/services/feature-flags", () => ({
  assertFeatureEnabled: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/creator-credits", async () => {
  const actual = await vi.importActual<typeof CreatorCreditsModule>(
    "@/server/services/creator-credits",
  );
  return {
    ...actual,
    getCreatorGenerationCreditCost: vi.fn(() => 10),
    reserveCreatorCredits: reserveMock,
    commitCreatorCredits: commitMock,
    releaseCreatorCredits: releaseMock,
  };
});
vi.mock("@/server/ai/creator", () => ({
  getCreatorMediaProvider: () => providerMock,
  getCreatorCaptionProvider: vi.fn(),
}));

import {
  requestCharacterImageGeneration,
  requestVideoFromImageGeneration,
} from "@/server/services/creator-generations";
import { IdempotencyConflictError } from "@/server/services/creator-studio-idempotency";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MANAGER", locale: "en" };
}

function p2002(): Error {
  const err = Object.assign(new Error("Unique constraint failed on the fields"), { code: "P2002" });
  Object.setPrototypeOf(err, Prisma.PrismaClientKnownRequestError.prototype);
  return err;
}

type Row = Record<string, unknown>;

/** Simulates the real @@unique([organizationId, generationType, idempotencyKey]) constraint. */
class FakeGenerationStore {
  rows: Row[] = [];
  private nextId = 1;

  create(data: Row): Row {
    if (data.idempotencyKey != null) {
      const conflict = this.rows.some(
        (r) =>
          r.organizationId === data.organizationId &&
          r.generationType === data.generationType &&
          r.idempotencyKey === data.idempotencyKey,
      );
      if (conflict) throw p2002();
    }
    const row: Row = { id: `gen-${this.nextId++}`, status: "QUEUED", ...data };
    this.rows.push(row);
    return row;
  }

  findFirst(where: Row): Row | null {
    return (
      this.rows.find((r) => Object.entries(where).every(([key, value]) => r[key] === value)) ?? null
    );
  }

  updateMany(where: { id: string; status?: string }, data: Row): { count: number } {
    const row = this.rows.find((r) => r.id === where.id);
    if (!row) return { count: 0 };
    if (where.status !== undefined && row.status !== where.status) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  }

  update(where: { id: string }, data: Row): Row {
    const row = this.rows.find((r) => r.id === where.id);
    if (!row) throw new Error("not found");
    Object.assign(row, data);
    return row;
  }

  findUniqueOrThrow(where: { id: string }): Row {
    const row = this.rows.find((r) => r.id === where.id);
    if (!row) throw new Error("not found");
    return row;
  }
}

function makeDb(store: FakeGenerationStore, orgId: string) {
  return {
    creatorProfile: {
      findFirstOrThrow: vi.fn(async () => ({
        id: "profile-1",
        consentConfirmedAt: new Date(),
        referenceAssets: [
          { id: "ref-1", storagePath: `${orgId}/profile/ref.png`, source: "UPLOAD" },
          { id: "ref-2", storagePath: `${orgId}/profile/ref2.png`, source: "UPLOAD" },
          { id: "ref-3", storagePath: `${orgId}/profile/ref3.png`, source: "UPLOAD" },
        ],
      })),
    },
    creatorGeneration: {
      create: vi.fn(async ({ data }: { data: Row }) => store.create(data)),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) =>
        store.update(where, data),
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; status?: string }; data: Row }) =>
          store.updateMany(where, data),
      ),
      findFirst: vi.fn(async ({ where }: { where: Row }) =>
        store.findFirst({ ...where, organizationId: orgId }),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        store.findUniqueOrThrow(where),
      ),
    },
    creatorReferenceAsset: {
      create: vi.fn(async ({ data }: { data: Row }) => ({ id: "output-asset-1", ...data })),
      findFirstOrThrow: vi.fn(async () => ({
        id: "asset-1",
        creatorProfileId: "profile-1",
        storagePath: `${orgId}/generated/img.png`,
        source: "GENERATED",
      })),
    },
  };
}

function providerResult(overrides: Row = {}) {
  return {
    outputStoragePath: "fal/out.png",
    mimeType: "image/png",
    sizeBytes: 1234,
    providerRequestId: "https://fal.media/out.png",
    latencyMs: 500,
    ...overrides,
  };
}

describe("Creator Studio generation request idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("CASE 1 — no Idempotency-Key: preserves current behavior, always creates a new generation", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());

    const first = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });
    const second = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(false);
    expect(first.generation.id).not.toBe(second.generation.id);
    expect(reserveMock).toHaveBeenCalledTimes(2);
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(2);
  });

  it("CASE 2 — a new key creates exactly one generation, reserves once, calls the provider once", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());

    const result = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });

    expect(result.reused).toBe(false);
    expect(result.generation.status).toBe("COMPLETED");
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1);
  });

  it("CASE 3 — same key retried while GENERATING: reuses the existing generation, no second RESERVE, no second provider call", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValueOnce(providerResult());

    // Make one real call to get a genuine row + fingerprint, then roll its
    // status back to GENERATING to simulate "the first request is still in
    // flight" without needing to duplicate the fingerprint-hashing logic.
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });
    store.rows[0]!.status = "GENERATING";
    reserveMock.mockClear();
    providerMock.generateCharacterImage.mockClear();

    const result = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });

    expect(result.reused).toBe(true);
    expect(result.generation.status).toBe("GENERATING");
    expect(reserveMock).not.toHaveBeenCalled();
    expect(providerMock.generateCharacterImage).not.toHaveBeenCalled();
  });

  it("CASE 4 — same key retried after COMPLETED: reuses the completed generation", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());

    const first = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });
    expect(first.generation.status).toBe("COMPLETED");

    const second = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });

    expect(second.reused).toBe(true);
    expect(second.generation.id).toBe(first.generation.id);
    expect(reserveMock).toHaveBeenCalledTimes(1); // only from the first call
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1);
  });

  it("CASE 5 — same key retried after FAILED: returns the same failed generation, never retries the provider", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockRejectedValueOnce(new Error("provider exploded"));

    await expect(
      requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a portrait",
        aspectRatio: "1:1",
        idempotencyKey: "client-key-1",
      }),
    ).rejects.toThrow();
    expect(store.rows[0]!.status).toBe("FAILED");

    const retried = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });

    expect(retried.reused).toBe(true);
    expect(retried.generation.status).toBe("FAILED");
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1); // never retried
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("CASE 6 — same key + different payload: 409 conflict, no second reserve, no provider call", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());

    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "client-key-1",
    });
    expect(reserveMock).toHaveBeenCalledTimes(1);

    await expect(
      requestCharacterImageGeneration(ctx(), {
        creatorProfileId: "profile-1",
        prompt: "a COMPLETELY DIFFERENT prompt",
        aspectRatio: "1:1",
        idempotencyKey: "client-key-1",
      }),
    ).rejects.toThrow(IdempotencyConflictError);

    expect(reserveMock).toHaveBeenCalledTimes(1); // not called again
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1); // not called again
  });

  it("CASE 7 — same key in two different organizations: independent generations", async () => {
    // One shared store, but tenantDb(orgId) is always re-resolved per the
    // real orgId passed in (mirroring how tenantDb() is genuinely called
    // fresh, possibly several times, per request) — a single mockReturnValue
    // can't isolate two different orgs within the run of ONE test.
    const store = new FakeGenerationStore();
    tenantDbMock.mockImplementation((orgId: string) => makeDb(store, orgId));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());

    const a = await requestCharacterImageGeneration(ctx("org-a"), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "shared-key",
    });
    const b = await requestCharacterImageGeneration(ctx("org-b"), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "shared-key",
    });

    expect(a.reused).toBe(false);
    expect(b.reused).toBe(false);
    expect(a.generation.id).not.toBe(b.generation.id);
    expect(reserveMock).toHaveBeenCalledTimes(2);
  });

  it("CASE 8 — same key for two different generation operation types (different CreatorGenerationType): independent generations", async () => {
    // character-image and video-from-image map to different
    // CreatorGenerationType values (IMAGE vs IMAGE_TO_VIDEO) — the actual DB
    // uniqueness scope — so the same key never collides between them.
    const store = new FakeGenerationStore();
    tenantDbMock.mockImplementation((orgId: string) => makeDb(store, orgId));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());
    providerMock.generateVideoFromImage.mockResolvedValue({
      ...providerResult(),
      durationSeconds: 5,
    });

    const characterImage = await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "shared-key",
    });
    const videoFromImage = await requestVideoFromImageGeneration(ctx(), {
      sourceAssetId: "asset-1",
      creatorProfileId: "profile-1",
      aspectRatio: "1:1",
      idempotencyKey: "shared-key",
    });

    expect(characterImage.reused).toBe(false);
    expect(videoFromImage.reused).toBe(false);
    expect(characterImage.generation.id).not.toBe(videoFromImage.generation.id);
  });

  it("CASE 9/10 — two concurrent identical requests: exactly one DB winner, the loser fetches and reuses it", async () => {
    const store = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(store, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValue(providerResult());

    const input = {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1" as const,
      idempotencyKey: "concurrent-key",
    };
    const [first, second] = await Promise.all([
      requestCharacterImageGeneration(ctx(), input),
      requestCharacterImageGeneration(ctx(), input),
    ]);

    // Exactly one of the two actually created+reserved+called the provider;
    // the other reused it. Never both, never neither.
    const reusedFlags = [first.reused, second.reused].sort();
    expect(reusedFlags).toEqual([false, true]);
    expect(first.generation.id).toBe(second.generation.id);
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(providerMock.generateCharacterImage).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1); // never two rows for the same key
  });

  it("CASE 11 — request fingerprint is stable for semantically identical normalized input", async () => {
    const storeA = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(storeA, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValueOnce(providerResult());
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "key-a",
    });

    const storeB = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(storeB, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValueOnce(providerResult());
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "key-b",
    });

    expect(storeA.rows[0]!.requestFingerprint).toBe(storeB.rows[0]!.requestFingerprint);
  });

  it("CASE 12 — request fingerprint changes when provider-impacting input changes", async () => {
    const storeA = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(storeA, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValueOnce(providerResult());
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a portrait",
      aspectRatio: "1:1",
      idempotencyKey: "key-a",
    });

    const storeB = new FakeGenerationStore();
    tenantDbMock.mockReturnValue(makeDb(storeB, "org-a"));
    providerMock.generateCharacterImage.mockResolvedValueOnce(providerResult());
    await requestCharacterImageGeneration(ctx(), {
      creatorProfileId: "profile-1",
      prompt: "a totally different prompt that changes provider output",
      aspectRatio: "1:1",
      idempotencyKey: "key-b",
    });

    expect(storeA.rows[0]!.requestFingerprint).not.toBe(storeB.rows[0]!.requestFingerprint);
  });
});
