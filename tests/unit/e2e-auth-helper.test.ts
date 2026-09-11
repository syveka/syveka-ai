import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { classifyE2ELoginPathname, loginAsE2EUser } from "../e2e/helpers/auth";

type LoginDestination = {
  url: string;
  alert?: string;
  /**
   * Simulates Next.js's AppRouterAnnouncer: a permanently-mounted,
   * page-level (never form-scoped) role="alert" element that is visible by
   * Playwright's definition (sr-only CSS, not display:none) but carries no
   * meaningful text on first load. Defaults to true because the real
   * announcer is present on every App Router page regardless of the login
   * form's own state -- a fix that accidentally falls back to an unscoped
   * page.getByRole("alert") must fail every test below, not just the one
   * that exercises it explicitly.
   */
  pageLevelAnnouncerPresent?: boolean;
};

function pageFor(
  destination: LoginDestination,
): Page & { passwordFieldFill: ReturnType<typeof vi.fn> } {
  let currentUrl = "https://staging.example.test/login";
  const announcerPresent = destination.pageLevelAnnouncerPresent ?? true;
  // The real, form-scoped login error alert -- reachable only via
  // page.locator("form").getByRole("alert"), never via an unscoped
  // page.getByRole("alert").
  const formAlert = {
    isVisible: vi.fn(async () => Boolean(destination.alert)),
    textContent: vi.fn(async () => destination.alert ?? null),
  };
  // The page-level Next.js route announcer -- always visible-per-Playwright,
  // never carries the real error text, and lives outside any <form>.
  const pageLevelAnnouncer = {
    isVisible: vi.fn(async () => announcerPresent),
    textContent: vi.fn(async () => ""),
  };
  const passwordFieldFill = vi.fn(async () => {});

  return {
    goto: vi.fn(async () => {
      currentUrl = "https://staging.example.test/login";
      return null;
    }),
    fill: vi.fn(async () => {}),
    getByRole: vi.fn((role: string) =>
      role === "button"
        ? { click: vi.fn(async () => void (currentUrl = destination.url)) }
        : pageLevelAnnouncer,
    ),
    locator: vi.fn((selector: string) => {
      if (selector === "#password") return { fill: passwordFieldFill };
      if (selector === "form") return { getByRole: vi.fn(() => formAlert) };
      return { fill: vi.fn(async () => {}) };
    }),
    passwordFieldFill,
    url: vi.fn(() => currentUrl),
    waitForLoadState: vi.fn(async () => {}),
    waitForTimeout: vi.fn(async () => {}),
    evaluate: vi.fn(async () => "complete"),
  } as unknown as Page & { passwordFieldFill: ReturnType<typeof vi.fn> };
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

  /**
   * Regression test for a real staging incident: Next.js's AppRouterAnnouncer
   * mounts a permanent, page-level role="alert" element on every App Router
   * page (see loginFormAlert()'s doc comment in helpers/auth.ts). Every case
   * above already runs with the announcer present by default -- this test
   * makes the scenario explicit and asserts the successful path specifically,
   * since a regression back to an unscoped page.getByRole("alert") would make
   * even a genuinely successful login report a false authentication failure.
   */
  it("reaching the dashboard succeeds even though the page-level announcer is present and visible", async () => {
    await expect(
      loginAsE2EUser(
        pageFor({
          url: "https://staging.example.test/dashboard",
          pageLevelAnnouncerPresent: true,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  /**
   * The most direct regression case: no real form error, login still
   * pending (url unchanged), and the page-level announcer visible the whole
   * time. Before the fix, an unscoped page.getByRole("alert") matched the
   * announcer and threw "the login form reported an authentication error"
   * on the very first poll -- observed against real staging while the
   * submit button still read its loading state, before the login Server
   * Action had even resolved. The fix must instead wait out the full
   * timeout and report a timeout, never a false authentication error.
   */
  it("never reports a false authentication error from the page-level announcer alone", async () => {
    await expect(
      loginAsE2EUser(
        pageFor({
          url: "https://staging.example.test/login",
          pageLevelAnnouncerPresent: true,
        }),
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/no post-login outcome appeared within 50ms/);
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

  /**
   * Playwright's own error-context.md (generated on every test failure,
   * independent of trace/screenshot config) captures the live value of any
   * visible form field, unmasked, even for type="password" inputs -- proven
   * directly against a real Playwright run. Every failure path here must
   * clear #password first, or a failed staging E2E run would leak the real
   * account password in a downloadable artifact.
   */
  it("clears the password field before throwing, on every failure path", async () => {
    const page = pageFor({ url: "https://staging.example.test/login", alert: "Invalid" });
    await expect(loginAsE2EUser(page)).rejects.toThrow();
    expect(page.passwordFieldFill).toHaveBeenCalledWith("", { timeout: 1_000 });
  });
});

describe("classifyE2ELoginPathname", () => {
  it("does not accept dashboard-like prefixes or nested paths", () => {
    expect(classifyE2ELoginPathname("/dashboard-preview")).toBe("unexpected");
    expect(classifyE2ELoginPathname("/en/dashboard/settings")).toBe("unexpected");
  });
});
