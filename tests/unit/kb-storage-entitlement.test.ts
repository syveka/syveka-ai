import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DocumentIngestion from "@/server/security/document-ingestion";

/**
 * Knowledge base storage limit, end to end through the documents service and
 * the real entitlement check (FREE plan: 50 MB). Only the database, Redis and
 * storage are faked.
 *
 * The limit counts what is stored plus what open upload links may still add,
 * and it is checked again with the real size when the document is created:
 * otherwise several upload links requested before any upload finishes, or
 * notes and URLs (which never asked for a link), go past the plan's limit.
 */
const MB = 1_048_576;
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INTENT = "44444444-4444-4444-8444-444444444444";

const s = vi.hoisted(() => ({
  storedBytes: 0,
  openIntentBytes: 0,
  objectBytes: 0,
  cache: new Map<string, unknown>(),
}));

const db = vi.hoisted(() => {
  const documentAggregate = vi.fn(async () => ({ _sum: { sizeBytes: s.storedBytes } }));
  const intentAggregate = vi.fn(async () => ({ _sum: { maxSizeBytes: s.openIntentBytes } }));
  const tx = {
    collection: { findFirst: vi.fn(async () => null) },
    document: { aggregate: documentAggregate, create: vi.fn(async () => ({ id: "doc-1" })) },
    documentUploadIntent: {
      aggregate: intentAggregate,
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return {
    tx,
    transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    documentAggregate,
    intentAggregate,
    intentCreate: vi.fn(async () => ({ id: INTENT })),
    intentFindFirst: vi.fn(),
    enqueue: vi.fn(async () => undefined),
  };
});

vi.mock("@/server/integrations/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => s.cache.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => void s.cache.set(key, value)),
    del: vi.fn(async (key: string) => void s.cache.delete(key)),
  },
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    document: { aggregate: db.documentAggregate },
    documentUploadIntent: {
      aggregate: db.intentAggregate,
      create: db.intentCreate,
      delete: vi.fn(),
    },
  })),
  unscopedPrisma: {
    // FREE plan: no subscription row, no grants.
    subscription: { findUnique: vi.fn(async () => null) },
    entitlementGrant: { findMany: vi.fn(async () => []) },
    document: { aggregate: db.documentAggregate, update: vi.fn() },
    documentUploadIntent: { aggregate: db.intentAggregate, findFirst: db.intentFindFirst },
    $transaction: db.transaction,
  },
}));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }),
        download: async () => ({
          data: {
            type: "application/pdf",
            arrayBuffer: async () => new ArrayBuffer(s.objectBytes),
          },
          error: null,
        }),
      }),
    },
  }),
}));

vi.mock("@/server/security/document-ingestion", async (importOriginal) => {
  const actual = await importOriginal<typeof DocumentIngestion>();
  // File-content checks (magic bytes, declared size) have their own tests.
  return { ...actual, verifyUploadObject: vi.fn() };
});
vi.mock("@/server/jobs/queue", () => ({ enqueue: db.enqueue }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));

import { createDocument, createUploadUrl } from "@/server/services/documents";
import { EntitlementError } from "@/server/services/billing/entitlements";

const ctx = {
  orgId: ORG,
  userId: USER,
  email: "member@example.test",
  role: "MEMBER" as const,
  locale: "EN" as const,
};

const upload = (sizeBytes: number) =>
  createUploadUrl(ctx, { fileName: "menu.pdf", mimeType: "application/pdf", sizeBytes });

beforeEach(() => {
  vi.clearAllMocks();
  s.cache.clear();
  s.storedBytes = 0;
  s.openIntentBytes = 0;
  s.objectBytes = 0;
  db.intentFindFirst.mockResolvedValue({
    id: INTENT,
    organizationId: ORG,
    userId: USER,
    storagePath: `${ORG}/x/menu.pdf`,
    expectedMimeType: "application/pdf",
    maxSizeBytes: 30 * MB,
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
  });
});

describe("upload links", () => {
  it("count the space that open upload links can still fill", async () => {
    s.openIntentBytes = 30 * MB; // earlier links, not uploaded yet
    await expect(upload(24 * MB)).rejects.toBeInstanceOf(EntitlementError);
    expect(db.intentCreate).not.toHaveBeenCalled();
    expect(db.intentAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, usedAt: null }),
      }),
    );
  });

  it("allow a file that fills the plan exactly (50 MB of 50 MB)", async () => {
    s.storedBytes = 26 * MB;
    await expect(upload(24 * MB)).resolves.toMatchObject({ uploadIntentId: INTENT });
  });

  it("refuse a file that goes past the plan", async () => {
    s.storedBytes = 26 * MB;
    await expect(upload(24 * MB + 1)).rejects.toBeInstanceOf(EntitlementError);
  });
});

describe("creating the document re-checks with the real size", () => {
  it("an upload that no longer fits is refused before the link is spent or the file is processed", async () => {
    s.storedBytes = 40 * MB; // other uploads finished after this link was issued
    s.objectBytes = 20 * MB;
    await expect(
      createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT }),
    ).rejects.toBeInstanceOf(EntitlementError);
    expect(db.tx.documentUploadIntent.updateMany).not.toHaveBeenCalled();
    expect(db.tx.document.create).not.toHaveBeenCalled();
    expect(db.enqueue).not.toHaveBeenCalled();
  });

  it("the link being used is not counted twice", async () => {
    s.storedBytes = 20 * MB;
    s.objectBytes = 20 * MB;
    await createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT });
    expect(db.intentAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: INTENT } }) }),
    );
    expect(db.tx.document.create).toHaveBeenCalledTimes(1);
  });

  it("a note is refused when the plan is full", async () => {
    s.storedBytes = 50 * MB;
    await expect(
      createDocument(ctx, { sourceType: "NOTE", title: "Hours", content: "Open 9–17" }),
    ).rejects.toBeInstanceOf(EntitlementError);
    expect(db.tx.document.create).not.toHaveBeenCalled();
  });

  it("a URL is refused when storage is already past the plan", async () => {
    s.storedBytes = 51 * MB; // e.g. after a downgrade
    await expect(
      createDocument(ctx, {
        sourceType: "URL",
        title: "Site",
        sourceUrl: "https://example.com/menu",
      }),
    ).rejects.toBeInstanceOf(EntitlementError);
    expect(db.tx.document.create).not.toHaveBeenCalled();
  });

  // The runtime pool has one connection (src/server/db/prisma.ts): the entitlement
  // lookup on a cache miss uses the root client, so inside an open transaction it
  // would wait for the connection that transaction holds until the transaction
  // times out. Every storage read must finish before the transaction opens.
  it.each([
    ["UPLOAD", { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT }],
    ["NOTE", { sourceType: "NOTE", title: "Hours", content: "Open 9–17" }],
    ["URL", { sourceType: "URL", title: "Site", sourceUrl: "https://example.com/menu" }],
  ] as const)("%s: the storage check runs before the transaction opens", async (_kind, input) => {
    s.objectBytes = 1 * MB;
    const order: string[] = [];
    db.transaction.mockImplementationOnce(async (fn: (client: typeof db.tx) => unknown) => {
      order.push("transaction");
      return fn(db.tx);
    });
    db.documentAggregate.mockImplementation(async () => {
      order.push("storage");
      return { _sum: { sizeBytes: s.storedBytes } };
    });
    await createDocument(ctx, input);
    expect(order[0]).toBe("storage");
    expect(order.filter((step) => step === "storage")).toHaveLength(1);
  });

  it("a note within the plan is created and processed", async () => {
    s.storedBytes = 10 * MB;
    await createDocument(ctx, { sourceType: "NOTE", title: "Hours", content: "Open 9–17" });
    expect(db.tx.document.create).toHaveBeenCalledTimes(1);
    expect(db.enqueue).toHaveBeenCalledTimes(1);
  });
});
