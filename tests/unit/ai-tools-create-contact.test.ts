import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS } from "@/lib/billing/plan-catalog";

/**
 * The AI createContact tool applies the same plan check as creating a
 * contact in the app (src/server/services/contacts.ts): the plan's contact
 * limit, and no new contacts while the workspace is read-only. It runs after
 * a confirmed typed-chat action and from phone voice calls, where the caller
 * is anonymous.
 *
 * Real: the tool, the entitlement check (assertWithinLimit) and the
 * `contact.created` workflow event (emitContactCreated -> emitWorkflowEvent).
 * Mocked: the database, audit, the job queue, and the Redis-cached entitlements
 * it reads.
 */
const m = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(async () => undefined),
  entitlements: null as unknown,
  workflowFindMany: vi.fn(async (): Promise<Array<{ id: string }>> => []),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({ contact: { count: m.count, create: m.create } })),
  unscopedPrisma: { workflow: { findMany: m.workflowFindMany } },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));
vi.mock("@/server/ai/rag", () => ({ retrieveChunks: vi.fn() }));
vi.mock("@/server/integrations/redis", () => ({
  redis: { get: vi.fn(async () => m.entitlements), set: vi.fn(async () => "OK") },
}));

import { TOOL_REGISTRY, executeTool, type ToolIdentity } from "@/server/ai/tools";

const createContact = TOOL_REGISTRY.find((t) => t.name === "createContact")!;

const MAX_CONTACTS = 3;
const chatUser: ToolIdentity = {
  orgId: "org-a",
  userId: "user-1",
  role: "MEMBER",
  actorType: "user",
};
const voiceAi: ToolIdentity = {
  orgId: "org-a",
  userId: "owner-1",
  role: "MEMBER",
  actorType: "voice_ai",
};

function entitlements(overrides: { readOnly?: boolean } = {}) {
  return {
    ...PLAN_LIMITS.FREE,
    maxContacts: MAX_CONTACTS,
    plan: "FREE",
    seats: 1,
    status: "ACTIVE",
    readOnly: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.entitlements = entitlements();
  m.count.mockResolvedValue(MAX_CONTACTS - 1);
  m.create.mockResolvedValue({ id: "contact-1" });
  m.workflowFindMany.mockResolvedValue([]);
  m.enqueue.mockResolvedValue(undefined);
});

const nothingCreated = () => {
  expect(m.create).not.toHaveBeenCalled();
  expect(m.audit).not.toHaveBeenCalled();
};

describe("createContact tool: plan limits", () => {
  it("under the limit: creates the contact as before", async () => {
    const result = await createContact.execute(chatUser, {
      firstName: "Maija",
      source: "ai-assistant",
    });
    expect(result).toEqual({ id: "contact-1", created: true });
    expect(m.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(m.create).toHaveBeenCalledWith({
      data: { organizationId: "org-a", firstName: "Maija", source: "ai-assistant" },
    });
    expect(m.audit).toHaveBeenCalledWith(
      { orgId: "org-a", userId: "user-1" },
      expect.objectContaining({ action: "contact.create", resourceId: "contact-1" }),
    );
  });

  it.each([
    ["confirmed chat (user)", chatUser],
    ["phone voice (voice_ai)", voiceAi],
  ])("at the plan's contact limit, %s: refused, no contact created", async (_l, identity) => {
    m.count.mockResolvedValue(MAX_CONTACTS);
    const result = await createContact.execute(identity, {
      firstName: "Maija",
      source: "ai-assistant",
    });
    expect(result).toEqual({ error: "entitlement_exceeded" });
    nothingCreated();
  });

  it("a read-only workspace (past due too long) gains no contacts, even under the limit", async () => {
    m.entitlements = entitlements({ readOnly: true });
    m.count.mockResolvedValue(0);
    const result = await createContact.execute(voiceAi, {
      firstName: "Maija",
      source: "ai-assistant",
    });
    expect(result).toEqual({ error: "entitlement_exceeded" });
    nothingCreated();
  });

  it("the voice webhook's result (executeTool) is a stable error without internal detail", async () => {
    m.count.mockResolvedValue(MAX_CONTACTS);
    const text = await executeTool(voiceAi, "createContact", { firstName: "Maija" });
    expect(JSON.parse(text)).toEqual({ error: "entitlement_exceeded" });
    expect(text).not.toContain("plan");
    nothingCreated();
  });

  it("an unexpected failure of the check is not reported as a plan limit", async () => {
    m.count.mockRejectedValue(new Error("db down"));
    const text = await executeTool(voiceAi, "createContact", { firstName: "Maija" });
    expect(JSON.parse(text)).toMatchObject({ error: "execution_failed" });
    nothingCreated();
  });
});

describe("createContact tool: contact.created workflow event", () => {
  // The stored row is what the tool wrote: its source is the tool's own choice.
  const storedAs = (id = "contact-1") =>
    m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id,
      lastName: null,
      email: null,
      phone: null,
      ...data,
    }));
  const queued = () => m.enqueue.mock.calls as unknown as [string, Record<string, unknown>][];

  beforeEach(() => {
    storedAs();
    m.workflowFindMany.mockResolvedValue([{ id: "wf-1" }]);
  });

  it("a new AI contact queues the organization's contact.created workflow once, keyed by the contact id", async () => {
    const result = await createContact.execute(chatUser, {
      firstName: "Maija",
      lastName: "Meikäläinen",
      email: "maija@example.com",
      phone: "+358401234567",
      source: "ai-assistant",
    });

    expect(result).toEqual({ id: "contact-1", created: true });
    expect(m.workflowFindMany).toHaveBeenCalledTimes(1);
    expect(m.workflowFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: "org-a",
          isActive: true,
          trigger: { path: ["type"], equals: "contact.created" },
        },
      }),
    );
    expect(queued()).toEqual([
      [
        "run-workflow",
        {
          workflowId: "wf-1",
          orgId: "org-a",
          triggerType: "contact.created",
          triggerData: {
            contactId: "contact-1",
            firstName: "Maija",
            lastName: "Meikäläinen",
            email: "maija@example.com",
            phone: "+358401234567",
            source: "ai-assistant",
          },
          sourceEventKey: "contact.created:contact-1",
        },
      ],
    ]);
  });

  it("the event follows the contact's insert and its audit entry", async () => {
    await createContact.execute(chatUser, { firstName: "Maija", source: "ai-assistant" });

    const queried = m.workflowFindMany.mock.invocationCallOrder[0]!;
    expect(m.create.mock.invocationCallOrder[0]!).toBeLessThan(queried);
    expect(m.audit.mock.invocationCallOrder[0]!).toBeLessThan(queried);
  });

  it("a phone caller's contact keeps source voice-ai in the event (through executeTool)", async () => {
    const text = await executeTool(voiceAi, "createContact", {
      firstName: "Maija",
      source: "ai-assistant",
    });

    expect(JSON.parse(text)).toEqual({ id: "contact-1", created: true });
    expect(m.create).toHaveBeenCalledWith({
      data: { organizationId: "org-a", firstName: "Maija", source: "voice-ai" },
    });
    expect(queued()).toHaveLength(1);
    expect(queued()[0]![1]).toMatchObject({
      orgId: "org-a",
      triggerData: { contactId: "contact-1", source: "voice-ai" },
      sourceEventKey: "contact.created:contact-1",
    });
  });

  it("at the plan's contact limit: refused, no event", async () => {
    m.count.mockResolvedValue(MAX_CONTACTS);
    const result = await createContact.execute(chatUser, {
      firstName: "Maija",
      source: "ai-assistant",
    });
    expect(result).toEqual({ error: "entitlement_exceeded" });
    expect(m.workflowFindMany).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("a read-only workspace: refused, no event", async () => {
    m.entitlements = entitlements({ readOnly: true });
    m.count.mockResolvedValue(0);
    const result = await createContact.execute(voiceAi, {
      firstName: "Maija",
      source: "ai-assistant",
    });
    expect(result).toEqual({ error: "entitlement_exceeded" });
    expect(m.workflowFindMany).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("a failing workflow queue still returns the created contact, and logs no personal data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.enqueue.mockRejectedValueOnce(new Error("QStash unavailable"));

    const result = await createContact.execute(chatUser, {
      firstName: "Maija",
      email: "maija@example.com",
      phone: "+358401234567",
      source: "ai-assistant",
    });

    expect(result).toEqual({ id: "contact-1", created: true });
    expect(m.audit).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toEqual({
      event: "contact_created_workflow_event_failed",
      orgId: "org-a",
      contactId: "contact-1",
      errorName: "Error",
    });
    expect(logged).not.toContain("maija@example.com");
    expect(logged).not.toContain("+358");
    errorSpy.mockRestore();
  });

  it("another organization's caller queues only that organization's workflows", async () => {
    storedAs("contact-b");
    await createContact.execute(
      { ...chatUser, orgId: "org-b" },
      {
        firstName: "Maija",
        source: "ai-assistant",
      },
    );

    const [{ where }] = m.workflowFindMany.mock.calls[0] as unknown as [
      { where: { organizationId: string } },
    ];
    expect(where.organizationId).toBe("org-b");
    expect(queued()).toHaveLength(1);
    expect(queued()[0]![1]).toMatchObject({
      orgId: "org-b",
      sourceEventKey: "contact.created:contact-b",
    });
    expect(queued().some(([, payload]) => payload.orgId === "org-a")).toBe(false);
  });
});
