import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";
import type { DealInput } from "@/lib/validators/crm";

/**
 * The real updateDeal over the real tenantDb extension and a stateful fake
 * Prisma. A foreign record is rejected because tenantDb adds organizationId to
 * the lookup and the fake honours it, as the database would.
 */
const s = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  type Args = { where: Row; data?: Row };
  const state = {
    deals: [] as Row[],
    contacts: [] as Row[],
    companies: [] as Row[],
    members: [] as Row[],
    writes: [] as string[],
  };
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const findOrThrow =
    (rows: () => Row[]) =>
    async ({ where }: Args) => {
      const row = rows().find((candidate) => matches(candidate, where));
      if (!row) throw Object.assign(new Error("No record found"), { code: "P2025" });
      return row;
    };
  const models: Record<string, Record<string, (args: Args) => Promise<unknown>>> = {
    deal: {
      findFirstOrThrow: findOrThrow(() => state.deals),
      update: async ({ where, data }) => {
        state.writes.push("deal.update");
        const row = state.deals.find((candidate) => matches(candidate, where));
        if (!row) throw Object.assign(new Error("No record found"), { code: "P2025" });
        return Object.assign(row, data);
      },
    },
    contact: { findFirstOrThrow: findOrThrow(() => state.contacts) },
    company: { findFirstOrThrow: findOrThrow(() => state.companies) },
    organizationMember: { findFirstOrThrow: findOrThrow(() => state.members) },
  };
  return {
    state,
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
    audit: vi.fn(),
    emitWorkflowEvent: vi.fn(),
  };
});

vi.mock("@/server/db/prisma", () => ({ prisma: s.prisma }));
vi.mock("@/server/services/audit", () => ({ audit: s.audit }));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: s.emitWorkflowEvent }));
vi.mock("@/server/services/viewer-time-zone", () => ({
  getViewerTimeZone: vi.fn(async () => "Europe/Helsinki"),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  EntitlementError: class EntitlementError extends Error {},
}));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/business-dna/context", () => ({
  buildBusinessDnaPromptBlock: vi.fn(),
  getBusinessDnaContext: vi.fn(),
}));

import { updateDeal } from "@/server/services/deals";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEAL_A = "10000000-0000-4000-8000-000000000001";
const DEAL_B = "10000000-0000-4000-8000-000000000002";
const STAGE = "20000000-0000-4000-8000-000000000001";
const CONTACT_A = "30000000-0000-4000-8000-000000000001";
const CONTACT_B = "30000000-0000-4000-8000-000000000002";
const CONTACT_DELETED = "30000000-0000-4000-8000-000000000003";
const COMPANY_A = "40000000-0000-4000-8000-000000000001";
const COMPANY_B = "40000000-0000-4000-8000-000000000002";
const COMPANY_DELETED = "40000000-0000-4000-8000-000000000003";
const OWNER_A = "50000000-0000-4000-8000-000000000001";
const OWNER_B = "50000000-0000-4000-8000-000000000002";

const ctx: TenantContext = {
  userId: OWNER_A,
  email: "owner@example.test",
  orgId: ORG_A,
  role: "MEMBER",
  locale: "en",
};
const baseInput = {
  title: "Renamed deal",
  valueCents: 2_000,
  currency: "EUR" as const,
  stageId: STAGE,
};
const dealRow = (id: string, organizationId: string) => ({
  id,
  organizationId,
  title: "Original deal",
  valueCents: 1_000,
  stageId: STAGE,
  ownerId: OWNER_A,
  deletedAt: null,
  stage: { id: STAGE, name: "Tarjous" },
});
const dealA = () => s.state.deals.find((deal) => deal.id === DEAL_A)!;

beforeEach(() => {
  vi.clearAllMocks();
  s.state.writes.length = 0;
  s.state.deals = [dealRow(DEAL_A, ORG_A), dealRow(DEAL_B, ORG_B)];
  s.state.contacts = [
    { id: CONTACT_A, organizationId: ORG_A, deletedAt: null },
    { id: CONTACT_B, organizationId: ORG_B, deletedAt: null },
    { id: CONTACT_DELETED, organizationId: ORG_A, deletedAt: new Date() },
  ];
  s.state.companies = [
    { id: COMPANY_A, organizationId: ORG_A, deletedAt: null },
    { id: COMPANY_B, organizationId: ORG_B, deletedAt: null },
    { id: COMPANY_DELETED, organizationId: ORG_A, deletedAt: new Date() },
  ];
  s.state.members = [
    { id: "member-a", organizationId: ORG_A, userId: OWNER_A },
    { id: "member-b", organizationId: ORG_B, userId: OWNER_B },
  ];
});

describe("updateDeal tenant checks", () => {
  it("accepts a contact, company and owner from the caller's organization", async () => {
    await updateDeal(ctx, DEAL_A, {
      ...baseInput,
      contactId: CONTACT_A,
      companyId: COMPANY_A,
      ownerId: OWNER_A,
    });

    expect(s.state.writes).toEqual(["deal.update"]);
    expect(dealA()).toMatchObject({
      title: "Renamed deal",
      contactId: CONTACT_A,
      companyId: COMPANY_A,
      ownerId: OWNER_A,
    });
    expect(s.audit).toHaveBeenCalledTimes(1);
  });

  const rejected: Array<[string, Partial<DealInput>]> = [
    ["a contact from another organization", { contactId: CONTACT_B }],
    ["a company from another organization", { companyId: COMPANY_B }],
    ["an owner who belongs only to another organization", { ownerId: OWNER_B }],
    ["a soft-deleted contact", { contactId: CONTACT_DELETED }],
    ["a soft-deleted company", { companyId: COMPANY_DELETED }],
  ];

  it.each(rejected)("rejects %s with no write", async (_name, override) => {
    await expect(updateDeal(ctx, DEAL_A, { ...baseInput, ...override })).rejects.toMatchObject({
      code: "P2025",
    });

    expect(s.state.writes).toEqual([]);
    expect(dealA().title).toBe("Original deal");
    expect(s.audit).not.toHaveBeenCalled();
    expect(s.emitWorkflowEvent).not.toHaveBeenCalled();
  });

  it("rejects another organization's deal with no write", async () => {
    await expect(updateDeal(ctx, DEAL_B, baseInput)).rejects.toMatchObject({ code: "P2025" });

    expect(s.state.writes).toEqual([]);
    expect(s.state.deals.find((deal) => deal.id === DEAL_B)!.title).toBe("Original deal");
    expect(s.audit).not.toHaveBeenCalled();
  });
});
