/**
 * DEMO 3 - Skill discovery.
 *
 * "Find a skill for PDF analysis." Expected: search -> candidates ->
 * provenance check -> license -> security review -> recommendation. Never
 * auto-install.
 *
 * This demo uses the REAL registry lookup provider (searches the actual
 * Syveka Skills Registry, not a live web search - see
 * providers/skill-registry-lookup). Nothing in the registry currently
 * matches "PDF" (only Scrapling, shadcn, 21st.dev, claude-video, and the
 * three first-party local capabilities are registered), so this demo
 * honestly demonstrates "discovery never equals trust" and "do not install
 * until approved" by finding nothing and saying so - not by fabricating a
 * plausible-sounding fake PDF skill.
 */
import { runTask } from "../../core/orchestrator.js";
import { renderReportMarkdown } from "../../core/reporting/index.js";
import { createSkillRegistryLookupProvider } from "../../providers/skill-registry-lookup/index.js";
import { ApprovalGate } from "../../core/approvals/index.js";

async function main() {
  const providerMap = {
    "skill-registry-lookup": createSkillRegistryLookupProvider(),
  };

  const report = await runTask("demo-skill-discovery-1", "Find a skill for PDF analysis", {
    providerMap,
    approvalGate: new ApprovalGate(),
    actionForCapability: () => "docs.search", // LOW risk - read-only lookup
  });

  console.log(renderReportMarkdown(report));

  const discoveryEvidence = report.verification.evidence.items.find((i) =>
    i.description.includes("searchRegistry"),
  );
  const noMatches = discoveryEvidence?.data === "[]";

  if (!noMatches) {
    console.error("\nDEMO INTEGRITY CHECK FAILED: expected zero registry matches for a PDF query.");
    process.exitCode = 1;
    return;
  }
  console.log(
    "\nDemo result: no approved skill found for PDF analysis. Correct behavior is to say so, " +
      "not to install anything or fabricate a plausible-sounding recommendation. A real PDF-" +
      "analysis capability would need to go through Discover -> Inspect -> Security Review -> " +
      "License Review -> Risk Classification -> Approve/Review/Reject -> Install, same as " +
      "Scrapling did (see docs/skills/SECURITY_REVIEW.md), before it could appear here as a match.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
