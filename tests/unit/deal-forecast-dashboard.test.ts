import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * Dashboard pipeline widget vs deal detail vs board vs Analytics for the same
 * synthetic fixture. The mocked Prisma delegates honour the `where` filters
 * the services pass, so a wrong filter (e.g. counting closed deals in the
 * forecast, or hiding them from Won/Lost rows) changes the result.
 */
const { tenantDbMock } = vi.hoisted(() => ({ tenantDbMock: vi.fn() }));

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock }));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ provider: "openai", model: "test-summary-model" }),
}));
vi.mock("@/server/auth/permissions", () => ({ can: () => false }));

import { getCrmDashboard } from "@/server/services/dashboard";
import { getSalesAnalytics } from "@/server/services/analytics";
import {
  effectiveProbability,
  expectedRevenueCents,
  stageColumnTotals,
} from "@/lib/crm/deal-forecast";

type Stage = {
  id: string;
  name: string;
  order: number;
  probability: number;
  isWon: boolean;
  isLost: boolean;
};
type DealRow = {
  id: string;
  stageId: string;
  pipelineId: string;
  valueCents: number;
  probability: number | null;
  closedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
};

const PIPELINE_ID = "pipeline-1";
const STAGES: Stage[] = [
  { id: "s-new", name: "New lead", order: 0, probability: 10, isWon: false, isLost: false },
  { id: "s-contacted", name: "Contacted", order: 1, probability: 25, isWon: false, isLost: false },
  { id: "s-proposal", name: "Proposal", order: 2, probability: 50, isWon: false, isLost: false },
  { id: "s-won", name: "Won", order: 3, probability: 100, isWon: true, isLost: false },
  { id: "s-lost", name: "Lost", order: 4, probability: 0, isWon: false, isLost: true },
];
const stageById = new Map(STAGES.map((s) => [s.id, s]));
const recent = new Date();

function deal(
  id: string,
  stageId: string,
  valueCents: number,
  probability: number | null,
  extra: Partial<DealRow> = {},
): DealRow {
  return {
    id,
    stageId,
    pipelineId: PIPELINE_ID,
    valueCents,
    probability,
    closedAt: null,
    deletedAt: null,
    createdAt: recent,
    ...extra,
  };
}

function fixture(): DealRow[] {
  return [
    // "Pilot Test Deal": EUR 1,000, stage Contacted (25%), explicit override 50%.
    deal("pilot", "s-contacted", 100_000, 50),
    deal("no-override", "s-contacted", 40_000, null), // 25% -> 10_000
    deal("zero-override", "s-contacted", 30_000, 0), // explicit 0 -> 0
    deal("proposal", "s-proposal", 20_000, null), // 50% -> 10_000
    deal("won", "s-won", 100_000, 50, { closedAt: recent }),
    deal("lost", "s-lost", 70_000, 10, { closedAt: recent }),
    deal("deleted", "s-contacted", 999_900, 90, { deletedAt: recent }),
  ];
}

type Where = { pipelineId?: string; deletedAt?: null; closedAt?: null };
function matches(row: DealRow, where: Where): boolean {
  if (where.pipelineId !== undefined && row.pipelineId !== where.pipelineId) return false;
  if (where.deletedAt === null && row.deletedAt !== null) return false;
  if (where.closedAt === null && row.closedAt !== null) return false;
  return true;
}

function createDb(rows: DealRow[]) {
  return {
    contact: { count: vi.fn(async () => 0) },
    deal: {
      count: vi.fn(async () => 0),
      aggregate: vi.fn(async () => ({ _sum: { valueCents: 0 } })),
      groupBy: vi.fn(async ({ where }: { where: Where }) => {
        const groups = new Map<string, { count: number; sum: number }>();
        for (const row of rows.filter((r) => matches(r, where))) {
          const g = groups.get(row.stageId) ?? { count: 0, sum: 0 };
          g.count += 1;
          g.sum += row.valueCents;
          groups.set(row.stageId, g);
        }
        return [...groups].map(([stageId, g]) => ({
          stageId,
          _count: { _all: g.count },
          _sum: { valueCents: g.sum },
        }));
      }),
      findMany: vi.fn(async ({ where }: { where: Where }) =>
        rows
          .filter((r) => matches(r, where))
          .map(({ stageId, valueCents, probability, closedAt }) => ({
            stageId,
            valueCents,
            probability,
            closedAt,
          })),
      ),
    },
    activity: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    pipeline: {
      findFirst: vi.fn(
        async (args: { include: { stages: { include?: { deals?: { where: Where } } } } }) => {
          const dealsArgs = args.include.stages.include?.deals;
          return {
            id: PIPELINE_ID,
            name: "Sales",
            stages: STAGES.map((s) =>
              dealsArgs
                ? {
                    ...s,
                    deals: rows.filter((r) => r.stageId === s.id && matches(r, dealsArgs.where)),
                  }
                : s,
            ),
          };
        },
      ),
    },
  };
}

const ctx: TenantContext = {
  userId: "user-1",
  email: "user@example.com",
  orgId: "org-1",
  role: "OWNER",
  locale: "en",
};

/** What the deal detail page shows as Expected revenue for one deal. */
function detailExpected(row: DealRow): number {
  const stage = stageById.get(row.stageId)!;
  return expectedRevenueCents(row.valueCents, effectiveProbability(row, stage));
}

/** What the board column header shows for one stage. */
function boardColumn(rows: DealRow[], stageId: string) {
  const stage = stageById.get(stageId)!;
  return stageColumnTotals(
    stage,
    rows
      .filter((r) => r.stageId === stageId && r.deletedAt === null)
      .map((r) => ({ ...r, isClosed: r.closedAt !== null })),
  );
}

describe("dashboard pipeline forecast follows the shared contract", () => {
  let rows: DealRow[];

  beforeEach(() => {
    vi.clearAllMocks();
    rows = fixture();
    tenantDbMock.mockImplementation(() => createDb(rows));
  });

  it("weights the Pilot Test Deal with its 50% override, agreeing with detail and board", async () => {
    const onlyPilot = rows.filter((r) => r.id === "pilot");
    tenantDbMock.mockImplementation(() => createDb(onlyPilot));

    const dashboard = await getCrmDashboard(ctx);
    const pilot = onlyPilot[0]!;

    expect(detailExpected(pilot)).toBe(50_000);
    expect(boardColumn(onlyPilot, "s-contacted").weightedValueCents).toBe(50_000);
    expect(dashboard.pipeline.forecastValueCents).toBe(50_000);
    expect(dashboard.pipeline.openValueCents).toBe(100_000);
  });

  it("sums distinct per-deal weights (override, no override, explicit 0) and excludes closed and deleted deals", async () => {
    const dashboard = await getCrmDashboard(ctx);

    // 50_000 + 10_000 + 0 + 10_000
    expect(dashboard.pipeline.forecastValueCents).toBe(70_000);
    expect(dashboard.pipeline.openValueCents).toBe(190_000);

    const boardForecast = ["s-new", "s-contacted", "s-proposal"].reduce(
      (sum, id) => sum + (boardColumn(rows, id).weightedValueCents ?? 0),
      0,
    );
    const detailForecast = rows
      .filter((r) => r.deletedAt === null && r.closedAt === null)
      .reduce((sum, r) => sum + detailExpected(r), 0);
    expect(boardForecast).toBe(70_000);
    expect(detailForecast).toBe(70_000);
  });

  it("shows real Won/Lost rows that match Analytics and the board headers", async () => {
    const dashboard = await getCrmDashboard(ctx);
    const analytics = await getSalesAnalytics(ctx);

    const row = (id: string) => dashboard.pipeline.stages.find((s) => s.id === id)!;
    expect(row("s-won")).toMatchObject({ count: 1, valueCents: 100_000 });
    expect(row("s-lost")).toMatchObject({ count: 1, valueCents: 70_000 });
    expect(row("s-contacted")).toMatchObject({ count: 3, valueCents: 170_000 });

    for (const stage of dashboard.pipeline.stages) {
      const funnel = analytics.funnel.find((f) => f.order === stage.order)!;
      expect({ count: stage.count, valueCents: stage.valueCents }).toEqual({
        count: funnel.count,
        valueCents: funnel.valueCents,
      });
    }

    expect(boardColumn(rows, "s-won")).toEqual({
      totalValueCents: 100_000,
      weightedValueCents: null,
    });
    expect(boardColumn(rows, "s-lost").totalValueCents).toBe(70_000);
  });

  it.each([
    ["s-won", { count: 2, valueCents: 200_000 }],
    ["s-lost", { count: 2, valueCents: 170_000 }],
  ] as const)(
    "moving the Pilot deal open -> %s removes it from the open forecast",
    async (target, closedRow) => {
      const pilot = rows.find((r) => r.id === "pilot")!;
      pilot.stageId = target;
      pilot.closedAt = new Date();

      const dashboard = await getCrmDashboard(ctx);

      expect(dashboard.pipeline.forecastValueCents).toBe(20_000);
      expect(dashboard.pipeline.openValueCents).toBe(90_000);
      expect(dashboard.pipeline.stages.find((s) => s.id === target)).toMatchObject(closedRow);
    },
  );
});
