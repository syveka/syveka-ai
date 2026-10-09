import { describe, expect, it } from "vitest";
import { runStructuredTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";
import { VOICE_SUMMARY_CAPABILITY } from "../providers/voice-summary/index.js";
import { createVoiceSummaryProvider } from "../providers/voice-summary/real-provider.js";
import type { VoiceSummaryCompletionClient } from "../providers/voice-summary/completion-client.js";
import { callSummaryOutputSchema } from "../providers/voice-summary/schema.js";
import type { RegistryEntry } from "../schemas/index.js";

/**
 * PHASE 15 (overnight mission): a production-LIKE shadow execution test.
 * Proves the REAL provider (mocked vendor client only - no network)
 * participates in the exact same core execution path
 * (route -> permission -> execute -> evidence -> verify -> audit) as the
 * deterministic test provider already proven in
 * evals/voice-call-summary.test.ts's "PHASE 7B" block.
 *
 * This is NOT the production route. src/app/api/v1/jobs/post-call/route.ts
 * is not imported, not called, not modified. The registry override and
 * pre-approved ApprovalGate below are the same TEST-ONLY seams already
 * established and reviewed in that file - not a new trust boundary.
 */

const TEST_ELIGIBLE_REGISTRY_ENTRY: RegistryEntry = {
  id: "voice-summary-real-TEST-ONLY",
  name: "Voice Call Summary (real provider, TEST-ONLY eligible override)",
  capability: VOICE_SUMMARY_CAPABILITY,
  provider: "voice-summary-real-TEST-ONLY",
  source: "evals/voice-summary-shadow-pipeline.test.ts",
  license: "N/A (test fixture)",
  trust_level: "CONDITIONAL",
  risk_level: "MEDIUM",
  status: "EXPERIMENTAL",
  integration_state: "CONNECTED",
  supported_agents: ["claude-code"],
  permissions: ["network:egress"],
  network_access: false,
  filesystem_access: false,
  scripts: false,
  hooks: false,
  dependencies: [],
  credential_requirements: [],
  approval_required: true,
  installation_scope: "none",
  last_reviewed: "2026-09-09",
  last_updated: "2026-09-09",
  security_notes: "TEST-ONLY fixture - never written to the committed registry.",
};

const MOCK_OUTPUT = {
  summary: "Caller reported a billing discrepancy and requested a callback.",
  callerIntent: "Billing discrepancy",
  keyFacts: ["Invoice amount does not match quote"],
  actionItems: ["Call back with corrected invoice"],
  followUpRequired: true,
  urgency: "medium" as const,
  language: "en" as const,
  confidence: "high" as const,
};

function mockConfiguredClient(): VoiceSummaryCompletionClient {
  return {
    isConfigured: () => true,
    async complete() {
      return { rawText: JSON.stringify(MOCK_OUTPUT), model: "mock-shadow-model" };
    },
  };
}

function withTestOverride(taskId: string) {
  const approvalGate = new ApprovalGate();
  approvalGate.decide(`${taskId}:${VOICE_SUMMARY_CAPABILITY}`, "APPROVED");
  return {
    providerMap: {
      "voice-summary-real-TEST-ONLY": createVoiceSummaryProvider(mockConfiguredClient()),
    },
    approvalGate,
    registryOverrideForCapability: (capability: string) =>
      capability === VOICE_SUMMARY_CAPABILITY ? [TEST_ELIGIBLE_REGISTRY_ENTRY] : undefined,
  };
}

const VALID_INPUT = {
  transcript: "Hi, I was billed the wrong amount and I'd like a callback about it.",
  callId: "call-shadow-1",
};

describe("voice.summarize: PHASE 15 shadow execution - real provider through the full orchestrator pipeline", () => {
  it("the real provider (mocked client) reaches SUCCESS through runStructuredTask(), same as the deterministic test provider does", async () => {
    const report = await runStructuredTask(
      "eval-shadow-1",
      { capability: VOICE_SUMMARY_CAPABILITY, input: VALID_INPUT },
      withTestOverride("eval-shadow-1"),
    );
    // UNVERIFIED, not CAPABILITY_UNAVAILABLE/BLOCKED/FAILED - proves the real
    // provider was actually reached, called the (mocked) vendor, validated
    // its output, and completed - matching the same honest
    // AI-output-cannot-self-verify semantics as the deterministic provider.
    expect(report.status).toBe("UNVERIFIED");

    const toolExecuted = report.audit_trail.find((e) => e.type === "tool_executed");
    expect(toolExecuted).toBeDefined();
    const providerSelected = report.audit_trail.find((e) => e.type === "provider_selected");
    expect((providerSelected?.data as { provider?: string } | undefined)?.provider).toBe(
      "voice-summary-real-TEST-ONLY",
    );

    const artifact = report.verification.evidence.items.find((i) => i.type === "artifact");
    expect(artifact).toBeDefined();
    const artifactData = JSON.parse(artifact!.data) as { model?: string };
    expect(artifactData.model).toBe("mock-shadow-model");
  });

  it("without the registry override, the identical real-provider providerMap still fails closed - production routing is unaffected by this provider existing", async () => {
    const report = await runStructuredTask(
      "eval-shadow-2",
      { capability: VOICE_SUMMARY_CAPABILITY, input: VALID_INPUT },
      { providerMap: withTestOverride("eval-shadow-2").providerMap }, // no registryOverrideForCapability
    );
    expect(report.status).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("the real, committed registry entry (status: REVIEW) still fails closed even with a fully working real-provider client injected and available", async () => {
    const report = await runStructuredTask(
      "eval-shadow-3",
      { capability: VOICE_SUMMARY_CAPABILITY, input: VALID_INPUT },
      { providerMap: { "voice-summary": createVoiceSummaryProvider(mockConfiguredClient()) } },
    );
    expect(report.status).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("raw transcript never appears anywhere in the shadow pipeline's report", async () => {
    const distinctiveMarker = "MARKER-shadow-pipeline-9c4f1a";
    const report = await runStructuredTask(
      "eval-shadow-4",
      {
        capability: VOICE_SUMMARY_CAPABILITY,
        input: { transcript: `Call detail: ${distinctiveMarker}.`, callId: "call-shadow-4" },
      },
      withTestOverride("eval-shadow-4"),
    );
    expect(JSON.stringify(report)).not.toContain(distinctiveMarker);
  });

  it("the output carried in the report's evidence is schema-valid CallSummaryOutput-derived metadata", async () => {
    const report = await runStructuredTask(
      "eval-shadow-5",
      { capability: VOICE_SUMMARY_CAPABILITY, input: VALID_INPUT },
      withTestOverride("eval-shadow-5"),
    );
    const artifact = report.verification.evidence.items.find((i) => i.type === "artifact");
    const artifactData = JSON.parse(artifact!.data) as { urgency: string; confidence: string };
    expect(callSummaryOutputSchema.shape.urgency.safeParse(artifactData.urgency).success).toBe(
      true,
    );
    expect(
      callSummaryOutputSchema.shape.confidence.safeParse(artifactData.confidence).success,
    ).toBe(true);
  });
});
