import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS } from "@/lib/billing/plan-catalog";

/**
 * The AI createContact tool applies the same plan check as creating a
 * contact in the app (src/server/services/contacts.ts): the plan's contact
 * limit, and no new contacts while the workspace is read-only. It runs after
 * a confirmed typed-chat action and from phone voice calls, where the caller
 * is anonymous.
 *
 * Real: the tool and the entitlement check (assertWithinLimit). Mocked: the
 * database, audit, and the Redis-cached entitlements it reads.
 */
const m = vi.hoisted(() => ({
  count: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(async () => undefined),
  entitlements: null as unknown,
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({ contact: { count: m.count, create: m.create } })),
  unscopedPrisma: {},
}));
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
