import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const { tenantDbMock } = vi.hoisted(() => ({ tenantDbMock: vi.fn() }));

vi.mock("@/server/db/tenant", () => ({ tenantDb: tenantDbMock }));

import {
  findActiveDealForContact,
  formatCrmContactLine,
  formatCrmDealLine,
  getCrmContactContext,
  getCrmDealContext,
} from "@/server/crm/context";

function ctx(orgId = "org-a"): TenantContext {
  return { userId: "user-1", email: "u@example.com", orgId, role: "MEMBER", locale: "en" };
}

function db() {
  return {
    contact: { findFirst: vi.fn(async () => null as Record<string, unknown> | null) },
    deal: { findFirst: vi.fn(async () => null as Record<string, unknown> | null) },
  };
}

describe("getCrmContactContext", () => {
  it("returns null when the contact doesn't resolve in this tenant", async () => {
    const d = db();
    tenantDbMock.mockReturnValue(d);
    const result = await getCrmContactContext(ctx(), "missing");
    expect(result).toBeNull();
  });

  it("maps the company relation into a flat companyName field", async () => {
    const d = db();
    d.contact.findFirst.mockResolvedValue({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      title: "CTO",
      status: "CUSTOMER",
      company: { name: "Acme Oy" },
    });
    tenantDbMock.mockReturnValue(d);

    const result = await getCrmContactContext(ctx(), "contact-1");

    expect(result).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      title: "CTO",
      status: "CUSTOMER",
      companyName: "Acme Oy",
    });
  });

  it("scopes the read to the caller's org (tenant isolation)", async () => {
    const d = db();
    tenantDbMock.mockReturnValue(d);
    await getCrmContactContext(ctx("org-b"), "contact-1");
    expect(tenantDbMock).toHaveBeenCalledWith("org-b");
  });
});

describe("findActiveDealForContact", () => {
  it("excludes closed (won/lost) deals — only an open deal counts as active", async () => {
    const d = db();
    tenantDbMock.mockReturnValue(d);
    await findActiveDealForContact(ctx(), "contact-1");
    expect(d.deal.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ contactId: "contact-1", closedAt: null }),
        orderBy: { updatedAt: "desc" },
      }),
    );
  });

  it("returns null when the contact has no open deal", async () => {
    const d = db();
    tenantDbMock.mockReturnValue(d);
    const result = await findActiveDealForContact(ctx(), "contact-1");
    expect(result).toBeNull();
  });
});

describe("getCrmDealContext", () => {
  it("returns null when the deal doesn't resolve in this tenant", async () => {
    const d = db();
    tenantDbMock.mockReturnValue(d);
    const result = await getCrmDealContext(ctx(), "missing");
    expect(result).toBeNull();
  });
});

describe("formatCrmContactLine / formatCrmDealLine", () => {
  it("renders a contact with company and title", () => {
    const line = formatCrmContactLine({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      title: "CTO",
      status: "CUSTOMER",
      companyName: "Acme Oy",
    });
    expect(line).toBe("Contact: Jane Doe (jane@example.com), CTO, Acme Oy — status CUSTOMER");
  });

  it("renders a contact with no title or company gracefully", () => {
    const line = formatCrmContactLine({
      firstName: "Jane",
      lastName: null,
      email: null,
      title: null,
      status: "LEAD",
      companyName: null,
    });
    expect(line).toBe("Contact: Jane (no email) — status LEAD");
  });

  it("renders a deal line with expected close date", () => {
    const line = formatCrmDealLine({
      title: "ERP rollout",
      stageName: "Tarjous",
      valueCents: 500_000,
      currency: "EUR",
      expectedCloseAt: new Date("2026-08-15T00:00:00Z"),
    });
    expect(line).toBe(
      'Deal: "ERP rollout" — stage Tarjous, value 5000 EUR, expected close 2026-08-15',
    );
  });

  it("omits the expected-close clause when there is none", () => {
    const line = formatCrmDealLine({
      title: "ERP rollout",
      stageName: "Tarjous",
      valueCents: 500_000,
      currency: "EUR",
      expectedCloseAt: null,
    });
    expect(line).toBe('Deal: "ERP rollout" — stage Tarjous, value 5000 EUR');
  });
});
