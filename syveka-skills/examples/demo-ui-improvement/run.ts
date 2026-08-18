/**
 * DEMO 1 - UI improvement.
 *
 * "Improve this dashboard." Expected orchestration per the product brief:
 * understand -> design quality guidance -> component search -> implementation
 * -> test -> verify.
 *
 * Honesty note: neither shadcn/ui MCP nor 21st.dev has a live connection in
 * this environment (see docs/skills/SKILLS_REGISTRY.md - both are status
 * REVIEW, not independently security-reviewed for this MVP yet). This demo
 * therefore demonstrates the OTHER half of the product's value proposition
 * explicitly required by the brief's failure-handling section: "If a
 * provider is unavailable: report capability unavailable instead of
 * pretending success." It proves the orchestrator does not fabricate a fake
 * UI result when it has no real provider to do the work.
 */
import { runTask } from "../../core/orchestrator.js";
import { renderReportMarkdown } from "../../core/reporting/index.js";
import { shadcnMcpProvider } from "../../providers/shadcn-mcp/index.js";
import { twentyFirstDevProvider } from "../../providers/twentyfirst-dev/index.js";
import { ApprovalGate } from "../../core/approvals/index.js";

async function main() {
  const providerMap = {
    shadcn: shadcnMcpProvider,
    "21st-dev": twentyFirstDevProvider,
  };

  const report = await runTask("demo-ui-improvement-1", "Improve this dashboard", {
    providerMap,
    approvalGate: new ApprovalGate(),
  });

  console.log(renderReportMarkdown(report));

  if (report.status !== "CAPABILITY_UNAVAILABLE") {
    console.error(
      `\nDEMO INTEGRITY CHECK FAILED: expected CAPABILITY_UNAVAILABLE, got ${report.status}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "\nDemo result: CAPABILITY_UNAVAILABLE, reported honestly - no fake UI improvement was claimed.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
