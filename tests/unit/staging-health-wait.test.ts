import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(__dirname, "../../.github/workflows/staging-release.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");

function stepBlock(stepName: string): string {
  const marker = `- name: ${stepName}`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`Step "${stepName}" not found in staging-release.yml`);
  const nextStep = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, nextStep === -1 ? undefined : nextStep);
}

describe("staging-release.yml health-check retry budget", () => {
  it("gives cold Preview deployments a multi-minute retry budget, not the old fixed ~120s", () => {
    const block = stepBlock("Wait for staging health");
    const match = block.match(/max_attempts=(\d+)/);
    expect(match, "step must define max_attempts").not.toBeNull();
    const maxAttempts = Number(match![1]);
    // 3 consecutive runs timed out at the old 12-attempt/10s (~120s) budget while the
    // same deployment verified healthy moments later -- this asserts real headroom
    // beyond that, not just a token bump.
    expect(maxAttempts).toBeGreaterThanOrEqual(24);
  });

  it("bounds each individual request so one hung attempt can't consume the whole budget", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toMatch(/curl[^\n]*--max-time\s+\d+/s);
    expect(block).toMatch(/--connect-timeout\s+\d+/);
  });

  it("still requires an exact 200 to pass -- the health gate itself isn't weakened", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toContain('"$status" = "200"');
  });

  it("prints the observed status and sanitized body on every failed attempt", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toMatch(/echo\s+"Attempt \$attempt\/\$max_attempts: status=\$status/);
    expect(block).toContain(
      "Staging health check did not become healthy after $max_attempts attempts",
    );
  });

  it("keeps sending the bypass header against the exact per-run deployment URL", () => {
    const block = stepBlock("Wait for staging health");
    expect(block).toContain("x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("secrets.VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(block).toContain("steps.staging-url.outputs.url");
    expect(block).not.toMatch(/echo\s+"?\$VERCEL_AUTOMATION_BYPASS_SECRET\b/);
  });
});
