import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  unscopedMailboxFindFirst: vi.fn(),
  organizationFindFirst: vi.fn(async () => ({ slug: "acme-oy" }) as { slug: string } | null),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/server/services/audit", () => ({ audit: mocks.audit }));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {
    inboxMailbox: { findFirst: mocks.unscopedMailboxFindFirst },
    organization: { findFirst: mocks.organizationFindFirst },
  },
}));

import { getOrCreateMailbox, resolveOrgIdByMailboxAddress } from "@/server/services/inbox-mailbox";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "OWNER", locale: "en" };
}

describe("resolveOrgIdByMailboxAddress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the organization id from a verified mailbox address (case-insensitive, EMAIL channel)", async () => {
    mocks.unscopedMailboxFindFirst.mockResolvedValueOnce({ organizationId: "org-a" });
    const result = await resolveOrgIdByMailboxAddress("Acme-Oy@Inbox.Syveka.Ai", "EMAIL");
    expect(result).toBe("org-a");
    expect(mocks.unscopedMailboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          address: { equals: "Acme-Oy@Inbox.Syveka.Ai", mode: "insensitive" },
          channel: "EMAIL",
          organization: { deletedAt: null },
        },
      }),
    );
  });

  it("returns null — never a fabricated or default org — when no mailbox matches", async () => {
    mocks.unscopedMailboxFindFirst.mockResolvedValueOnce(null);
    const result = await resolveOrgIdByMailboxAddress("unknown@nowhere.example", "EMAIL");
    expect(result).toBeNull();
  });

  it("never resolves an address registered under a different channel", async () => {
    mocks.unscopedMailboxFindFirst.mockResolvedValueOnce(null);
    await resolveOrgIdByMailboxAddress("acme@inbox.syveka.ai", "WHATSAPP");
    expect(mocks.unscopedMailboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ channel: "WHATSAPP" }) }),
    );
  });
});

describe("getOrCreateMailbox", () => {
  const originalDomain = process.env.INBOX_EMAIL_DOMAIN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INBOX_EMAIL_DOMAIN = "inbox.syveka.ai";
  });

  afterEach(() => {
    process.env.INBOX_EMAIL_DOMAIN = originalDomain;
  });

  it("returns the existing mailbox without creating a duplicate", async () => {
    const findFirst = vi.fn(async () => ({ id: "mb-1", address: "acme-oy@inbox.syveka.ai" }));
    const create = vi.fn();
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });

    const result = await getOrCreateMailbox(ctx("org-a"), "EMAIL");

    expect(result).toEqual({ id: "mb-1", address: "acme-oy@inbox.syveka.ai" });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("lazily provisions a mailbox derived from the org's slug, scoped to the caller's org", async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "mb-new",
      ...data,
    }));
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });

    const result = await getOrCreateMailbox(ctx("org-a"), "EMAIL");

    expect(mocks.tenantDb).toHaveBeenCalledWith("org-a");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-a",
          channel: "EMAIL",
          address: "acme-oy@inbox.syveka.ai",
        }),
      }),
    );
    expect(result?.address).toBe("acme-oy@inbox.syveka.ai");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-a" }),
      expect.objectContaining({
        action: "inbox_mailbox.create",
        resourceType: "inbox_mailbox",
        resourceId: "mb-new",
      }),
    );
  });

  it("never provisions a mailbox for a soft-deleted organization", async () => {
    mocks.organizationFindFirst.mockResolvedValueOnce(null);
    const findFirst = vi.fn(async () => null);
    const create = vi.fn();
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });

    const result = await getOrCreateMailbox(ctx("org-deleted"), "EMAIL");

    expect(result).toBeNull();
    expect(mocks.organizationFindFirst).toHaveBeenCalledWith({
      where: { id: "org-deleted", deletedAt: null },
      select: { slug: true },
    });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("concurrent provisioning: the race loser reads back the winner's row and does not audit", async () => {
    const winner = { id: "mb-winner", address: "acme-oy@inbox.syveka.ai" };
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null) // initial existence check
      .mockResolvedValueOnce(winner); // read-back after the unique violation
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });

    const result = await getOrCreateMailbox(ctx("org-a"), "EMAIL");

    expect(result).toEqual(winner);
    expect(findFirst).toHaveBeenLastCalledWith({ where: { channel: "EMAIL" } });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("never returns another org's mailbox when the address is already taken cross-tenant", async () => {
    // The (channel, address) unique index rejects the insert; the read-back
    // goes through tenantDb(caller org), so it can only ever see the caller's
    // own rows — here there are none.
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    });
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });

    const result = await getOrCreateMailbox(ctx("org-a"), "EMAIL");

    expect(result).toBeNull();
    expect(mocks.tenantDb).toHaveBeenCalledWith("org-a");
    expect(mocks.tenantDb).not.toHaveBeenCalledWith(expect.not.stringMatching(/^org-a$/));
  });

  it("returns null (never throws or fabricates a domain) when INBOX_EMAIL_DOMAIN is not configured", async () => {
    delete process.env.INBOX_EMAIL_DOMAIN;
    const findFirst = vi.fn(async () => null);
    const create = vi.fn();
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });

    const result = await getOrCreateMailbox(ctx("org-a"), "EMAIL");

    expect(result).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("getExistingMailbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads only the caller's org mailbox and never provisions one", async () => {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn();
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });
    const { getExistingMailbox } = await import("@/server/services/inbox-mailbox");

    const result = await getExistingMailbox(ctx("org-b"), "EMAIL");

    expect(result).toBeNull();
    expect(mocks.tenantDb).toHaveBeenCalledWith("org-b");
    expect(findFirst).toHaveBeenCalledWith({ where: { channel: "EMAIL" } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("getMailboxForViewer (who may provision)", () => {
  const originalDomain = process.env.INBOX_EMAIL_DOMAIN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INBOX_EMAIL_DOMAIN = "inbox.syveka.ai";
  });

  afterEach(() => {
    process.env.INBOX_EMAIL_DOMAIN = originalDomain;
  });

  function freshDb() {
    const findFirst = vi.fn(async () => null);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "mb-new",
      ...data,
    }));
    mocks.tenantDb.mockReturnValue({ inboxMailbox: { findFirst, create } });
    return { findFirst, create };
  }

  it.each(["OWNER", "ADMIN"] as const)("%s provisions the org mailbox", async (role) => {
    const { create } = freshDb();
    const { getMailboxForViewer } = await import("@/server/services/inbox-mailbox");
    const result = await getMailboxForViewer({ ...ctx("org-a"), role }, "EMAIL");
    expect(create).toHaveBeenCalledTimes(1);
    expect(result?.address).toBe("acme-oy@inbox.syveka.ai");
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it.each(["MANAGER", "MEMBER", "VIEWER"] as const)(
    "%s can never provision — read-only lookup",
    async (role) => {
      const { create, findFirst } = freshDb();
      const { getMailboxForViewer } = await import("@/server/services/inbox-mailbox");
      const result = await getMailboxForViewer({ ...ctx("org-a"), role }, "EMAIL");
      expect(result).toBeNull();
      expect(findFirst).toHaveBeenCalledWith({ where: { channel: "EMAIL" } });
      expect(create).not.toHaveBeenCalled();
      expect(mocks.organizationFindFirst).not.toHaveBeenCalled();
      expect(mocks.audit).not.toHaveBeenCalled();
    },
  );
});
