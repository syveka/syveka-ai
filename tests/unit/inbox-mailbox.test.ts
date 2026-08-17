import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  tenantDb: vi.fn(),
  unscopedMailboxFindFirst: vi.fn(),
  organizationFindUniqueOrThrow: vi.fn(async () => ({ slug: "acme-oy" })),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: mocks.tenantDb,
  unscopedPrisma: {
    inboxMailbox: { findFirst: mocks.unscopedMailboxFindFirst },
    organization: { findUniqueOrThrow: mocks.organizationFindUniqueOrThrow },
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

  it("does not resolve mailboxes for soft-deleted organizations", async () => {
    mocks.unscopedMailboxFindFirst.mockResolvedValueOnce(null);
    await expect(resolveOrgIdByMailboxAddress("deleted@example.com", "EMAIL")).resolves.toBeNull();
    expect(mocks.unscopedMailboxFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization: { deletedAt: null } }),
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
