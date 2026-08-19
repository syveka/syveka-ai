/**
 * DEMO: safe end-to-end web research via the real Scrapling provider.
 *
 * Shows the complete path required by Milestone 2:
 *   user intent -> capability selected -> Scrapling selected ->
 *   permission decision -> extraction -> evidence -> verification ->
 *   final report
 *
 * Target: https://quotes.toscrape.com/ - the same public, dedicated
 * testing/documentation site used throughout Scrapling's own docs and the
 * original security review's smoke test (docs/skills/SECURITY_REVIEW.md).
 * No login, no personal data.
 *
 * Requires Docker (real isolation boundary) and network access - this is a
 * live, manual demo, not part of `npm test`. Run with:
 *
 *   npx tsx examples/demo-scrapling-research/run.ts
 */
import { runTask } from "../../core/orchestrator.js";
import { renderReportMarkdown } from "../../core/reporting/index.js";
import { createScraplingProvider, isDockerAvailable } from "../../providers/scrapling/index.js";
import { ApprovalGate } from "../../core/approvals/index.js";

async function main() {
  console.log("=== STEP 0: confirm the isolation boundary (Docker) is actually available ===");
  const dockerOk = await isDockerAvailable();
  console.log(`Docker available: ${dockerOk}`);
  if (!dockerOk) {
    console.error(
      "Docker is required for this demo's isolation boundary - aborting rather than falling back to an unisolated fetch.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n=== STEP 1-8: run the full orchestrated pipeline ===");
  console.log('User intent: "Research this website for me: https://quotes.toscrape.com/"');

  const report = await runTask(
    "demo-scrapling-research-1",
    "Research this website for me: https://quotes.toscrape.com/",
    {
      providerMap: { scrapling: createScraplingProvider() },
      approvalGate: new ApprovalGate(),
      // Explicit LOW-risk classification: plain public-page extraction,
      // no stealth/cookies/auth/proxy. See policies/risk-classification.ts.
      actionForCapability: () => "web.research.public",
    },
  );

  console.log(renderReportMarkdown(report));

  console.log("\n=== Structured evidence fields (the actual research data) ===");
  const evidenceItem = report.verification.evidence.items.find(
    (i) => i.type === "source_reference",
  );
  if (evidenceItem) {
    const structured = JSON.parse(evidenceItem.data) as {
      sourceUrl: string;
      retrievalStatus: string;
      retrievalTimestamp: string;
      extractionMethod: string;
      providerIdentity: string;
      extractedContent: string;
    };
    console.log(`Source URL:        ${structured.sourceUrl}`);
    console.log(`Retrieval status:  ${structured.retrievalStatus}`);
    console.log(`Retrieved at:      ${structured.retrievalTimestamp}`);
    console.log(`Extraction method: ${structured.extractionMethod}`);
    console.log(`Provider identity: ${structured.providerIdentity}`);
    console.log(`Content (excerpt): ${structured.extractedContent.slice(0, 300)}...`);
  }

  console.log(
    "\n=== The key evidence-first point ===\n" +
      `Verification status: ${report.verification.status}\n` +
      "A successful fetch is real, useful evidence for a citation - but by design it is only " +
      '"source_reference" (weak) evidence, so a bare research task like this one cannot reach ' +
      "VERIFIED on the fetch alone. This is intentional, not a bug - see docs/evidence-model.md " +
      "and the task brief's explicit \"a successful HTTP fetch alone must NOT mean the research " +
      'claim is VERIFIED."',
  );

  if (report.status !== "COMPLETE" && report.status !== "UNVERIFIED") {
    console.error(`\nDEMO INTEGRITY CHECK FAILED: unexpected status ${report.status}.`);
    process.exitCode = 1;
    return;
  }
  if (evidenceItem?.data.includes('"retrievalStatus":"success"') !== true) {
    console.error("\nDEMO INTEGRITY CHECK FAILED: fetch did not report success.");
    process.exitCode = 1;
    return;
  }
  console.log(
    "\nDemo result: fetch succeeded, evidence captured, verification correctly UNVERIFIED (weak evidence only).",
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
