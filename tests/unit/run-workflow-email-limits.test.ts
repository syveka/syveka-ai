import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding #10: an email.send step mailed whatever its `to` template resolved
 * to (anything containing "@"), with no limit, from the platform domain. One
 * organization's workflow, fired by a burst of CRM changes, reached the
 * provider once per run. These tests drive the run-workflow job against an
 * in-memory database and an in-memory stand-in for the Upstash limiters.
 *
 * The limiter fake is atomic the way one Upstash script call is: it reads and
 * spends a window in a single synchronous step, so parallel runs interleave
 * only between checks, never inside one. Real Upstash atomicity is not
 * exercised here.
 */
class FakePrismaKnownError extends Error {
  constructor(readonly code: string) {
    super(`Prisma error ${code}`);
  }
}

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  workflow: null as Record<string, unknown> | null,
  runs: [] as Array<Record<string, unknown>>,
  steps: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<Record<string, unknown>>,
  /** Throw once from the next SUCCEEDED write (a crash right after the send). */
  failNextCompletion: false,
}));

const limiter = vi.hoisted(() => {
  const WINDOWS: Record<string, { limit: number; ms: number }> = {
    workflowEmailOrgHour: { limit: 100, ms: 60 * 60_000 },
    workflowEmailOrgDay: { limit: 300, ms: 24 * 60 * 60_000 },
    workflowEmailRecipientDay: { limit: 10, ms: 24 * 60 * 60_000 },
    workflowEmailRecipientAnyOrgDay: { limit: 30, ms: 24 * 60 * 60_000 },
  };
  const hits = new Map<string, number[]>();
  return {
    WINDOWS,
    hits,
    unavailable: false,
    calls: [] as Array<{ name: string; key: string }>,
    /** While set, every check waits here first, so parallel runs meet inside the limiter. */
    gate: null as Promise<void> | null,
    waiting: 0,
    /** Units spent in the current window of one limiter key. */
    spent(name: string, key: string): number {
      const window = WINDOWS[name]!;
      const now = Date.now();
      return (hits.get(`${name}|${key}`) ?? []).filter((t) => t > now - window.ms).length;
    },
  };
});

vi.mock("@/server/integrations/redis", () => ({
  checkRateLimit: async (name: string, key: string) => {
    limiter.calls.push({ name, key });
    limiter.waiting += 1;
    if (limiter.gate) await limiter.gate;
    // Same await point as a real network call: parallel runs interleave here.
    await Promise.resolve();
    if (limiter.unavailable) return { ok: false, reason: "unavailable" };
    const window = limiter.WINDOWS[name];
    if (!window) throw new Error(`unexpected limiter ${name}`);
    // Read and spend in one synchronous step, like one Upstash script call.
    const now = Date.now();
    const id = `${name}|${key}`;
    const live = (limiter.hits.get(id) ?? []).filter((t) => t > now - window.ms);
    if (live.length >= window.limit) {
      limiter.hits.set(id, live);
      return { ok: false, reason: "limited", limit: window.limit, remaining: 0, reset: now };
    }
    live.push(now);
    limiter.hits.set(id, live);
    return { ok: true, limit: window.limit, remaining: window.limit - live.length, reset: now };
  },
}));

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return value instanceof Date && value.getTime() === condition.getTime();
  }
  if (condition === null || typeof condition !== "object") return value === condition;
  return Object.entries(condition as Row).every(([op, arg]) => {
    switch (op) {
      case "in":
        return (arg as unknown[]).includes(value);
      case "startsWith":
        return typeof value === "string" && value.startsWith(arg as string);
      case "lt":
        return value instanceof Date && value < (arg as Date);
      case "not":
        return arg === null ? value != null : !fieldMatches(value, arg);
      default:
        throw new Error(`fake where: unsupported operator ${op}`);
    }
  });
}

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
    if (k === "AND") return (v as Row[]).every((w) => matches(row, w));
    if (k === "NOT") return !([v].flat() as Row[]).some((w) => matches(row, w));
    return fieldMatches(row[k], v);
  });
}

const db = {
  workflow: {
    findFirst: vi.fn(async ({ where }: { where: Row }) =>
      state.workflow && matches(state.workflow, where) ? state.workflow : null,
    ),
  },
  workflowRun: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (state.runs.some((r) => r.sourceEventKey === data.sourceEventKey)) {
        throw new FakePrismaKnownError("P2002");
      }
      const run = {
        id: `run-${state.runs.length + 1}`,
        stepResults: [],
        error: null,
        startedAt: new Date(),
        ...data,
      };
      state.runs.push(run);
      return run;
    }),
    findFirst: vi.fn(
      async ({ where }: { where: Row }) => state.runs.find((r) => matches(r, where)) ?? null,
    ),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Row }) =>
      state.runs.find((r) => matches(r, where))!,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const hits = state.runs.filter((r) => matches(r, where));
      for (const run of hits) Object.assign(run, data);
      return { count: hits.length };
    }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const run = state.runs.find((r) => matches(r, where));
      if (!run) throw new FakePrismaKnownError("P2025");
      Object.assign(run, data);
      return run;
    }),
  },
  workflowStepExecution: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      if (
        state.steps.some((s) => s.workflowRunId === data.workflowRunId && s.stepId === data.stepId)
      ) {
        throw new FakePrismaKnownError("P2002");
      }
      const step = {
        id: `step-${state.steps.length + 1}`,
        status: "CLAIMED",
        startedAt: new Date(),
        output: null,
        error: null,
        ...data,
      };
      state.steps.push(step);
      return step;
    }),
    findFirstOrThrow: vi.fn(async ({ where }: { where: Row }) =>
      state.steps.find((s) => matches(s, where))!,
    ),
    updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      if (data.status === "SUCCEEDED" && state.failNextCompletion) {
        state.failNextCompletion = false;
        throw new Error("database unavailable");
      }
      const hits = state.steps.filter((s) => matches(s, where));
      for (const step of hits) {
        for (const [k, v] of Object.entries(data)) if (v !== undefined) step[k] = v;
      }
      return { count: hits.length };
    }),
  },
  organizationMember: {
    findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
      where.userId === CREATOR ? { id: "m1" } : null,
    ),
  },
  notification: {
    create: vi.fn(async ({ data }: { data: Row }) => {
      state.notifications.push(data);
      return data;
    }),
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};

const sendEmail = vi.hoisted(() =>
  vi.fn(async (_args: { to: string; idempotencyKey?: string }) => ({ id: "email-1" })),
);

vi.mock("@/server/services/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
  isRestrictionSet: vi.fn(async () => false),
}));
const verifyJobRequest = vi.hoisted(() => vi.fn(async (req: Request) => req.text()));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return db;
  },
}));
vi.mock("@/server/jobs/organization-guard", () => ({
  isOrganizationActive: async () => true,
  ORGANIZATION_INACTIVE: { skipped: "organization_inactive" },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: vi.fn(async () => undefined),
  getEntitlements: async () => ({ readOnly: false, activeWorkflows: 5 }),
}));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: async () => undefined,
  AiSpendError: class extends Error {},
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

import { POST } from "@/app/api/v1/jobs/run-workflow/route";
import { INVALID_RECIPIENT_ERROR_PREFIX, isTerminalRunError } from "@/lib/workflows/run-failure";
import { emailKey } from "@/server/security/rate-limit";
import { normalizeWorkflowRecipient } from "@/server/services/workflow-email-limits";

const LIMIT_PREFIX = "email.send: limit reached";

function emailWorkflow(organizationId = ORG) {
  return {
    id: WORKFLOW,
    organizationId,
    name: "New lead acknowledgement",
    isActive: true,
    createdById: CREATOR,
    trigger: { type: "contact.created" },
    steps: [
      {
        id: "ack",
        type: "email.send",
        to: "{{trigger.email}}",
        subject: "Thanks",
        body: "We got your message.",
      },
    ],
  };
}

async function deliver(email: string, eventKey: string, orgId = ORG): Promise<Response> {
  return POST(
    new Request("https://example.test/api/v1/jobs/run-workflow", {
      method: "POST",
      body: JSON.stringify({
        workflowId: WORKFLOW,
        orgId,
        triggerType: "contact.created",
        triggerData: { email },
        sourceEventKey: eventKey,
      }),
    }),
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Starts `count` deliveries and holds every one inside its first limiter
 * check until all of them are there, then lets them through together.
 *
 * Each delivery is started only once the previous one is past its module
 * imports: the route imports its dependencies on every call, and with many
 * of those imports in flight at once vitest handed the mocked
 * @/server/jobs/verify to only one of them (149 of 150 parallel runs got the
 * real verifier and were refused as "invalid signature" before any step).
 */
async function deliverTogether(
  count: number,
  start: (i: number) => Promise<Response>,
): Promise<Response[]> {
  let open!: () => void;
  limiter.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const pending: Array<Promise<Response>> = [];
  for (let i = 0; i < count; i++) {
    const verified = verifyJobRequest.mock.calls.length;
    pending.push(start(i));
    while (verifyJobRequest.mock.calls.length === verified) await tick();
  }
  while (limiter.waiting < count) await tick();
  open();
  const responses = await Promise.all(pending);
  limiter.gate = null;
  return responses;
}

function runFor(eventKey: string) {
  return state.runs.find((r) => r.sourceEventKey === eventKey)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-23T08:00:00Z"));
  state.workflow = emailWorkflow();
  state.runs = [];
  state.steps = [];
  state.notifications = [];
  state.failNextCompletion = false;
  limiter.hits.clear();
  limiter.calls = [];
  limiter.unavailable = false;
  limiter.gate = null;
  limiter.waiting = 0;
  sendEmail.mockImplementation(async () => ({ id: "email-1" }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("email.send delivery", () => {
  it("sends once, to the trimmed and lowercased address, keyed by the step execution", async () => {
    const res = await deliver("  Lead+Spring@Example.COM ", "contact.created:1");

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0]![0].to).toBe("lead+spring@example.com");
    expect(sendEmail.mock.calls[0]![0].idempotencyKey).toBe(state.steps[0]!.id);
    expect(runFor("contact.created:1").status).toBe("SUCCEEDED");
  });
});

describe("email.send limits", () => {
  it("a burst of runs to many recipients reaches the provider at most 100 times an hour", async () => {
    for (let i = 0; i < 150; i++) {
      await deliver(`lead${i}@example.com`, `contact.created:${i}`);
    }

    expect(sendEmail).toHaveBeenCalledTimes(100);
    const refused = state.runs.filter((r) => r.status === "FAILED");
    expect(refused).toHaveLength(50);
    for (const run of refused) {
      expect(run.error).toBe(`${LIMIT_PREFIX} (organization_hour)`);
      expect(isTerminalRunError(run.error as string)).toBe(true);
    }
  });

  it("the daily organization cap holds across hours", async () => {
    let n = 0;
    for (let hour = 0; hour < 4; hour++) {
      for (let i = 0; i < 100; i++, n++) {
        await deliver(`lead${n}@example.com`, `contact.created:${n}`);
      }
      vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    }

    expect(sendEmail).toHaveBeenCalledTimes(300);
    const lastHour = state.runs.slice(300);
    expect(lastHour.every((r) => r.error === `${LIMIT_PREFIX} (organization_day)`)).toBe(true);
  });

  it("one recipient gets at most 10 a day from one organization, aliases and case included", async () => {
    const forms = ["victim@example.com", "VICTIM@example.com", "victim+1@example.com"];
    for (let i = 0; i < 15; i++) {
      await deliver(forms[i % forms.length]!, `contact.created:${i}`);
    }

    expect(sendEmail).toHaveBeenCalledTimes(10);
    const refused = state.runs.filter((r) => r.status === "FAILED");
    expect(refused).toHaveLength(5);
    expect(refused.every((r) => r.error === `${LIMIT_PREFIX} (recipient_day)`)).toBe(true);

    // Another organization's allowance for the same recipient is its own.
    state.workflow = emailWorkflow(OTHER_ORG);
    await deliver("victim@example.com", "other:1", OTHER_ORG);
    expect(sendEmail).toHaveBeenCalledTimes(11);
  });

  it("one recipient gets at most 30 a day across organizations", async () => {
    const orgs = Array.from({ length: 4 }, (_, n) => `5555555${n}-5555-4555-8555-555555555555`);
    for (const org of orgs) {
      state.workflow = emailWorkflow(org);
      for (let i = 0; i < 10; i++) await deliver("victim@example.com", `${org}:${i}`, org);
    }

    expect(sendEmail).toHaveBeenCalledTimes(30);
    const lastOrg = state.runs.filter((r) => r.organizationId === orgs[3]);
    expect(lastOrg).toHaveLength(10);
    expect(
      lastOrg.every((r) => r.error === `${LIMIT_PREFIX} (recipient_all_organizations_day)`),
    ).toBe(true);
  });

  it("parallel runs cannot exceed either limit", async () => {
    // Distinct runs and step executions, all inside the limiter at once.
    const responses = await deliverTogether(150, (i) =>
      deliver(`lead${i}@example.com`, `burst:${i}`),
    );
    expect(verifyJobRequest).toHaveBeenCalledTimes(150);
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(state.steps.map((s) => s.id)).size).toBe(150);
    expect(new Set(state.steps.map((s) => s.workflowRunId)).size).toBe(150);
    expect(sendEmail).toHaveBeenCalledTimes(100);
    expect(new Set(sendEmail.mock.calls.map(([args]) => args.idempotencyKey)).size).toBe(100);
    expect(limiter.spent("workflowEmailOrgHour", ORG)).toBe(100);

    vi.setSystemTime(new Date(Date.now() + 61 * 60_000));
    sendEmail.mockClear();
    limiter.waiting = 0;
    const same = await deliverTogether(25, (i) => deliver("victim@example.com", `same:${i}`));
    expect(same.every((r) => r.status === 200)).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(10);
    const refused = state.runs.filter((r) => String(r.sourceEventKey).startsWith("same:"));
    expect(refused.filter((r) => r.status === "FAILED")).toHaveLength(15);
    expect(
      limiter.spent("workflowEmailRecipientDay", `${ORG}:${emailKey("victim@example.com")}`),
    ).toBe(10);
  });

  it("an unavailable limiter calls no provider and leaves the run retryable", async () => {
    limiter.unavailable = true;
    const res = await deliver("lead@example.com", "contact.created:1");

    expect(res.status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
    const run = runFor("contact.created:1");
    expect(run.status).toBe("FAILED");
    expect(isTerminalRunError(run.error as string)).toBe(false);

    // The retry succeeds once the limiter answers, and sends once.
    limiter.unavailable = false;
    const retry = await deliver("lead@example.com", "contact.created:1");
    expect(retry.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(runFor("contact.created:1").status).toBe("SUCCEEDED");
  });

  it("a limit refusal is final: a redelivery sends nothing and spends nothing", async () => {
    for (let i = 0; i < 10; i++) await deliver("victim@example.com", `contact.created:${i}`);
    const refusal = await deliver("victim@example.com", "contact.created:10");
    expect(refusal.status).toBe(200);
    expect(runFor("contact.created:10").error).toBe(`${LIMIT_PREFIX} (recipient_day)`);
    const callsBefore = limiter.calls.length;

    const again = await deliver("victim@example.com", "contact.created:10");
    expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    expect(sendEmail).toHaveBeenCalledTimes(10);
    expect(limiter.calls.length).toBe(callsBefore);
  });
});

describe("email.send retries", () => {
  it("a provider failure is retried with the same idempotency key, and the limits are spent once", async () => {
    sendEmail.mockRejectedValueOnce(new Error("provider timeout"));
    const first = await deliver("lead@example.com", "contact.created:1");
    expect(first.status).toBe(500);

    const retry = await deliver("lead@example.com", "contact.created:1");
    expect(retry.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1]![0].idempotencyKey).toBe(
      sendEmail.mock.calls[0]![0].idempotencyKey,
    );
    expect(limiter.spent("workflowEmailOrgHour", ORG)).toBe(1);
    expect(limiter.spent("workflowEmailOrgDay", ORG)).toBe(1);
    expect(
      limiter.spent("workflowEmailRecipientDay", `${ORG}:${emailKey("lead@example.com")}`),
    ).toBe(1);
  });

  it("a send whose completion was not recorded is resent with the same key and not counted again", async () => {
    state.failNextCompletion = true;
    const first = await deliver("lead@example.com", "contact.created:1");
    expect(first.status).toBe(500);
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const retry = await deliver("lead@example.com", "contact.created:1");
    expect(retry.status).toBe(200);
    // Resend deduplicates the second call by its Idempotency-Key.
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1]![0].idempotencyKey).toBe(
      sendEmail.mock.calls[0]![0].idempotencyKey,
    );
    expect(limiter.spent("workflowEmailOrgHour", ORG)).toBe(1);
  });

  it("a succeeded step is never sent or counted again", async () => {
    await deliver("lead@example.com", "contact.created:1");
    const run = runFor("contact.created:1");
    run.status = "FAILED"; // a later step failed; the run is reclaimed
    run.error = "step failed (Error)";
    await deliver("lead@example.com", "contact.created:1");

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(limiter.spent("workflowEmailOrgHour", ORG)).toBe(1);
  });
});

describe("email.send recipients", () => {
  const invalid = [
    "Lead <lead@example.com>",
    '"Lead" lead@example.com',
    "lead@example.com,other@example.com",
    "lead@example.com;other@example.com",
    "lead@example.com other@example.com",
    "lead@example.com\r\nBcc: other@example.com",
    "lead@example.com\n",
    "\tlead@example.com",
    "lead\u0000@example.com",
    "not-an-address",
    "@example.com",
    "",
  ];

  it.each(invalid)("refuses %j for good, before any limit or provider call", async (to) => {
    const res = await deliver(to, "contact.created:1");

    expect(res.status).toBe(200);
    const run = runFor("contact.created:1");
    expect(run.error).toBe(INVALID_RECIPIENT_ERROR_PREFIX);
    expect(isTerminalRunError(run.error as string)).toBe(true);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(limiter.calls).toHaveLength(0);
  });

  it("normalizes only trim and case", () => {
    expect(normalizeWorkflowRecipient(" A.B+tag@Example.com ")).toBe("a.b+tag@example.com");
    expect(normalizeWorkflowRecipient("a@example.com\r\n")).toBeNull();
  });

  it("never puts an address in a limiter key or a log line", async () => {
    const logs = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    for (let i = 0; i < 12; i++) await deliver("secret.person@example.com", `contact.created:${i}`);
    limiter.unavailable = true;
    await deliver("secret.person@example.com", "contact.created:x");

    expect(limiter.calls.length).toBeGreaterThan(0);
    for (const { key } of limiter.calls) {
      expect(key).not.toContain("@");
      expect(key).not.toContain("secret");
    }
    const logged = logs.flatMap((spy) => spy.mock.calls.map((args) => JSON.stringify(args)));
    expect(logged.some((line) => line.includes("secret.person"))).toBe(false);
    // The trigger data holds the address; what the job writes must not.
    const stored = JSON.stringify([
      state.runs.map((r) => [r.error, r.stepResults]),
      state.steps.map((s) => [s.error, s.output]),
      state.notifications,
    ]);
    expect(stored).not.toContain("secret.person");
  });
});
