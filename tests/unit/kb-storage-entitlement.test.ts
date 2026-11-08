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
 *
 * The fake keeps open upload links as rows (so the sum honours its `where`,
 * including the link being consumed), and models the per-organization advisory
 * lock as a mutex held until the transaction ends.
 */
const MB = 1_048_576;
const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INTENT = "44444444-4444-4444-8444-444444444444";

type OpenLink = { id: string; maxSizeBytes: number };

const s = vi.hoisted(() => ({
  storedBytes: 0,
  links: [] as OpenLink[],
  objectBytes: 0,
  nextLink: 0,
  cache: new Map<string, unknown>(),
  lockTail: Promise.resolve() as Promise<void>,
  order: [] as string[],
  inTransaction: false,
  removed: [] as string[][],
}));

const db = vi.hoisted(() => {
  const documentAggregate = vi.fn(async () => {
    s.order.push("storage");
    return { _sum: { sizeBytes: s.storedBytes } };
  });
  const intentAggregate = vi.fn(async (args: { where: { id?: { not: string } } }) => ({
    _sum: {
      maxSizeBytes: s.links
        .filter((link) => link.id !== args.where.id?.not)
        .reduce((sum, link) => sum + link.maxSizeBytes, 0),
    },
  }));
  const intentCreate = vi.fn(async (args: { data: { maxSizeBytes: number } }) => {
    const link = { id: s.nextLink++ === 0 ? INTENT : `link-${s.nextLink}`, ...args.data };
    s.links.push(link);
    return { id: link.id };
  });
  const tx = {
    $executeRaw: vi.fn(),
    collection: { findFirst: vi.fn(async () => null) },
    document: { aggregate: documentAggregate, create: vi.fn(async () => ({ id: "doc-1" })) },
    documentUploadIntent: {
      aggregate: intentAggregate,
      create: intentCreate,
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  return {
    tx,
    documentAggregate,
    intentAggregate,
    intentCreate,
    intentFindFirst: vi.fn(),
    intentSpend: vi.fn(async () => ({ count: 1 })),
    subscriptionFindUnique: vi.fn(async () => {
      s.order.push("entitlements");
      return null; // FREE plan: no subscription row
    }),
    enqueue: vi.fn(async () => undefined),
  };
});

/**
 * A read through the root client while a transaction is open is the
 * single-connection-pool deadlock (src/server/db/prisma.ts): logged as
 * "root-in-tx" so a test can catch it.
 */
function root<A extends unknown[], R>(fn: (...args: A) => R) {
  return (...args: A): R => {
    if (s.inTransaction) s.order.push("root-in-tx");
    return fn(...args);
  };
}

/** Each transaction gets its own view of the lock; the advisory lock is a mutex. */
async function transaction(fn: (client: typeof db.tx) => unknown) {
  s.order.push("transaction");
  let release: () => void = () => undefined;
  let holding = false;
  const client = {
    ...db.tx,
    $executeRaw: vi.fn(async () => {
      const previous = s.lockTail;
      s.lockTail = new Promise<void>((resolve) => (release = resolve));
      holding = true;
      await previous;
      s.order.push("lock");
      return 0;
    }),
  };
  s.inTransaction = true;
  try {
    return await fn(client);
  } finally {
    s.inTransaction = false;
    if (holding) release();
  }
}

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
    subscription: { findUnique: root(db.subscriptionFindUnique) },
    entitlementGrant: { findMany: root(vi.fn(async () => [])) },
    document: { aggregate: root(db.documentAggregate), update: vi.fn() },
    documentUploadIntent: {
      aggregate: root(db.intentAggregate),
      findFirst: db.intentFindFirst,
      updateMany: db.intentSpend,
    },
    $transaction: vi.fn(transaction),
  },
}));

vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        createSignedUploadUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }),
        remove: async (paths: string[]) => {
          s.removed.push(paths);
          return { data: [], error: null };
        },
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
  s.links = [];
  s.objectBytes = 0;
  s.nextLink = 0;
  s.lockTail = Promise.resolve();
  s.order = [];
  s.removed = [];
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
    s.links = [{ id: "earlier", maxSizeBytes: 30 * MB }]; // not uploaded yet
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

  it("requested in parallel, only the links that fit are issued", async () => {
    // 30 MB free: two 24 MB links at once must not both see the same free space.
    s.storedBytes = 20 * MB;
    const results = await Promise.allSettled([upload(24 * MB), upload(24 * MB)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(s.links).toHaveLength(1);
  });

  it("the plan is read before the transaction opens; the check runs under the lock", async () => {
    // On an entitlements cache miss the plan is read through the root client: with
    // the runtime's single-connection pool that read must not happen inside an open
    // transaction (src/server/db/prisma.ts).
    await upload(1 * MB);
    expect(s.order).toEqual(["entitlements", "transaction", "lock", "storage"]);
    expect(s.order).not.toContain("root-in-tx");
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

  it("a refused upload is discarded: its file is deleted and its link stops reserving space", async () => {
    s.storedBytes = 40 * MB;
    s.objectBytes = 20 * MB;
    await expect(
      createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT }),
    ).rejects.toBeInstanceOf(EntitlementError);
    expect(s.removed).toEqual([[`${ORG}/x/menu.pdf`]]);
    expect(db.intentSpend).toHaveBeenCalledWith({
      where: { id: INTENT, organizationId: ORG, userId: USER, usedAt: null },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("a refused finalize whose link another request already used deletes nothing", async () => {
    // A double submit: the first request created the document from this file;
    // this one is refused (the file now counts in stored bytes) and must not
    // delete the file that document points to.
    s.storedBytes = 40 * MB;
    s.objectBytes = 20 * MB;
    db.intentSpend.mockResolvedValueOnce({ count: 0 });
    await expect(
      createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT }),
    ).rejects.toBeInstanceOf(EntitlementError);
    expect(s.removed).toEqual([]);
  });

  it("a failure while discarding still answers with the storage refusal", async () => {
    s.storedBytes = 40 * MB;
    s.objectBytes = 20 * MB;
    db.intentSpend.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT }),
    ).rejects.toBeInstanceOf(EntitlementError);
  });

  it("an upload within the plan keeps its file", async () => {
    s.storedBytes = 10 * MB;
    s.objectBytes = 20 * MB;
    await createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT });
    expect(s.removed).toEqual([]);
    expect(db.intentSpend).not.toHaveBeenCalled();
  });

  it("the link being used is not counted twice", async () => {
    // 20 MB stored + this link's 20 MB file = 40 MB: fits. Counting the open link
    // as well would make it 60 MB and refuse it.
    s.storedBytes = 20 * MB;
    s.objectBytes = 20 * MB;
    s.links = [{ id: INTENT, maxSizeBytes: 20 * MB }];
    await createDocument(ctx, { sourceType: "UPLOAD", title: "Menu", uploadIntentId: INTENT });
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
    await createDocument(ctx, input);
    expect(s.order[0]).not.toBe("transaction");
    expect(s.order.indexOf("storage")).toBeLessThan(s.order.indexOf("transaction"));
    expect(s.order.indexOf("entitlements")).toBeLessThan(s.order.indexOf("transaction"));
    expect(s.order.filter((step) => step === "storage")).toHaveLength(1);
    expect(s.order).not.toContain("root-in-tx");
  });

  it("a note within the plan is created and processed", async () => {
    s.storedBytes = 10 * MB;
    await createDocument(ctx, { sourceType: "NOTE", title: "Hours", content: "Open 9–17" });
    expect(db.tx.document.create).toHaveBeenCalledTimes(1);
    expect(db.enqueue).toHaveBeenCalledTimes(1);
  });
});
