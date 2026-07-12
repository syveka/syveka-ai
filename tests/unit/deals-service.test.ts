import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock, auditMock, emitWorkflowEventMock, anthropicCreateMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
  auditMock: vi.fn(async () => undefined),
  emitWorkflowEventMock: vi.fn(async () => undefined),
  anthropicCreateMock: vi.fn(async () => ({
    content: [{ type: "text", text: "Deal looks healthy.\nNext: send the proposal." }],
  })),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
  unscopedPrisma: {},
}));

vi.mock("@/server/services/audit", () => ({
  audit: auditMock,
}));

vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: emitWorkflowEventMock,
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(async () => ({}) as never),
  EntitlementError: class EntitlementError extends Error {},
}));

vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: anthropicCreateMock } },
}));

import {
  addDealNote,
  addDealTask,
  buildInsightsPrompt,
  createDeal,
  createStage,
  DealError,
  deleteDeal,
  deleteStage,
  effectiveProbability,
  expectedRevenueCents,
  generateDealInsights,
  getBoard,
  moveDeal,
  toggleDealTask,
} from "@/server/services/deals";

/** Loose shape for asserting on Prisma-style query arguments captured by mocks. */
type QueryArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  include: Record<string, unknown>;
  select: Record<string, unknown>;
};

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MEMBER", locale: "en" };
}

const STAGE_OPEN = {
  id: "stage-open",
  pipelineId: "pipeline-1",
  name: "Tarjous",
  order: 2,
  probability: 50,
  isWon: false,
  isLost: false,
};

const STAGE_WON = {
  id: "stage-won",
  pipelineId: "pipeline-1",
  name: "Voitettu",
  order: 4,
  probability: 100,
  isWon: true,
  isLost: false,
};

function dealRow(id: string, orgId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: orgId,
    pipelineId: "pipeline-1",
    stageId: STAGE_OPEN.id,
    stage: STAGE_OPEN,
    title: "ERP rollout",
    valueCents: 500_000,
    currency: "EUR",
    probability: null as number | null,
    position: 0,
    contactId: "contact-1",
    companyId: "company-1",
    ownerId: "user-1",
    expectedCloseAt: null as Date | null,
    closedAt: null as Date | null,
    lostReason: null as string | null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  };
}

type Stage = typeof STAGE_OPEN;
type PipelineRow = {
  id: string;
  organizationId: string;
  name: string;
  isDefault: boolean;
  stages: Stage[];
};

function pipelineRow(orgId: string, stages: Stage[], id = "pipeline-1"): PipelineRow {
  return { id, organizationId: orgId, name: "Default", isDefault: true, stages };
}

function createMockDb(orgId: string) {
  return {
    pipeline: {
      findFirst: vi.fn(async (_args: QueryArgs): Promise<PipelineRow | null> =>
        pipelineRow(orgId, [STAGE_OPEN]),
      ),
      findFirstOrThrow: vi.fn(async (_args: QueryArgs): Promise<PipelineRow> =>
        pipelineRow(orgId, [STAGE_OPEN, STAGE_WON]),
      ),
    },
    pipelineStage: {
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: "stage-new", ...data })),
      update: vi.fn(async ({ data }: QueryArgs) => ({ id: STAGE_OPEN.id, ...data })),
      delete: vi.fn(async (_args: QueryArgs) => STAGE_OPEN),
    },
    deal: {
      findFirst: vi.fn(async (_args: QueryArgs): Promise<Record<string, unknown> | null> => null),
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => dealRow(`${orgId}-d1`, orgId)),
      count: vi.fn(async (_args: QueryArgs) => 2),
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-new`, ...data })),
      update: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-d1`, ...data })),
    },
    contact: {
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => ({ id: "contact-1" })),
      findMany: vi.fn(async (_args: QueryArgs) => []),
    },
    company: {
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => ({ id: "company-1" })),
    },
    organizationMember: {
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => ({ id: "member-1" })),
      findMany: vi.fn(async (_args: QueryArgs) => []),
    },
    activity: {
      create: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-a1`, ...data })),
      update: vi.fn(async ({ data }: QueryArgs) => ({ id: `${orgId}-a1`, ...data })),
      findFirstOrThrow: vi.fn(async (_args: QueryArgs) => ({ id: `${orgId}-a1` })),
      findMany: vi.fn(async (_args: QueryArgs) => []),
    },
  };
}

type MockDb = ReturnType<typeof createMockDb>;

/** Points the mocked pipeline lookup at a specific stage (assertStageInTenant). */
function stageLookupReturns(db: MockDb, stage: typeof STAGE_OPEN | null) {
  db.pipeline.findFirst.mockImplementation(async (args: QueryArgs) => {
    // getBoard queries by isDefault; stage asserts query by stages.some.id
    if ((args.where as { isDefault?: boolean }).isDefault) {
      return {
        id: "pipeline-1",
        organizationId: "org-a",
        name: "Default",
        isDefault: true,
        stages: [STAGE_OPEN],
      };
    }
    if (!stage) return null;
    return {
      id: stage.pipelineId,
      organizationId: "org-a",
      name: "Default",
      isDefault: true,
      stages: [stage],
    };
  });
}

describe("deals service", () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    db = createMockDb("org-a");
    tenantDbMock.mockReturnValue(db);
    stageLookupReturns(db, STAGE_OPEN);
  });

  describe("effectiveProbability / expectedRevenueCents", () => {
    it("uses the deal override before the stage default", () => {
      expect(effectiveProbability({ probability: 80 }, STAGE_OPEN)).toBe(80);
      expect(effectiveProbability({ probability: null }, STAGE_OPEN)).toBe(50);
    });

    it("forces 100 for won and 0 for lost stages", () => {
      expect(effectiveProbability({ probability: 10 }, STAGE_WON)).toBe(100);
      expect(
        effectiveProbability({ probability: 90 }, { probability: 0, isWon: false, isLost: true }),
      ).toBe(0);
    });

    it("weights revenue by probability", () => {
      expect(expectedRevenueCents(500_000, 50)).toBe(250_000);
      expect(expectedRevenueCents(0, 100)).toBe(0);
      expect(expectedRevenueCents(333, 33)).toBe(110);
    });
  });

  describe("getBoard", () => {
    it("scopes board deals to the tenant and hides deleted deals", async () => {
      await getBoard(ctx("org-a"));

      expect(tenantDbMock).toHaveBeenCalledWith("org-a");
      const args = db.pipeline.findFirst.mock.calls[0]![0]! as unknown as {
        where: { isDefault: boolean };
        include: {
          stages: { include: { deals: { where: Record<string, unknown> } } };
        };
      };
      expect(args.where).toMatchObject({ isDefault: true });
      const dealsWhere = args.include.stages.include.deals.where;
      expect(dealsWhere).toMatchObject({ deletedAt: null, organizationId: "org-a" });
      expect(dealsWhere.OR).toBeDefined();
    });
  });

  describe("createDeal", () => {
    const input = {
      title: "ERP rollout",
      valueCents: 500_000,
      currency: "EUR" as const,
      stageId: STAGE_OPEN.id,
    };

    it("creates the deal in the caller's org with position at the end of the stage", async () => {
      await createDeal(ctx("org-a"), input);

      const data = db.deal.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        title: "ERP rollout",
        valueCents: 500_000,
        currency: "EUR",
        pipelineId: "pipeline-1",
        stageId: STAGE_OPEN.id,
        ownerId: "user-1",
        position: 2,
        closedAt: null,
      });
      expect(auditMock).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-a" }),
        expect.objectContaining({ action: "deal.create", resourceType: "deal" }),
      );
    });

    it("rejects a stage from another tenant", async () => {
      stageLookupReturns(db, null);
      await expect(createDeal(ctx(), input)).rejects.toThrow(DealError);
      expect(db.deal.create).not.toHaveBeenCalled();
    });

    it("verifies contact, company and owner belong to the tenant", async () => {
      await createDeal(ctx(), {
        ...input,
        contactId: "contact-1",
        companyId: "company-1",
        ownerId: "22222222-2222-4222-8222-222222222222",
      });

      expect(db.contact.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "contact-1", deletedAt: null }),
        }),
      );
      expect(db.company.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "company-1", deletedAt: null }),
        }),
      );
      expect(db.organizationMember.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: "22222222-2222-4222-8222-222222222222" }),
        }),
      );
    });

    it("rejects a cross-tenant contact id", async () => {
      db.contact.findFirstOrThrow.mockRejectedValueOnce(new Error("Not found"));
      await expect(createDeal(ctx(), { ...input, contactId: "contact-x" })).rejects.toThrow();
      expect(db.deal.create).not.toHaveBeenCalled();
    });

    it("marks the deal closed when created directly in a won/lost stage", async () => {
      stageLookupReturns(db, STAGE_WON);
      await createDeal(ctx(), { ...input, stageId: STAGE_WON.id });
      const data = db.deal.create.mock.calls[0]![0]!.data;
      expect(data.closedAt).toBeInstanceOf(Date);
    });
  });

  describe("moveDeal", () => {
    it("only reorders when the deal stays in the same stage", async () => {
      await moveDeal(ctx(), { dealId: "deal-1", stageId: STAGE_OPEN.id, position: 3 });

      const data = db.deal.update.mock.calls[0]![0]!.data;
      expect(data).toEqual({ position: 3 });
      expect(db.activity.create).not.toHaveBeenCalled();
      expect(emitWorkflowEventMock).not.toHaveBeenCalled();
    });

    it("moves stages, records a STAGE_CHANGE activity and emits events", async () => {
      stageLookupReturns(db, STAGE_WON);

      await moveDeal(ctx("org-a"), { dealId: "deal-1", stageId: STAGE_WON.id, position: 0 });

      const update = db.deal.update.mock.calls[0]![0]!.data;
      expect(update.stageId).toBe(STAGE_WON.id);
      expect(update.closedAt).toBeInstanceOf(Date);

      const activity = db.activity.create.mock.calls[0]![0]!.data;
      expect(activity).toMatchObject({
        organizationId: "org-a",
        type: "STAGE_CHANGE",
        dealId: "org-a-d1",
        contactId: "contact-1",
        companyId: "company-1",
      });

      expect(emitWorkflowEventMock).toHaveBeenCalledWith(
        "org-a",
        "deal.stage_changed",
        expect.objectContaining({ from: "Tarjous", to: "Voitettu" }),
      );
      expect(emitWorkflowEventMock).toHaveBeenCalledWith(
        "org-a",
        "deal.won",
        expect.objectContaining({ dealId: "deal-1" }),
      );
    });

    it("rejects a stage that belongs to a different pipeline", async () => {
      stageLookupReturns(db, { ...STAGE_WON, pipelineId: "pipeline-other" });
      db.pipeline.findFirst.mockImplementationOnce(async () => ({
        id: "pipeline-other",
        organizationId: "org-a",
        name: "Other",
        isDefault: false,
        stages: [{ ...STAGE_WON, pipelineId: "pipeline-other" }],
      }));

      await expect(
        moveDeal(ctx(), { dealId: "deal-1", stageId: STAGE_WON.id, position: 0 }),
      ).rejects.toThrow(DealError);
      expect(db.deal.update).not.toHaveBeenCalled();
    });

    it("reopens a deal moved back to an open stage", async () => {
      db.deal.findFirstOrThrow.mockResolvedValueOnce(
        dealRow("org-a-d1", "org-a", {
          stageId: STAGE_WON.id,
          stage: STAGE_WON,
          closedAt: new Date(),
        }),
      );

      await moveDeal(ctx(), { dealId: "deal-1", stageId: STAGE_OPEN.id, position: 0 });

      const update = db.deal.update.mock.calls[0]![0]!.data;
      expect(update.closedAt).toBeNull();
      expect(update.lostReason).toBeNull();
    });
  });

  describe("deleteDeal", () => {
    it("soft-deletes and audits", async () => {
      await deleteDeal(ctx(), "deal-1");
      const data = db.deal.update.mock.calls[0]![0]!.data;
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "deal.delete" }),
      );
    });
  });

  describe("notes and tasks", () => {
    it("creates a NOTE activity linked to deal, contact and company", async () => {
      await addDealNote(ctx("org-a"), "deal-1", { body: "Called them\nWent well" });

      const data = db.activity.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        userId: "user-1",
        dealId: "org-a-d1",
        contactId: "contact-1",
        companyId: "company-1",
        type: "NOTE",
        subject: "Called them",
      });
    });

    it("creates a TASK activity with a due date", async () => {
      await addDealTask(ctx(), "deal-1", { title: "Send proposal", dueAt: "2026-08-01T09:00" });

      const data = db.activity.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({ type: "TASK", subject: "Send proposal" });
      expect(data.dueAt).toBeInstanceOf(Date);
    });

    it("verifies the task belongs to the deal before toggling", async () => {
      await toggleDealTask(ctx(), "deal-1", "task-1", true);

      expect(db.activity.findFirstOrThrow).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "task-1", dealId: "deal-1", type: "TASK" }),
        }),
      );
      const data = db.activity.update.mock.calls[0]![0]!.data;
      expect(data.completedAt).toBeInstanceOf(Date);

      await toggleDealTask(ctx(), "deal-1", "task-1", false);
      expect(db.activity.update.mock.calls[1]![0]!.data.completedAt).toBeNull();
    });
  });

  describe("pipeline stages", () => {
    it("appends new stages after the last order", async () => {
      await createStage(ctx(), { name: "Demo", probability: 40, kind: "open" });

      const data = db.pipelineStage.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        pipelineId: "pipeline-1",
        name: "Demo",
        order: STAGE_WON.order + 1,
        probability: 40,
        isWon: false,
        isLost: false,
      });
    });

    it("forces probability for won/lost stages", async () => {
      await createStage(ctx(), { name: "Closed won", probability: 10, kind: "won" });
      const data = db.pipelineStage.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({ probability: 100, isWon: true, isLost: false });
    });

    it("refuses to delete a stage that still has deals", async () => {
      db.deal.count.mockResolvedValueOnce(3);
      await expect(deleteStage(ctx(), STAGE_OPEN.id)).rejects.toThrow(DealError);
      expect(db.pipelineStage.delete).not.toHaveBeenCalled();
    });

    it("refuses to delete the last open stage", async () => {
      db.deal.count.mockResolvedValueOnce(0);
      db.pipeline.findFirstOrThrow.mockResolvedValueOnce({
        id: "pipeline-1",
        organizationId: "org-a",
        name: "Default",
        isDefault: true,
        stages: [STAGE_OPEN],
      });

      await expect(deleteStage(ctx(), STAGE_OPEN.id)).rejects.toThrow("last open stage");
      expect(db.pipelineStage.delete).not.toHaveBeenCalled();
    });
  });

  describe("AI insights", () => {
    it("builds a compact prompt from deal state", () => {
      const prompt = buildInsightsPrompt({
        title: "ERP rollout",
        valueCents: 500_000,
        currency: "EUR",
        probability: 50,
        stageName: "Tarjous",
        stageNames: ["Uusi liidi", "Tarjous", "Voitettu"],
        expectedCloseAt: new Date("2026-08-15T00:00:00Z"),
        contactName: "Ada Lovelace",
        companyName: "Acme Oy",
        openTasks: [{ subject: "Send proposal", dueAt: new Date("2026-07-20T00:00:00Z") }],
        recentActivities: [
          { type: "NOTE", subject: "Kickoff call", createdAt: new Date("2026-07-10T00:00:00Z") },
        ],
      });

      expect(prompt).toContain("Deal: ERP rollout");
      expect(prompt).toContain("Value: 5000.00 EUR");
      expect(prompt).toContain("Win probability: 50%");
      expect(prompt).toContain("Expected close: 2026-08-15");
      expect(prompt).toContain("Send proposal (due 2026-07-20)");
      expect(prompt).toContain("[2026-07-10] NOTE: Kickoff call");
    });

    it("stores the model output as an AI_SUMMARY activity on the timeline", async () => {
      db.deal.findFirst.mockResolvedValueOnce(
        dealRow("org-a-d1", "org-a", {
          pipeline: { id: "pipeline-1", stages: [STAGE_OPEN, STAGE_WON] },
          contact: { id: "contact-1", firstName: "Ada", lastName: "Lovelace", deletedAt: null },
          company: { id: "company-1", name: "Acme Oy", deletedAt: null },
        }),
      );

      await generateDealInsights(ctx("org-a"), "org-a-d1");

      expect(anthropicCreateMock).toHaveBeenCalledTimes(1);
      const data = db.activity.create.mock.calls[0]![0]!.data;
      expect(data).toMatchObject({
        organizationId: "org-a",
        dealId: "org-a-d1",
        type: "AI_SUMMARY",
        subject: "Deal looks healthy.",
      });
      expect(auditMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "deal.ai_insights" }),
      );
    });
  });

  it("uses the caller's org for every operation (tenant isolation)", async () => {
    const dbB = createMockDb("org-b");
    stageLookupReturns(dbB, STAGE_OPEN);
    tenantDbMock.mockImplementation((orgId: string) => (orgId === "org-b" ? dbB : db));

    await addDealNote(ctx("org-b"), "deal-1", { body: "Note" });

    expect(tenantDbMock).toHaveBeenLastCalledWith("org-b");
    expect(dbB.activity.create).toHaveBeenCalled();
    expect(db.activity.create).not.toHaveBeenCalled();
  });
});
