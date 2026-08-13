import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(__dirname, "../../.github/workflows/staging-release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8").replace(/\r\n?/g, "\n");

function stepBlock(stepName: string): string {
  const marker = `- name: ${stepName}`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Step "${stepName}" not found in staging-release.yml`);
  const nextStep = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, nextStep === -1 ? undefined : nextStep);
}

describe("staging-release.yml Vercel Deployment Protection bypass", () => {
  it("fails fast with a sanitized message, before the health check, if the bypass secret is missing", () => {
    const block = stepBlock("Require Vercel protection bypass secret");
    expect(block).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("exit 1");
    expect(block).not.toMatch(/echo\s+"?\$VERCEL_AUTOMATION_BYPASS_SECRET\b/);
    expect(workflow.indexOf("Require Vercel protection bypass secret")).toBeLessThan(
      workflow.indexOf("- name: Wait for staging health"),
    );
  });

  it("sends the bypass header on every health-check request, against the exact per-run deployment URL", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toContain("x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("steps.staging-url.outputs.url");
    expect(block).not.toContain("syveka-ai-staging.vercel.app");
    expect(block).not.toMatch(/echo\s+"?\$VERCEL_AUTOMATION_BYPASS_SECRET\b/);
  });

  it("does not weaken the health check's success condition or failure reporting", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toContain('"$status" = "200"');
    expect(block).toContain("Staging health check did not become healthy after");
    expect(block).toContain("exit 1");
  });

  it("passes the bypass secret through to the E2E smoke test step, using the same per-run URL", () => {
    const block = stepBlock("Run essential staging smoke tests");
    expect(block).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("steps.staging-url.outputs.url");
  });

  it("never targets the stable production-target alias anywhere in the job", () => {
    expect(workflow).not.toContain("syveka-ai-staging.vercel.app");
  });

  it("never uses --prod for the staging deploy", () => {
    const block = stepBlock("Deploy staging application");
    expect(block).not.toContain("--prod");
  });
});
