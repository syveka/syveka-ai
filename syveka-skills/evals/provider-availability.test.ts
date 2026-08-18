import { describe, expect, it } from "vitest";
import { runTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";
import { shadcnMcpProvider } from "../providers/shadcn-mcp/index.js";
import { createLocalTestRunnerProvider } from "../providers/local-test-runner/index.js";

describe("provider unavailable / provider failure handling", () => {
  it("reports CAPABILITY_UNAVAILABLE, never COMPLETE, when the only provider for a step is unavailable", async () => {
    const report = await runTask("eval-unavailable-1", "Improve this dashboard", {
      providerMap: { shadcn: shadcnMcpProvider },
      approvalGate: new ApprovalGate(),
    });

    expect(report.status).toBe("CAPABILITY_UNAVAILABLE");
    expect(report.status).not.toBe("COMPLETE");
    expect(report.verification.status).not.toBe("VERIFIED");
  });

  it("reports FAILED, not COMPLETE, when a provider genuinely fails mid-task", async () => {
    const failingProvider = createLocalTestRunnerProvider({
      command: "node",
      args: ["-e", "process.exit(1)"],
      cwd: process.cwd(),
    });

    const report = await runTask("eval-failure-1", "Fix this failing workflow", {
      providerMap: { "local-test-runner": failingProvider },
      approvalGate: new ApprovalGate(),
      actionForCapability: () => "test.run.local",
    });

    expect(report.status).toBe("FAILED");
    expect(report.verification.status).toBe("FAILED");
  });

  it("never silently skips an unavailable capability and reports success anyway", async () => {
    // A plan with two steps where the FIRST is unavailable - the
    // orchestrator must stop there, not skip ahead to whatever comes next
    // and report as if the whole task succeeded.
    const report = await runTask("eval-unavailable-2", "Find a skill for something", {
      providerMap: {}, // nothing registered at all
      approvalGate: new ApprovalGate(),
    });

    expect(report.status).toBe("CAPABILITY_UNAVAILABLE");
  });
});
