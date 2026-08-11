import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(async () => ({ id: "user-1", email: "u@example.com" })),
  createOrganization: vi.fn(async () => ({ id: "org-1" })),
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

  it("returns invalid_input without creating an org when the name is too short", async () => {
    const result = await createOrganizationAction({}, formData({ name: "A", defaultLocale: "EN" }));
    expect(result).toEqual({ error: "invalid_input" });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
