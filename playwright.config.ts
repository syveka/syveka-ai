import { defineConfig, devices } from "@playwright/test";

function resolveE2EBaseURL() {
  const configuredBaseURL = process.env.E2E_BASE_URL?.trim();

  if (!configuredBaseURL) {
    if (process.env.CI) {
      throw new Error("E2E_BASE_URL is required in CI and must be an absolute HTTP(S) URL.");
    }

    return "http://localhost:3000";
  }

  let parsedBaseURL: URL;
  try {
    parsedBaseURL = new URL(configuredBaseURL);
  } catch {
    throw new Error(
      `E2E_BASE_URL must be an absolute HTTP(S) URL; received ${JSON.stringify(configuredBaseURL)}.`,
    );
  }

  if (
    !["http:", "https:"].includes(parsedBaseURL.protocol) ||
    !parsedBaseURL.hostname ||
    parsedBaseURL.username ||
    parsedBaseURL.password ||
    parsedBaseURL.pathname !== "/" ||
    parsedBaseURL.search ||
    parsedBaseURL.hash
  ) {
    throw new Error(
      `E2E_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment; received ${JSON.stringify(configuredBaseURL)}.`,
    );
  }

  return parsedBaseURL.origin;
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: resolveE2EBaseURL(),
    trace: "retain-on-failure",
    locale: "fi-FI",
    // Staging Preview deployments sit behind Vercel Deployment Protection;
    // this header is required for automated requests to reach them at all.
    extraHTTPHeaders: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
      : undefined,
  },
  projects: [
    {
      name: "auth-setup",
      testMatch: /auth\.setup\.ts/,
      // Never trace this project: it types the real E2E password into a
      // live form field, and Playwright's trace unconditionally records
      // every action's arguments (including .fill() calls) and DOM
      // snapshots (including live input values, via its own
      // __playwright_value__ marker) regardless of what happens
      // afterward -- confirmed directly against a real trace.zip. There is
      // no way to keep tracing on here and redact it after the fact.
      use: { trace: "off" },
    },
    {
      name: "desktop",
      testIgnore: /auth\.setup\.ts|rbac-boundary\.spec\.ts/,
      dependencies: ["auth-setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "test-results/.auth/e2e-user.json",
      },
    },
    {
      name: "mobile",
      testIgnore: /auth\.setup\.ts|rbac-boundary\.spec\.ts/,
      dependencies: ["auth-setup"],
      use: { ...devices["Pixel 7"], storageState: "test-results/.auth/e2e-user.json" },
    }, // §9 mobile-critical surfaces
    {
      // rbac-boundary.spec.ts temporarily changes the shared E2E user's role
      // on the shared fixture org. MEMBER lacks business-dna:write and
      // billing:view (see src/server/auth/permissions.ts), so if this ran
      // concurrently with business-dna.spec.ts or billing.spec.ts in
      // desktop/mobile, either could spuriously fail mid-run. Depending on
      // both projects guarantees every other authenticated test has finished
      // before this one starts, so the role change never overlaps anything.
      name: "rbac-mutations",
      testMatch: /rbac-boundary\.spec\.ts/,
      dependencies: ["desktop", "mobile"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "test-results/.auth/e2e-user.json",
      },
    },
  ],
});
