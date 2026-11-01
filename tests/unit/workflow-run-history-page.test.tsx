import { describe, expect, it, vi } from "vitest";

/**
 * The workflow page maps each run's stored error to a fixed failure code.
 * The stored text (which can name a provider or database error) must not be
 * passed to the client builder.
 */
const ORG = "11111111-1111-4111-8111-111111111111";
const STORED_ERROR = "step failed (DriverAdapterError)";

vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: ORG, userId: "u1", role: "OWNER" })),
}));
vi.mock("@/server/auth/permissions", () => ({ can: () => true }));
vi.mock("@/server/services/viewer-time-zone", () => ({
  getViewerTimeZone: async () => "Europe/Helsinki",
}));
vi.mock("@/server/services/workflow-activation", () => ({
  getWorkflowActivation: async () => ({ block: null, limit: 1 }),
}));
vi.mock("@/components/workflows/workflow-builder", () => ({ WorkflowBuilder: () => null }));
vi.mock("@/server/services/workflows", () => ({ isInternalOnlyWorkflowOrg: async () => false }));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    workflow: {
      count: async () => 1,
      findFirst: async () => ({
        id: "wf-1",
        name: "Pilot contact workflow test",
        description: null,
        trigger: { type: "contact.created" },
        steps: [],
        isActive: true,
        runs: [
          {
            id: "r1",
            status: "FAILED",
            startedAt: new Date("2026-11-01T15:15:08.000Z"),
            error: STORED_ERROR,
          },
          {
            id: "r2",
            status: "SUCCEEDED",
            startedAt: new Date("2026-11-01T16:00:00.000Z"),
            error: null,
          },
        ],
      }),
    },
  }),
}));

import WorkflowPage from "@/app/[locale]/(app)/workflows/[workflowId]/page";

describe("workflow page run history", () => {
  it("passes a failure code to the builder, never the stored error text", async () => {
    const element = (await WorkflowPage({
      params: Promise.resolve({ workflowId: "wf-1" }),
    })) as { props: { initial: { runs: Array<Record<string, unknown>> } } };
    const runs = element.props.initial.runs;
    expect(runs).toEqual([
      { id: "r1", status: "FAILED", startedAt: "2026-11-01T15:15:08.000Z", failure: "internal" },
      { id: "r2", status: "SUCCEEDED", startedAt: "2026-11-01T16:00:00.000Z", failure: null },
    ]);
    expect(JSON.stringify(element.props)).not.toContain("DriverAdapterError");
  });
});
