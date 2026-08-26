import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getTenantContextOrNull: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/session", () => ({
  getSessionUser: mocks.getSessionUser,
  getTenantContextOrNull: mocks.getTenantContextOrNull,
}));
vi.mock("@/app/[locale]/(onboarding)/onboarding/onboarding-form", () => ({
  OnboardingForm: () => null,
}));

import OnboardingPage from "@/app/[locale]/(onboarding)/onboarding/page";

describe("onboarding route guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user-1" });
    mocks.getTenantContextOrNull.mockResolvedValue(null);
  });

  for (const locale of ["en", "fi", "ar"] as const) {
    it(`renders for an authenticated no-organization user in ${locale} without redirecting`, async () => {
      const result = await OnboardingPage({ params: Promise.resolve({ locale }) });

      expect(result).toBeTruthy();
      expect(mocks.redirect).not.toHaveBeenCalled();
    });
  }

  it("redirects an unauthenticated user to the localized login page", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    await expect(OnboardingPage({ params: Promise.resolve({ locale: "ar" }) })).rejects.toThrow(
      "NEXT_REDIRECT:/ar/login",
    );
  });

  it("redirects an onboarded user to the localized dashboard", async () => {
    mocks.getTenantContextOrNull.mockResolvedValue({ orgId: "org-1" });

    await expect(OnboardingPage({ params: Promise.resolve({ locale: "fi" }) })).rejects.toThrow(
      "NEXT_REDIRECT:/fi/dashboard",
    );
  });
});
