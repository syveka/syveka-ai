import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = fs.readFileSync(
  path.join(__dirname, "../../scripts/validate-staging-config.mjs"),
  "utf8",
);
const workflow = fs.readFileSync(
  path.join(__dirname, "../../.github/workflows/staging-release.yml"),
  "utf8",
);
const smoke = fs.readFileSync(path.join(__dirname, "../e2e/smoke.spec.ts"), "utf8");

const coreRuntimeNames = [
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "DATABASE_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

describe("staging runtime configuration gate", () => {
  it("checks every core Vercel Preview setting name before building", () => {
    for (const name of coreRuntimeNames) expect(script).toContain(`"${name}"`);
    expect(workflow).toContain("STAGING_CONFIG_MODE=runtime");
    expect(workflow).toContain("--env-file=.vercel/.env.preview.local");
    expect(workflow.indexOf("STAGING_CONFIG_MODE=runtime")).toBeLessThan(
      workflow.indexOf('vercel@$VERCEL_CLI_VERSION" build'),
    );
  });

  it("does not require the migration-only DIRECT_URL in the Vercel runtime gate", () => {
    const runtimeBlock = script.slice(
      script.indexOf('mode === "runtime"'),
      script.indexOf('mode === "e2e"'),
    );
    expect(runtimeBlock).not.toContain("DIRECT_URL");
  });

  it("fails authenticated staging smoke setup instead of skipping it", () => {
    expect(workflow).toContain("Require authenticated staging E2E credentials");
    expect(workflow).toContain("secrets.STAGING_E2E_USER_EMAIL");
    expect(workflow).toContain("secrets.STAGING_E2E_USER_PASSWORD");
    expect(smoke).not.toContain("test.skip(!process.env.E2E_USER_EMAIL");
    expect(smoke).toContain("Authenticated staging smoke tests require");
  });
});
