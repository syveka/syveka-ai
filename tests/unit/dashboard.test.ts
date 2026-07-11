import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock } = vi.hoisted(() => ({
  tenantDbMock: vi.fn(),
}));

const { allowedPermissions } = vi.hoisted(() => ({
  allowedPermissions: new Set<string>(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: tenantDbMock,
}));

vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ provider: "openai", model: "test-summary-model" }),
}));

vi.mock("@/server/auth/permissions", () => ({
  can: (_role: string, permission: string) => allowedPermissions.has(permission),
}));

import { getCrmDashboard } from "@/server/services/dashboard";

type MockDb = ReturnType<typeof createMockDb>;

const baseDate = new Date("2026-07-12T10:00:00.000Z");

const orgData = {
  orgA: {
    totalCustomers: 7,
    currentCustomers: 3,
    previousCustomers: 2,
    activeDeals: 5,
    revenueCents: 123400,
    tasksDueToday: 2,
    overdueTasks: 1,
    aiConversations: 4,
    aiMessagesThisMonth: 88,
    pipelineValueCents: 50000,
    calendarTitle: "Org A board review",
    customerActivitySubject: "Org A renewal call",
    conversationTitle: "Org A account plan",
    subscriptionPlan: "PRO",
    taskSubject: "Org A follow-up",
  },
  orgB: {
    totalCustomers: 99,
    currentCustomers: 50,
    previousCustomers: 25,
    activeDeals: 42,
    revenueCents: 999900,
    tasksDueToday: 8,
    overdueTasks: 6,
    aiConversations: 15,
    aiMessagesThisMonth: 500,
    pipelineValueCents: 77000,
    calendarTitle: "Org B private meeting",
    customerActivitySubject: "Org B private activity",
    conversationTitle: "Org B private chat",
    subscriptionPlan: "ENTERPRISE",
    taskSubject: "Org B private task",
  },
} as const;

function ctx(role: TenantContext["role"], orgId = "orgA"): TenantContext {
  return {
    userId: "user-1",
    email: "user@example.com",
    orgId,
    role,
    locale: "en",
  };
}

function allowPermissions(...permissions: string[]) {
  allowedPermissions.clear();
  for (const permission of permissions) allowedPermissions.add(permission);
}

function createMockDb(orgId: keyof typeof orgData) {
  const data = orgData[orgId];
  const stages = [
    { id: `${orgId}-stage-open`, name: `${orgId} Open`, isWon: false, isLost: false },
    { id: `${orgId}-stage-won`, name: `${orgId} Won`, isWon: true, isLost: false },
  ];

  return {
    contact: {
      count: vi.fn(async ({ where }: { where: { createdAt?: { gte: Date; lt?: Date } } }) => {
        if (!where.createdAt) return data.totalCustomers;
        return where.createdAt.lt ? data.previousCustomers : data.currentCustomers;
      }),
    },
    deal: {
      count: vi.fn(async () => data.activeDeals),
      aggregate: vi.fn(async () => ({ _sum: { valueCents: data.revenueCents } })),
      groupBy: vi.fn(async () => [
        {
          stageId: stages[0]!.id,
          _count: { _all: data.activeDeals },
          _sum: { valueCents: data.pipelineValueCents },
        },
      ]),
    },
    activity: {
      count: vi.fn(async ({ where }: { where: { dueAt: { lt?: Date } } }) =>
        where.dueAt.lt ? data.overdueTasks : data.tasksDueToday,
      ),
      findMany: vi.fn(async ({ where }: { where: { type: unknown; dueAt?: unknown } }) => {
        if (where.type === "TASK" && where.dueAt) {
          return [
            {
              id: `${orgId}-upcoming-task`,
              subject: data.taskSubject,
              dueAt: baseDate,
              contact: null,
              deal: null,
            },
          ];
        }

        if (where.type === "TASK") {
          return [
            {
              id: `${orgId}-recent-task`,
              subject: data.taskSubject,
              dueAt: baseDate,
              completedAt: null,
              contact: null,
              deal: null,
            },
          ];
        }

        return [
          {
            id: `${orgId}-activity`,
            type: "CALL",
            subject: data.customerActivitySubject,
            createdAt: baseDate,
            contact: { firstName: "Ada", lastName: orgId },
            deal: null,
          },
        ];
      }),
    },
    pipeline: {
      findFirst: vi.fn(async () => ({ id: `${orgId}-pipeline`, name: `${orgId} Pipeline`, stages })),
    },
    conversation: {
      count: vi.fn(async () => data.aiConversations),
      findMany: vi.fn(async () => [
        {
          id: `${orgId}-conversation`,
          title: data.conversationTitle,
          updatedAt: baseDate,
          model: "gpt-test",
        },
      ]),
    },
    usageRecord: {
      aggregate: vi.fn(async () => ({ _sum: { quantity: data.aiMessagesThisMonth } })),
    },
    subscription: {
      findFirst: vi.fn(async () => ({
        id: `${orgId}-subscription`,
        plan: data.subscriptionPlan,
        status: "ACTIVE",
        updatedAt: baseDate,
        currentPeriodEnd: baseDate,
      })),
    },
    calendarEvent: {
      findMany: vi.fn(async () => [
        {
          id: `${orgId}-event`,
          title: data.calendarTitle,
          startsAt: baseDate,
          endsAt: baseDate,
          source: "MANUAL",
        },
      ]),
    },
  };
}

describe("CRM dashboard permission isolation", () => {
  let db: MockDb;

  beforeEach(() => {
    vi.clearAllMocks();
    allowPermissions("crm:read");
    db = createMockDb("orgA");
    tenantDbMock.mockReturnValue(db);
  });

  it("does not fetch or return billing data without billing permission", async () => {
    const dashboard = await getCrmDashboard(ctx("VIEWER"));

    expect(db.subscription.findFirst).not.toHaveBeenCalled();
    expect(dashboard.permissions.canViewBilling).toBe(false);
    expect(dashboard.feed.payments).toEqual([]);
  });

  it("does not fetch or return AI conversation metadata without chat permission", async () => {
    const dashboard = await getCrmDashboard(ctx("VIEWER"));

    expect(db.conversation.count).not.toHaveBeenCalled();
    expect(db.conversation.findMany).not.toHaveBeenCalled();
    expect(db.usageRecord.aggregate).not.toHaveBeenCalled();
    expect(dashboard.permissions.canUseChat).toBe(false);
    expect(dashboard.kpis.aiConversations).toBe(0);
    expect(dashboard.feed.aiActivities).toEqual([]);
  });

  it("omits calendar meetings without calendar permission", async () => {
    const dashboard = await getCrmDashboard(ctx("VIEWER"));

    expect(db.calendarEvent.findMany).not.toHaveBeenCalled();
    expect(dashboard.permissions.canReadCalendar).toBe(false);
    expect(dashboard.calendar.meetings).toEqual([]);
  });

  it("returns authorized billing, AI, and calendar sections", async () => {
    allowPermissions("crm:read", "crm:write", "billing:view", "chat:use", "calendar:read");

    const dashboard = await getCrmDashboard(ctx("OWNER"));

    expect(dashboard.permissions).toMatchObject({
      canReadCalendar: true,
      canUseChat: true,
      canViewBilling: true,
      canWriteCrm: true,
    });
    expect(dashboard.feed.payments).toHaveLength(1);
    expect(dashboard.feed.aiActivities).toHaveLength(1);
    expect(dashboard.calendar.meetings).toHaveLength(1);
    expect(dashboard.kpis.aiMessagesThisMonth).toBe(orgData.orgA.aiMessagesThisMonth);
  });

  it("quick-action capabilities match server permissions", async () => {
    allowPermissions("crm:read");
    const viewerDashboard = await getCrmDashboard(ctx("VIEWER"));
    allowPermissions("crm:read", "crm:write", "chat:use", "calendar:read");
    const memberDashboard = await getCrmDashboard(ctx("MEMBER"));

    expect(viewerDashboard.permissions).toMatchObject({
      canWriteCrm: false,
      canReadCalendar: false,
      canUseChat: false,
    });
    expect(memberDashboard.permissions).toMatchObject({
      canWriteCrm: true,
      canReadCalendar: true,
      canUseChat: true,
    });
  });

  it("does not return another tenant's dashboard data", async () => {
    allowPermissions("crm:read", "crm:write", "billing:view", "chat:use", "calendar:read");
    tenantDbMock.mockImplementation((orgId: keyof typeof orgData) => createMockDb(orgId));

    const dashboard = await getCrmDashboard(ctx("OWNER", "orgA"));

    expect(tenantDbMock).toHaveBeenCalledWith("orgA");
    expect(dashboard.kpis.totalCustomers).toBe(orgData.orgA.totalCustomers);
    expect(dashboard.feed.customerActivities[0]?.subject).toBe(orgData.orgA.customerActivitySubject);
    expect(dashboard.feed.aiActivities[0]?.title).toBe(orgData.orgA.conversationTitle);
    expect(dashboard.calendar.meetings[0]?.title).toBe(orgData.orgA.calendarTitle);
    expect(JSON.stringify(dashboard)).not.toContain(orgData.orgB.customerActivitySubject);
    expect(JSON.stringify(dashboard)).not.toContain(orgData.orgB.conversationTitle);
    expect(JSON.stringify(dashboard)).not.toContain(orgData.orgB.calendarTitle);
  });
});
