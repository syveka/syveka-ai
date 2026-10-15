import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client/client";

/**
 * Tell Syveka once: the industry given at onboarding lands in the new org's
 * Business DNA, in the same transaction as the org, and every Business DNA
 * reader sees it through the normal path. The real createOrganization(),
 * createOrganizationAction(), getBusinessDNA(), upsertBusinessDNA() and
 * getBusinessDnaContext() run against an in-memory store whose transaction
 * rolls back on error and whose business_dna.organization_id is unique, as in
 * Postgres.
 */

type Row = Record<string, unknown> & { id: string };
type Tables = Record<
  "organizations" | "members" | "subscriptions" | "pipelines" | "businessDna",
  Row[]
>;

const h = vi.hoisted(() => {
  const empty = (): Tables => ({
    organizations: [],
    members: [],
    subscriptions: [],
    pipelines: [],
    businessDna: [],
  });
  return {
    tables: empty(),
    empty,
    nextId: 0,
    failBusinessDnaCreate: false,
    updateUserById: vi.fn(async (_id: string, _attrs: object) => ({})),
    userUpdate: vi.fn(async (_args: object) => ({})),
    audit: vi.fn(async (_ctx: object, _input: object) => undefined),
    resync: vi.fn(async (_orgId: string) => undefined),
    refreshSession: vi.fn(async () => undefined),
    redirect: vi.fn((path: string) => {
      throw new Error(`NEXT_REDIRECT:${path}`);
    }),
  };
});

function id(prefix: string) {
  h.nextId += 1;
  return `${prefix}-${h.nextId}`;
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function insertBusinessDna(t: Tables, data: Record<string, unknown>): Row {
  if (h.failBusinessDnaCreate) throw new Error("business_dna insert failed");
  if (t.businessDna.some((r) => r.organizationId === data.organizationId)) {
    throw uniqueViolation();
  }
  const now = new Date();
  const row: Row = {
    id: id("dna"),
    displayName: null,
    industry: null,
    description: null,
    productsServices: null,
    supportedLocales: [],
    timezone: null,
    brandTone: null,
    communicationStyle: null,
    responseInstructions: null,
    openingHours: null,
    cancellationPolicy: null,
    bookingPolicy: null,
    refundPolicy: null,
    paymentPolicy: null,
    otherPolicies: null,
    currency: null,
    quoteInstructions: null,
    pricingNotes: null,
    targetCustomer: null,
    keyFacts: [],
    sourceUrl: null,
    extractedAt: null,
    createdAt: now,
    updatedAt: now,
    ...data,
  };
  t.businessDna.push(row);
  return row;
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

/** The transaction client: writes go to `t` (a copy, discarded on error). */
function txClient(t: Tables) {
  return {
    organization: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: id("org"), ...data };
        t.organizations.push(row);
        return row;
      },
    },
    organizationMember: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        t.members.push({ id: id("mem"), ...data });
      },
    },
    subscription: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        t.subscriptions.push({ id: id("sub"), ...data });
      },
    },
    pipeline: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        t.pipelines.push({ id: id("pipe"), ...data });
      },
    },
    businessDNA: {
      create: async ({
        data,
        select,
      }: {
        data: Record<string, unknown>;
        select?: Record<string, boolean>;
      }) => pick(insertBusinessDna(t, data), select),
    },
  };
}

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: {
      findUnique: async ({ where }: { where: { slug: string } }) =>
        h.tables.organizations.find((o) => o.slug === where.slug) ?? null,
    },
    organizationMember: {
      count: async ({ where }: { where: { userId: string } }) =>
        h.tables.members.filter((m) => m.userId === where.userId).length,
    },
    user: { update: h.userUpdate },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const draft = structuredClone(h.tables);
      const result = await fn(txClient(draft));
      h.tables = draft;
      return result;
    },
  },
  // Every query is scoped to one organization, as tenantDb() does.
  tenantDb: (orgId: string) => {
    const own = () => h.tables.businessDna.filter((r) => r.organizationId === orgId);
    return {
      businessDNA: {
        findFirst: async (args: { select?: Record<string, boolean> } = {}) => {
          const row = own()[0];
          return row ? pick(row, args.select) : null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) =>
          insertBusinessDna(h.tables, { ...data, organizationId: orgId }),
        updateMany: async ({
          where,
          data,
        }: {
          where: { updatedAt: Date };
          data: Record<string, unknown>;
        }) => {
          const rows = own().filter(
            (r) => (r.updatedAt as Date).getTime() === where.updatedAt.getTime(),
          );
          for (const r of rows) Object.assign(r, data);
          return { count: rows.length };
        },
      },
      businessDnaService: { findMany: async () => [] },
    };
  },
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseAdmin: () => ({ auth: { admin: { updateUserById: h.updateUserById } } }),
  createSupabaseServer: async () => ({ auth: { refreshSession: h.refreshSession } }),
}));
vi.mock("@/server/services/audit", () => ({ audit: h.audit }));
vi.mock("@/server/services/voice", () => ({ resyncActiveAssistants: h.resync }));
vi.mock("@/server/auth/session", () => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1", email: "owner@example.com" })),
  AuthError: class AuthError extends Error {},
}));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createOrganization } from "@/server/services/organizations";
import { createOrganizationAction } from "@/actions/organization";
import { getBusinessDNA, upsertBusinessDNA } from "@/server/services/business-dna";
import { buildBusinessDnaPromptBlock, getBusinessDnaContext } from "@/server/business-dna/context";
import {
  isBusinessDnaSetupPending,
  missingBusinessDnaFields,
} from "@/lib/business-dna/completeness";
import type { TenantContext } from "@/server/auth/session";

function owner(orgId: string): TenantContext {
  return { userId: "user-1", email: "owner@example.com", orgId, role: "OWNER", locale: "en" };
}

function create(industry: string | undefined, name = "Acme Oy", userId = "user-1") {
  return createOrganization({ userId, name, industry, defaultLocale: "EN" });
}

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.tables = h.empty();
  h.failBusinessDnaCreate = false;
});

describe("createOrganization with an onboarding industry", () => {
  it("creates the org's Business DNA with exactly that industry", async () => {
    const org = await create("Hair salon");

    expect(h.tables.businessDna).toHaveLength(1);
    expect(h.tables.businessDna[0]).toMatchObject({
      organizationId: org.id,
      industry: "Hair salon",
    });
  });

  it("stores only the trimmed industry, and nothing else the owner didn't say", async () => {
    const org = await create("  Hair salon  ");

    const dna = (await getBusinessDNA(owner(org.id)))!;
    expect(dna.industry).toBe("Hair salon");
    expect(missingBusinessDnaFields(dna)).not.toContain("industry");
    expect(missingBusinessDnaFields(dna)).toContain("displayName");
    expect(dna.supportedLocales).toEqual([]);
  });

  it("keeps the industry in Business DNA only, not also in the org settings", async () => {
    const org = await create("Hair salon");
    expect(org.settings).toEqual({});
    expect(h.tables.organizations[0]!.settings).toEqual({});
  });

  it("binds the profile to the new organization and to no other", async () => {
    const a = await create("Hair salon", "Salon A");
    const b = await create("Plumbing", "Pipes B", "user-2");

    expect(await getBusinessDNA(owner(a.id))).toMatchObject({ industry: "Hair salon" });
    expect(await getBusinessDNA(owner(b.id))).toMatchObject({ industry: "Plumbing" });
    expect(h.tables.businessDna.map((r) => r.organizationId).sort()).toEqual([a.id, b.id].sort());
  });

  it("never changes another organization's existing Business DNA", async () => {
    const a = await create("Hair salon", "Salon A");
    const before = structuredClone(h.tables.businessDna[0]);

    await create("Plumbing", "Pipes B", "user-2");
    await create(undefined, "Cafe C", "user-3");

    expect(h.tables.businessDna.find((r) => r.organizationId === a.id)).toEqual(before);
  });

  it("audits the profile's creation alongside the org's", async () => {
    const org = await create("Hair salon");
    const dna = h.tables.businessDna[0]!;
    expect(h.audit).toHaveBeenCalledWith(
      { orgId: org.id, userId: "user-1" },
      { action: "org.create", resourceType: "organization", resourceId: org.id },
    );
    expect(h.audit).toHaveBeenCalledWith(
      { orgId: org.id, userId: "user-1" },
      { action: "business_dna.create", resourceType: "business_dna", resourceId: dna.id },
    );
  });
});

describe("createOrganization without an industry (unchanged)", () => {
  it.each([undefined, "", "   "])("creates no Business DNA for %j", async (industry) => {
    const org = await create(industry);

    expect(h.tables.businessDna).toHaveLength(0);
    expect(await getBusinessDNA(owner(org.id))).toBeNull();
    expect(org.settings).toEqual({});
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it("still creates the membership, subscription and pipeline and activates the org", async () => {
    const org = await create(undefined);

    expect(h.tables.members).toEqual([
      expect.objectContaining({ organizationId: org.id, userId: "user-1", role: "OWNER" }),
    ]);
    expect(h.tables.subscriptions).toEqual([
      expect.objectContaining({ organizationId: org.id, plan: "FREE" }),
    ]);
    expect(h.tables.pipelines).toHaveLength(1);
    expect(h.updateUserById).toHaveBeenCalledWith("user-1", {
      app_metadata: { last_active_org: org.id },
    });
    expect(h.userUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("when the Business DNA can't be created", () => {
  beforeEach(() => {
    h.failBusinessDnaCreate = true;
  });

  it("creates no organization at all: the whole transaction rolls back", async () => {
    await expect(create("Hair salon")).rejects.toThrow("business_dna insert failed");

    expect(h.tables).toEqual(h.empty());
    expect(h.updateUserById).not.toHaveBeenCalled();
    expect(h.userUpdate).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("onboarding shows its error so the owner can try again, with nothing left behind", async () => {
    const result = await createOrganizationAction(
      {},
      formData({ name: "Acme Oy", industry: "Hair salon", defaultLocale: "EN" }),
    );

    expect(result).toEqual({ error: "create_failed" });
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.tables.organizations).toHaveLength(0);
  });

  it("a retry once it works creates exactly one organization and profile", async () => {
    await createOrganizationAction(
      {},
      formData({ name: "Acme Oy", industry: "Hair salon", defaultLocale: "EN" }),
    );
    h.failBusinessDnaCreate = false;

    await expect(
      createOrganizationAction(
        {},
        formData({ name: "Acme Oy", industry: "Hair salon", defaultLocale: "EN" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/settings/business-dna");

    expect(h.tables.organizations).toHaveLength(1);
    expect(h.tables.businessDna).toEqual([
      expect.objectContaining({
        organizationId: h.tables.organizations[0]!.id,
        industry: "Hair salon",
      }),
    ]);
  });
});

describe("onboarding → organization → Business DNA → every normal reader", () => {
  async function onboard(industry: string) {
    await expect(
      createOrganizationAction({}, formData({ name: "Acme Oy", industry, defaultLocale: "EN" })),
    ).rejects.toThrow("NEXT_REDIRECT:/settings/business-dna");
    return h.tables.organizations[0]!.id;
  }

  it("the Business DNA page's read returns the industry", async () => {
    const orgId = await onboard("Hair salon");
    expect(await getBusinessDNA(owner(orgId))).toMatchObject({
      organizationId: orgId,
      industry: "Hair salon",
    });
  });

  it("chat, voice and the other assistants get it in their business context", async () => {
    const orgId = await onboard("Hair salon");

    const context = await getBusinessDnaContext(orgId);
    expect(context?.industry).toBe("Hair salon");
    expect(buildBusinessDnaPromptBlock(context)).toContain("Industry: Hair salon");
    // Chat's setup guidance no longer asks for it.
    expect(missingBusinessDnaFields(context)).not.toContain("industry");
  });

  it("the owner's first save from the page keeps working (the seeded version is current)", async () => {
    const orgId = await onboard("Hair salon");
    const loaded = (await getBusinessDNA(owner(orgId)))!;

    const result = await upsertBusinessDNA(
      owner(orgId),
      {
        industry: "Hair and beauty salon",
        displayName: "Acme",
        supportedLocales: [],
        keyFacts: [],
      },
      (loaded.updatedAt as Date).toISOString(),
    );

    expect(result.ok).toBe(true);
    expect(h.tables.businessDna).toHaveLength(1);
    expect(h.tables.businessDna[0]).toMatchObject({
      industry: "Hair and beauty salon",
      displayName: "Acme",
    });
  });

  it("a form opened before the profile existed can't replace it (existing conflict rule)", async () => {
    const orgId = await onboard("Hair salon");

    const result = await upsertBusinessDNA(
      owner(orgId),
      { industry: "Something else", supportedLocales: [], keyFacts: [] },
      null,
    );

    expect(result).toEqual({ ok: false, reason: "conflict" });
    expect(h.tables.businessDna[0]!.industry).toBe("Hair salon");
  });
});

describe("isBusinessDnaSetupPending (the page's skip link)", () => {
  it("is pending with no profile, or one holding only the onboarding industry", () => {
    expect(isBusinessDnaSetupPending(null, 0)).toBe(true);
    expect(isBusinessDnaSetupPending({ industry: "Hair salon" }, 0)).toBe(true);
    expect(isBusinessDnaSetupPending({ industry: "Hair salon", supportedLocales: [] }, 0)).toBe(
      true,
    );
  });

  it("is not pending once the owner has added anything else", () => {
    expect(isBusinessDnaSetupPending({ industry: "Hair salon", displayName: "Acme" }, 0)).toBe(
      false,
    );
    expect(isBusinessDnaSetupPending({ description: "Cuts and colour" }, 0)).toBe(false);
    expect(isBusinessDnaSetupPending({ industry: "Hair salon" }, 1)).toBe(false);
  });
});
