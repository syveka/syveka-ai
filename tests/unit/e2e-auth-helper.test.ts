import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { classifyE2ELoginPathname, loginAsE2EUser } from "../e2e/helpers/auth";

type LoginDestination = { url: string; alert?: string };

function pageFor(destination: LoginDestination): Page {
  let currentUrl = "https://staging.example.test/login";
  const alert = {
    isVisible: vi.fn(async () => Boolean(destination.alert)),
    textContent: vi.fn(async () => destination.alert ?? null),
  };

  return {
    goto: vi.fn(async () => {
      currentUrl = "https://staging.example.test/login";
      return null;
    }),
    fill: vi.fn(async () => {}),
    getByRole: vi.fn((role: string) =>
      role === "button" ? { click: vi.fn(async () => void (currentUrl = destination.url)) } : alert,
    ),
    url: vi.fn(() => currentUrl),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => "complete"),
  } as unknown as Page;
}

describe("loginAsE2EUser", () => {
  beforeEach(() => {
    process.env.E2E_USER_EMAIL = "e2e@example.test";
    process.env.E2E_USER_PASSWORD = "test-password";
  });

  it.each(["/dashboard", "/fi/dashboard", "/en/dashboard", "/ar/dashboard"])(
    "accepts the authenticated dashboard route %s",
    async (pathname) => {
      await expect(
        loginAsE2EUser(pageFor({ url: `https://staging.example.test${pathname}` })),
      ).resolves.toBeUndefined();
    },
  );

  it("rejects onboarding instead of treating it as authenticated success", async () => {
    await expect(
      loginAsE2EUser(pageFor({ url: "https://staging.example.test/en/onboarding" })),
    ).rejects.toThrow(/pathname="\/en\/onboarding".*route=onboarding/);
  });

  it("fails immediately with the login pathname and alert state", async () => {
    await expect(
      loginAsE2EUser(
        pageFor({ url: "https://staging.example.test/login", alert: "Something went wrong" }),
      ),
    ).rejects.toThrow(
      /login form reported an authentication error.*pathname="\/login".*alert="Something went wrong"/,
    );
  });

  it("rejects a redirect back to login with its query state", async () => {
    await expect(
      loginAsE2EUser(pageFor({ url: "https://staging.example.test/login?next=%2Fdashboard" })),
    ).rejects.toThrow(/redirected back to the login route.*pathname="\/login\?next=%2Fdashboard"/);
  });

  it("rejects an unexpected post-login route with its exact pathname", async () => {
    await expect(
      loginAsE2EUser(pageFor({ url: "https://staging.example.test/en/settings/profile" })),
    ).rejects.toThrow(/unexpected route.*pathname="\/en\/settings\/profile"/);
  });
});

describe("classifyE2ELoginPathname", () => {
  it("does not accept dashboard-like prefixes or nested paths", () => {
    expect(classifyE2ELoginPathname("/dashboard-preview")).toBe("unexpected");
    expect(classifyE2ELoginPathname("/en/dashboard/settings")).toBe("unexpected");
  });
});
