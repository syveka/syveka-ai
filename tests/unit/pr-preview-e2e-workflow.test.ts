import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static safety contract of .github/workflows/pr-preview-e2e.yml: preview
 * discovery runs the tested, trusted-main resolver; staging credentials stay
 * scoped to the steps that need them; nothing can point the harness at
 * production. No network calls.
 */
const root = path.join(__dirname, "../..");
const workflow = fs
  .readFileSync(path.join(root, ".github/workflows/pr-preview-e2e.yml"), "utf8")
  .replace(/\r\n?/g, "\n");

type Step = { name: string; text: string };
const steps: Step[] = workflow
  .split("\n      - name: ")
  .slice(1)
  .map((chunk) => ({ name: chunk.split("\n")[0]!.trim(), text: chunk }));
const indexOf = (fragment: string) => {
  const i = steps.findIndex((s) => s.name.includes(fragment));
  if (i < 0) throw new Error(`no step containing "${fragment}"`);
  return i;
};
const step = (fragment: string) => steps[indexOf(fragment)]!;

describe("pr-preview-e2e workflow: triggers and gates", () => {
  it("runs only on manual dispatch with PR number and exact SHA inputs", () => {
    const on = workflow.slice(workflow.indexOf("\non:"), workflow.indexOf("\npermissions:"));
    expect(on).toContain("workflow_dispatch:");
    expect(on).toContain("pr_number:");
    expect(on).toContain("expected_sha:");
    expect(on).not.toMatch(
      /\b(push|pull_request|pull_request_target|schedule|workflow_run|workflow_call|repository_dispatch):/,
    );
  });

  it("keeps the staging environment approval gate and read-only token permissions", () => {
    expect(workflow).toContain("    environment: staging\n");
    expect(workflow).not.toMatch(/environment:\s*production/i);
    const permissions = workflow.slice(
      workflow.indexOf("\npermissions:"),
      workflow.indexOf("\nconcurrency:"),
    );
    expect(permissions).toContain("contents: read");
    expect(permissions).toContain("deployments: read");
    expect(permissions).toContain("pull-requests: read");
    expect(permissions).not.toMatch(/:\s*write/);
  });

  it("never references production configuration (outside explanatory comments)", () => {
    const code = workflow
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/PRODUCTION_/);
    expect(code).not.toMatch(/syveka-ai-production/);
  });
});

describe("pr-preview-e2e workflow: preview discovery", () => {
  it("resolves via the unit-tested module, not an inline script", () => {
    const resolve = step("Resolve verified Preview deployment URL");
    expect(resolve.text).toContain("node scripts/ci/select-staging-preview-deployment.mjs");
    expect(workflow).not.toContain("NODE_EOF");
    expect(workflow).not.toContain('d.environment === "Preview"');
  });

  it("runs the resolver only from the pinned, verified trusted-main checkout", () => {
    expect(indexOf("Checkout trusted E2E harness (pinned main)")).toBeLessThan(
      indexOf("Resolve verified Preview deployment URL"),
    );
    expect(indexOf("Verify checked-out trusted harness")).toBeLessThan(
      indexOf("Resolve verified Preview deployment URL"),
    );
    expect(indexOf("Verify PR head SHA matches expected SHA")).toBeLessThan(
      indexOf("Resolve verified Preview deployment URL"),
    );
    const checkout = step("Checkout trusted E2E harness (pinned main)");
    expect(checkout.text).toContain("ref: ${{ steps.trusted-main.outputs.sha }}");
    expect(checkout.text).toContain("persist-credentials: false");
  });

  it("re-validates the resolver output as a staging-project preview origin before use", () => {
    const resolve = step("Resolve verified Preview deployment URL");
    expect(resolve.text).toContain(
      '[[ ! "$verified_url" =~ ^https://syveka-ai-staging-[a-z0-9]+-syveka-ai\\.vercel\\.app$ ]]',
    );
    expect(resolve.text).toContain("set -euo pipefail");
    expect(step("Run trusted E2E harness").text).toContain(
      "E2E_BASE_URL: ${{ steps.resolve.outputs.url }}",
    );
  });
});

describe("pr-preview-e2e workflow: credential scoping", () => {
  const holders = (secret: string) =>
    steps.filter((s) => s.text.includes(`secrets.${secret}`)).map((s) => s.name);

  it("exposes the staging Vercel token, project id and org id only to the resolve step", () => {
    for (const secret of [
      "STAGING_VERCEL_TOKEN",
      "STAGING_VERCEL_PROJECT_ID",
      "STAGING_VERCEL_ORG_ID",
    ]) {
      expect(holders(secret)).toEqual(["Resolve verified Preview deployment URL"]);
    }
  });

  it("never gives the resolve step the E2E user credentials or the bypass secret", () => {
    const resolve = step("Resolve verified Preview deployment URL").text;
    expect(resolve).not.toMatch(/E2E_USER_(EMAIL|PASSWORD)|VERCEL_AUTOMATION_BYPASS_SECRET/);
  });

  it("keeps E2E credentials on the test step only, with tracing forced off", () => {
    expect(holders("STAGING_E2E_USER_PASSWORD")).toEqual([
      "Run trusted E2E harness against verified PR Preview",
    ]);
    expect(step("Run trusted E2E harness").text).toContain("npm run test:e2e -- --trace=off");
  });

  it("uploads no artifacts", () => {
    expect(workflow).not.toContain("upload-artifact");
  });
});
