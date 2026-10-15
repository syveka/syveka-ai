import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A run parked on wait.duration resumes in a new delivery that rebuilds the
 * step variables from the run's persisted stepResults. An ai.generate step's
 * text must still be reachable afterwards under the name the workflow gave it
 * (`{{vars.<outputVar>}}`, the builder's default being `text<id>`), not only
 * under its step id.
 *
 * Drives the real run-workflow route through a fresh trigger and then the
 * resume it enqueued; synthetic data, an in-memory fake, mocked providers.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const CREATOR = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  workflow: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
  stepExecs: [] as Array<Record<string, unknown>>,
}));
const fx = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_params: { react: { body: string } }) => ({ id: "email-1" })),
  anthropic: vi.fn(async () => ({
    content: [{ type: "text", text: "Thanks for your interest!" }],
    usage: { output_tokens: 1 },
  })),
  enqueue: vi.fn(async (_job: string, _payload: Record<string, unknown>, _opts?: unknown) => {}),
}));

const db = {
  workflow: {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.workflow &&
      state.workflow.id === where.id &&
      state.workflow.organizationId === where.organizationId
        ? state.workflow
        : null,
    ),
  },
  workflowRun: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const run = {
        id: `00000000-0000-4000-8000-00000000000${state.runs.length + 1}`,
        stepResults: [],
        startedAt: new Date(),
        ...data,
      };
      state.runs.push(run);
      return run;
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find(
        (r) =>
          r.id === where.id &&
          (where.organizationId === undefined || r.organizationId === where.organizationId),
      );
      if (!run) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      // Persisted as JSON, as the database would: no shared references.
      Object.assign(run, JSON.parse(JSON.stringify(data)));
      return run;
    }),
  },
  workflowStepExecution: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      const exec = { id: `exec-${state.stepExecs.length + 1}`, startedAt: new Date(), ...data };
      state.stepExecs.push(exec);
      return exec;
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const exec = state.stepExecs.find((s) => s.id === where.id);
      if (!exec) return { count: 0 };
      Object.assign(exec, data);
      return { count: 1 };
    }),
  },
  organizationMember: { findFirst: vi.fn(async () => ({ id: "member-1" })) },
  notification: { create: vi.fn(async () => ({})) },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (req: Request) => req.text() }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
}));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: async () => true,
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: fx.enqueue }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: fx.anthropic } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: fx.sendEmail }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: vi.fn(async () => undefined),
  getEntitlements: async () => ({ readOnly: false, activeWorkflows: 5 }),
}));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: async () => undefined,
  AiSpendError: class extends Error {},
}));
vi.mock("../../emails/workflow-notification", () => ({
  WorkflowNotificationEmail: (props: unknown) => props,
}));

import "@/server/jobs/organization-guard";
import { POST } from "@/app/api/v1/jobs/run-workflow/route";

function deliver(body: Record<string, unknown>) {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

const trigger = {
  workflowId: WORKFLOW,
  orgId: ORG,
  triggerType: "contact.created",
  triggerData: { contactId: "c1", firstName: "Maija", email: "maija@example.com" },
  sourceEventKey: "contact.created:c1",
};

/** Delivers the fresh trigger, then the resume the wait step enqueued. */
async function runThroughWait() {
  const first = await deliver(trigger);
  expect(await first.json()).toEqual({ ok: true, waiting: 3600 });
  const [job, payload] = fx.enqueue.mock.calls[0]!;
  expect(job).toBe("run-workflow");
  const resumed = await deliver(payload);
  expect(resumed.status).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.runs = [];
  state.stepExecs = [];
  state.workflow = {
    id: WORKFLOW,
    organizationId: ORG,
    name: "Lead follow-up",
    isActive: true,
    createdById: CREATOR,
    steps: [
      {
        id: "a1",
        type: "ai.generate",
        prompt: "Welcome {{trigger.firstName}}",
        outputVar: "texta1",
      },
      { id: "w1", type: "wait.duration", seconds: 3600 },
      {
        id: "e1",
        type: "email.send",
        to: "{{trigger.email}}",
        subject: "Welcome",
        body: "{{vars.texta1}}",
      },
    ],
  };
});

describe("wait.duration resume keeps ai.generate output variables", () => {
  it("an email after the wait gets the generated text through {{vars.<outputVar>}}", async () => {
    await runThroughWait();

    expect(fx.anthropic).toHaveBeenCalledTimes(1);
    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(fx.sendEmail.mock.calls[0]![0]).toMatchObject({
      to: "maija@example.com",
      react: { body: "Thanks for your interest!" },
    });
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
  });

  it("still resolves the step id after the wait, as resumes always have", async () => {
    (state.workflow!.steps as Array<Record<string, unknown>>)[2]!.body = "{{vars.a1}}";

    await runThroughWait();

    expect(fx.sendEmail.mock.calls[0]![0]).toMatchObject({
      react: { body: "Thanks for your interest!" },
    });
  });

  it("a condition after the wait sees the generated text under its output variable", async () => {
    const steps = state.workflow!.steps as Array<Record<string, unknown>>;
    steps.splice(2, 0, {
      id: "c1",
      type: "condition",
      field: "vars.texta1",
      comparator: "contains",
      value: "interest",
    });

    await runThroughWait();

    expect(fx.sendEmail).toHaveBeenCalledTimes(1);
    expect(state.runs[0]).toMatchObject({ status: "SUCCEEDED" });
  });
});
