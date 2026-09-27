import { describe, expect, it } from "vitest";
import { credentialEntryOriginError } from "../e2e/helpers/auth";

/**
 * The E2E login helper must never type the shared staging credentials into a
 * page on a different origin than the one /login was requested on (its route
 * classification is pathname-only, so an off-host /login looks identical).
 */
describe("credentialEntryOriginError", () => {
  const preview = "https://syveka-ai-staging-f3ued7t46-syveka-ai.vercel.app";

  it("allows credential entry when /login stays on the requested origin", () => {
    expect(credentialEntryOriginError(`${preview}/login`, `${preview}/login`)).toBeNull();
    expect(credentialEntryOriginError(`${preview}/login`, `${preview}/fi/login?next=x`)).toBeNull();
  });

  it.each([
    ["the production domain", "https://syveka.com/login"],
    [
      "the stable staging alias (a different deployment)",
      "https://syveka-ai-staging.vercel.app/login",
    ],
    ["Vercel's SSO page", "https://vercel.com/sso-api"],
    ["an http downgrade", preview.replace("https:", "http:") + "/login"],
    ["another port", `${preview}:8443/login`],
  ])("refuses when /login lands on %s", (_label, landed) => {
    const error = credentialEntryOriginError(`${preview}/login`, landed);
    expect(error).toMatch(/^E2E login refused/);
    expect(error).toContain(new URL(landed).origin);
  });

  it("refuses when the URLs cannot be parsed", () => {
    expect(credentialEntryOriginError("", `${preview}/login`)).toMatch(/could not parse/);
  });

  it("never includes paths, queries or credentials in the message", () => {
    const error = credentialEntryOriginError(
      `${preview}/login?token=abc`,
      "https://user:pw@evil.example/login?secret=1",
    )!;
    expect(error).not.toMatch(/token=|secret=|user:pw|\?/);
    expect(error).toContain("https://evil.example");
  });
});
