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

  // The stable alias (the staging project's own Production target, and the
  // host every auth email returns to) is now deliberately updated -- but only
  // after the per-run Preview has passed every check, and never with the
  // Deployment Protection bypass secret, which stays confined to the per-run
  // Preview URL.
  it("never sends the bypass secret to the stable alias", () => {
    const steps = workflow.split("\n      - name:").slice(1);
    const aliasSteps = steps.filter((step) => step.includes("syveka-ai-staging.vercel.app"));
    expect(aliasSteps.length).toBeGreaterThan(0);
    for (const step of aliasSteps) {
      expect(step).not.toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
      expect(step).not.toContain("x-vercel-protection-bypass");
    }
  });

  it("only touches the stable alias after the per-run Preview smoke tests pass", () => {
    const previewSmoke = workflow.indexOf("- name: Run essential staging smoke tests");
    const firstAliasReference = workflow.indexOf("syveka-ai-staging.vercel.app");
    expect(previewSmoke).toBeGreaterThan(-1);
    expect(firstAliasReference).toBeGreaterThan(previewSmoke);
  });

  it("uses --prod only in the dedicated stable-alias deploy step", () => {
    const steps = workflow.split("\n      - name:").slice(1);
    const prodSteps = steps.filter((step) => /deploy --prebuilt --prod/.test(step));
    expect(prodSteps).toHaveLength(1);
    expect(prodSteps[0]).toMatch(/^ Deploy validated candidate to the stable staging alias\n/);
  });

  it("never uses --prod for the staging deploy", () => {
    const block = stepBlock("Deploy staging application");
    expect(block).not.toContain("--prod");
  });
});
