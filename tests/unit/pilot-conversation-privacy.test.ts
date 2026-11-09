import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * The real conversation queries over the real tenantDb extension and a fake
 * Prisma that evaluates the where clause it receives, including OR. A colleague's
 * private conversation stays hidden because of the service's own clause.
 */
const s = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Args = { where: Row };
  const state = { conversations: [] as Row[] };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([key, value]) =>
      key === "OR" ? (value as Row[]).some((clause) => matches(row, clause)) : row[key] === value,
    );
  const findMany = vi.fn(async ({ where }: Args) =>
    state.conversations.filter((row) => matches(row, where)),
  );
  const findFirst = vi.fn(
    async ({ where }: Args) => state.conversations.find((row) => matches(row, where)) ?? null,
  );
  const models: Record<string, Record<string, (args: Args) => Promise<unknown>>> = {
    conversation: { findMany, findFirst },
  };
  return {
    state,
    findMany,
    findFirst,
    prisma: {
      $extends: (config: {
        query: { $allModels: { $allOperations: (input: unknown) => Promise<unknown> } };
      }) =>
        new Proxy(
          {},
          {
            get: (_target, modelKey) =>
              new Proxy(
                {},
                {
                  get: (_inner, operation) => (args: Args) =>
                    config.query.$allModels.$allOperations({
                      model: String(modelKey).charAt(0).toUpperCase() + String(modelKey).slice(1),
                      operation: String(operation),
                      args,
                      query: (finalArgs: Args) =>
                        models[String(modelKey)]![String(operation)]!(finalArgs),
                    }),
                },
              ),
          },
        ),
    },
  };
});

vi.mock("@/server/db/prisma", () => ({ prisma: s.prisma }));
vi.mock("@/server/integrations/anthropic", () => ({ anthropic: {} }));
vi.mock("@/server/services/billing/entitlements", () => ({ recordUsage: vi.fn() }));

import { getConversationWithMessages, listConversations } from "@/server/services/conversations";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ME = "11111111-1111-4111-8111-111111111111";
const COLLEAGUE = "22222222-2222-4222-8222-222222222222";

const ctx: TenantContext = {
  userId: ME,
  email: "me@example.test",
  orgId: ORG_A,
  role: "MEMBER",
  locale: "en",
};
const OWN_OR_SHARED = [{ userId: ME }, { isShared: true }];
const conversation = (
  id: string,
  organizationId: string,
  userId: string,
  isShared: boolean,
  deletedAt: Date | null = null,
) => ({ id, organizationId, userId, isShared, deletedAt });

beforeEach(() => {
  vi.clearAllMocks();
  s.state.conversations = [
    conversation("mine-private", ORG_A, ME, false),
    conversation("colleague-shared", ORG_A, COLLEAGUE, true),
    conversation("colleague-private", ORG_A, COLLEAGUE, false),
    conversation("mine-deleted", ORG_A, ME, false, new Date("2026-10-01T00:00:00Z")),
    conversation("other-org-shared", ORG_B, COLLEAGUE, true),
  ];
});

describe("listConversations", () => {
  it("returns the caller's own and shared conversations only", async () => {
    const rows = await listConversations(ctx);

    expect(rows.map((row) => row.id).sort()).toEqual(["colleague-shared", "mine-private"]);
  });

  it("filters by own-or-shared, not deleted and the caller's organization", async () => {
    await listConversations(ctx);

    expect(s.findMany.mock.calls[0]![0].where).toEqual({
      deletedAt: null,
      OR: OWN_OR_SHARED,
      organizationId: ORG_A,
    });
  });
});

describe("getConversationWithMessages", () => {
  it.each(["mine-private", "colleague-shared"])("opens %s", async (id) => {
    await expect(getConversationWithMessages(ctx, id)).resolves.toMatchObject({ id });
  });

  it.each(["colleague-private", "mine-deleted", "other-org-shared", "missing"])(
    "returns null for %s",
    async (id) => {
      await expect(getConversationWithMessages(ctx, id)).resolves.toBeNull();
    },
  );

  it("applies the same own-or-shared clause to a direct id lookup", async () => {
    await getConversationWithMessages(ctx, "colleague-private");

    expect(s.findFirst.mock.calls[0]![0].where).toEqual({
      id: "colleague-private",
      deletedAt: null,
      OR: OWN_OR_SHARED,
      organizationId: ORG_A,
    });
  });
});
