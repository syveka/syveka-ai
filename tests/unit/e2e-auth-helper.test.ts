import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { classifyE2ELoginPathname, loginAsE2EUser } from "../e2e/helpers/auth";

type LoginDestination = { url: string; alert?: string; strayPageAlert?: boolean };

function pageFor(
  destination: LoginDestination,
): Page & { passwordFieldFill: ReturnType<typeof vi.fn> } {
  let currentUrl = "https://staging.example.test/login";
  const formAlert = {
    isVisible: vi.fn(async () => Boolean(destination.alert)),
    textContent: vi.fn(async () => destination.alert ?? null),
  };
  // Simulates Next.js App Router's own built-in accessibility route
  // announcer: a permanent, visually-hidden role="alert" live region on
  // every page, outside any <form> -- proven live in staging run
  // 34022381914 to make a bare `page.getByRole("alert")` false-positive
  // even when the login form itself has no error. The fixed code (scoped to
  // `page.locator("form").getByRole("alert")`) must never reach this one.
  const strayPageWideAlert = {
    isVisible: vi.fn(async () => Boolean(destination.strayPageAlert)),
    textContent: vi.fn(async () => null),
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
        : strayPageWideAlert,
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
   * Staging run 34022381914: the first-ever real execution of this login
   * flow against a real deployed app immediately failed with "the login
   * form reported an authentication error" -- but the error-context.md ARIA
   * snapshot showed the submit button still mid-request ("Ladataan…",
   * disabled) and no error paragraph anywhere inside the form. A bare
   * `page.getByRole("alert")` was matching Next.js App Router's own
   * always-present route announcer instead of the form's real error
   * message, so this check false-positived on every login attempt,
   * regardless of whether the credentials were actually correct.
   */
  it("does not false-positive on a stray page-wide alert outside the form", async () => {
    await expect(
      loginAsE2EUser(
        pageFor({ url: "https://staging.example.test/dashboard", strayPageAlert: true }),
      ),
    ).resolves.toBeUndefined();
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
