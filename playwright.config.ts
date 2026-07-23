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
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }, // §9 mobile-critical surfaces
  ],
});
