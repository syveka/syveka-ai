import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

/**
 * `contact.created` is a workflow trigger (and the builder's default), but nothing
 * emitted it, so workflows built on it never ran. Creating a contact now emits it
 * through the real `emitWorkflowEvent`; only the database, plan check, audit and the
 * job queue are mocked here.
 */

const m = vi.hoisted(() => ({
  contactCount: vi.fn(async () => 0),
  contactCreate: vi.fn(),
  workflowFindMany: vi.fn(async (): Promise<Array<{ id: string }>> => []),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
  assertWithinLimit: vi.fn(async (..._args: unknown[]) => undefined),
  audit: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({ contact: { count: m.contactCount, create: m.contactCreate } }),
  unscopedPrisma: { workflow: { findMany: m.workflowFindMany } },
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: m.assertWithinLimit,
}));
vi.mock("@/server/services/audit", () => ({ audit: m.audit }));

import { createContact, emitContactCreated } from "@/server/services/contacts";

const ORG = "11111111-1111-4111-8111-111111111111";

function ctx(orgId = ORG): TenantContext {
  return { userId: "user-1", email: "owner@test.fi", orgId, role: "MEMBER", locale: "fi" };
}

const saved = {
  id: "contact-1",
  organizationId: ORG,
  firstName: "Aino",
  lastName: "Virtanen",
  email: "aino@example.com",
  phone: "+358401234567",
  source: "manual",
};

const input = {
  firstName: "Aino",
  lastName: "Virtanen",
  email: "aino@example.com",
  phone: "+358401234567",
  status: "LEAD",
} as Parameters<typeof createContact>[1];

beforeEach(() => {
  vi.clearAllMocks();
  m.contactCreate.mockResolvedValue(saved);
  m.workflowFindMany.mockResolvedValue([{ id: "wf-1" }]);
  m.enqueue.mockResolvedValue(undefined);
  m.assertWithinLimit.mockResolvedValue(undefined);
});

describe("contact.created workflow event", () => {
  it("creating a contact queues one run of the organization's active contact.created workflow", async () => {
    await createContact(ctx(), input);

    expect(m.workflowFindMany).toHaveBeenCalledTimes(1);
    expect(m.workflowFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          isActive: true,
          trigger: { path: ["type"], equals: "contact.created" },
        },
      }),
    );
    expect(m.enqueue).toHaveBeenCalledTimes(1);
    expect(m.enqueue).toHaveBeenCalledWith("run-workflow", {
      workflowId: "wf-1",
      orgId: ORG,
      triggerType: "contact.created",
      triggerData: {
        contactId: "contact-1",
        firstName: "Aino",
        lastName: "Virtanen",
        email: "aino@example.com",
        phone: "+358401234567",
        source: "manual",
      },
      // The contact id is the dedupe key: a redelivery can't start the workflow twice.
      sourceEventKey: "contact.created:contact-1",
    });
  });

  it("the event is emitted only after the contact is created and audited", async () => {
    await createContact(ctx(), input);

    const created = m.contactCreate.mock.invocationCallOrder[0]!;
    const audited = m.audit.mock.invocationCallOrder[0]!;
    const queried = m.workflowFindMany.mock.invocationCallOrder[0]!;
    expect(created).toBeLessThan(queried);
    expect(audited).toBeLessThan(queried);
  });

  it("a contact over the plan limit is not created and emits nothing", async () => {
    m.assertWithinLimit.mockRejectedValueOnce(new Error("Contact limit reached for your plan."));

    await expect(createContact(ctx(), input)).rejects.toThrow("Contact limit reached");

    expect(m.contactCreate).not.toHaveBeenCalled();
    expect(m.workflowFindMany).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("a failing workflow queue never fails the saved contact, and logs no personal data", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.enqueue.mockRejectedValueOnce(new Error("QStash unavailable"));

    await expect(createContact(ctx(), input)).resolves.toMatchObject({ id: "contact-1" });

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toEqual({
      event: "contact_created_workflow_event_failed",
      orgId: ORG,
      contactId: "contact-1",
      errorName: "Error",
    });
    expect(logged).not.toContain("aino@example.com");
    expect(logged).not.toContain("+358");
    errorSpy.mockRestore();
  });

  it("an organization without a contact.created workflow queues nothing", async () => {
    m.workflowFindMany.mockResolvedValue([]);

    await createContact(ctx(), input);

    expect(m.workflowFindMany).toHaveBeenCalledTimes(1);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("only the caller's organization is queried and queued (tenant)", async () => {
    const OTHER = "22222222-2222-4222-8222-222222222222";
    m.contactCreate.mockResolvedValue({ ...saved, organizationId: OTHER });

    await createContact(ctx(OTHER), input);

    const [{ where }] = m.workflowFindMany.mock.calls[0] as unknown as [
      { where: { organizationId: string } },
    ];
    expect(where.organizationId).toBe(OTHER);
    expect(m.enqueue).toHaveBeenCalledWith(
      "run-workflow",
      expect.objectContaining({ orgId: OTHER }),
    );
  });

  it("emitContactCreated uses the contact id as the dedupe key for every workflow it starts", async () => {
    m.workflowFindMany.mockResolvedValue([{ id: "wf-1" }, { id: "wf-2" }]);

    await emitContactCreated(ORG, saved);

    expect(m.enqueue).toHaveBeenCalledTimes(2);
    for (const [, payload] of m.enqueue.mock.calls as unknown as [
      string,
      { sourceEventKey: string },
    ][]) {
      expect(payload.sourceEventKey).toBe("contact.created:contact-1");
    }
  });
});
