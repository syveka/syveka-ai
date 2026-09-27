import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  createOrganization: vi.fn(async () => ({ id: "org-1" })),
  countMemberships: vi.fn(async () => 0),
  refreshSession: vi.fn(async () => undefined),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/session", () => ({
  getSessionUser: mocks.getSessionUser,
  AuthError: class AuthError extends Error {},
}));
vi.mock("@/server/services/organizations", () => ({
  createOrganization: mocks.createOrganization,
  countMemberships: mocks.countMemberships,
  switchOrganization: vi.fn(),
}));
vi.mock("@/server/supabase/server", () => ({
  createSupabaseServer: async () => ({
    auth: { refreshSession: mocks.refreshSession },
  }),
}));

import { createOrganizationAction } from "@/actions/organization";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

describe("createOrganizationAction — onboarding activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user-1", email: "u@example.com" });
    mocks.countMemberships.mockReset().mockResolvedValue(0);
  });

  it("sends a brand-new organization to Business DNA setup, not straight to the dashboard", async () => {
    await expect(
      createOrganizationAction(
        {},
        formData({ name: "Acme Oy", industry: "Retail", defaultLocale: "EN" }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT:/settings/business-dna");
    expect(mocks.redirect).toHaveBeenCalledWith("/settings/business-dna");
    expect(mocks.redirect).not.toHaveBeenCalledWith("/dashboard");
  });

  it("refreshes the session before redirecting, so the new org claims are already live", async () => {
    await expect(
      createOrganizationAction({}, formData({ name: "Acme Oy", defaultLocale: "EN" })),
    ).rejects.toThrow();
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
  });

  it("returns create_failed (no crash, no redirect) when nothing was created", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createOrganization.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED postgres://user:pw@host/db"), {
        name: "PrismaClientInitializationError",
      }),
    );
    mocks.countMemberships.mockResolvedValue(0);

    const result = await createOrganizationAction(
      {},
      formData({ name: "Acme Oy", defaultLocale: "EN" }),
    );

    expect(result).toEqual({ error: "create_failed" });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.refreshSession).not.toHaveBeenCalled();
    const logged = errorLog.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("create_organization_failed");
    expect(logged).toContain("PrismaClientInitializationError");
    expect(logged).not.toContain("postgres://");
    errorLog.mockRestore();
  });

  it("continues to setup when the org was committed but a follow-up step failed", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.countMemberships.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    mocks.createOrganization.mockRejectedValueOnce(new Error("auth admin unavailable"));

    await expect(
      createOrganizationAction({}, formData({ name: "Acme Oy", defaultLocale: "EN" })),
    ).rejects.toThrow("NEXT_REDIRECT:/settings/business-dna");
    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    errorLog.mockRestore();
  });

  it("returns create_failed when the post-failure membership check itself fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.countMemberships
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("db still down"));
    mocks.createOrganization.mockRejectedValueOnce(new Error("db down"));

    const result = await createOrganizationAction(
      {},
      formData({ name: "Acme Oy", defaultLocale: "EN" }),
    );
    expect(result).toEqual({ error: "create_failed" });
    expect(mocks.redirect).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("returns create_failed when the database is already down before creation", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.countMemberships.mockRejectedValue(new Error("db down"));
    mocks.createOrganization.mockRejectedValueOnce(new Error("db down"));

    const result = await createOrganizationAction(
      {},
      formData({ name: "Acme Oy", defaultLocale: "EN" }),
    );
    expect(result).toEqual({ error: "create_failed" });
    expect(mocks.redirect).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("still completes onboarding when only the pre-create membership count fails", async () => {
    mocks.countMemberships.mockRejectedValue(new Error("transient"));

    await expect(
      createOrganizationAction({}, formData({ name: "Acme Oy", defaultLocale: "EN" })),
    ).rejects.toThrow("NEXT_REDIRECT:/settings/business-dna");
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
  });

  it("returns invalid_input without creating an org when the name is too short", async () => {
    const result = await createOrganizationAction({}, formData({ name: "A", defaultLocale: "EN" }));
    expect(result).toEqual({ error: "invalid_input" });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
