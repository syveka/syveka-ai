import { describe, expect, it } from "vitest";
import { runTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";
import { createCallSummaryProvider } from "../providers/call-summary/index.js";
import { createMockCallSummaryProvider } from "../providers/call-summary/mock-provider.js";
import { callSummaryOutputSchema, type CallSummaryResult } from "../schemas/call-summary.js";
import { findById } from "../core/registry/index.js";

/**
 * Proves task brief capability #6: "replacing one provider with another
 * does not require modifying the Skill's business logic." Runs the exact
 * same capability ("voice.call_summary"), same registry entry, same
 * intent/planner/policy wiring, through two structurally different
 * `Provider` implementations - only the entry in `providerMap` changes.
 * Neither this test nor any file under core/ or schemas/ was touched to
 * make the mock provider work - see providers/call-summary/mock-provider.ts.
 */

function turn(speaker: "agent" | "caller", text: string) {
  return { speaker, text };
}

function baseContext() {
  return {
    tenant_id: "tenant-portability",
    call_id: "call-portability",
    transcript: [
      turn("agent", "Hello, how can I help you today?"),
      turn("caller", "I'd like to book an appointment please."),
    ],
  };
}

async function runWith(
  providerMapEntry: ReturnType<typeof createCallSummaryProvider>,
  taskId: string,
) {
  const gate = new ApprovalGate();
  gate.decide(`${taskId}:voice.call_summary`, "APPROVED");
  return runTask(taskId, "Please summarize this call for me", {
    // Keyed by the registry's `provider` field ("voice-pilot-call-summary"),
    // exactly as core/router/index.ts requires - this is the ONLY thing
    // that changes between the two calls below.
    providerMap: { "voice-pilot-call-summary": providerMapEntry },
    approvalGate: gate,
    actionForCapability: () => "voice.call_summary.execute",
    context: baseContext(),
  });
}

describe("call-summary: provider portability", () => {
  it("the registry entry names one capability and one provider id, shared by both implementations", () => {
    const entry = findById("voice-pilot-call-summary");
    expect(entry?.capability).toBe("voice.call_summary");
    expect(entry?.provider).toBe("voice-pilot-call-summary");
  });

  it("the reference (deterministic) provider satisfies the contract end-to-end", async () => {
    const report = await runWith(createCallSummaryProvider(), "eval-portability-reference");
    expect(report.status).toBe("COMPLETE");
    expect(report.verification.status).toBe("VERIFIED");
  });

  it("swapping in a structurally different mock provider - no core/schema change - also satisfies the contract end-to-end", async () => {
    const report = await runWith(createMockCallSummaryProvider(), "eval-portability-mock");
    expect(report.status).toBe("COMPLETE");
    expect(report.verification.status).toBe("VERIFIED");
  });

  it("both providers produce output that validates against the exact same output schema", async () => {
    const reference = createCallSummaryProvider();
    const mock = createMockCallSummaryProvider();

    const referenceResult = await reference.execute(baseContext());
    const mockResult = await mock.execute(baseContext());

    const referenceData = referenceResult.data as CallSummaryResult;
    const mockData = mockResult.data as CallSummaryResult;

    expect(callSummaryOutputSchema.safeParse(referenceData.output).success).toBe(true);
    expect(callSummaryOutputSchema.safeParse(mockData.output).success).toBe(true);

    // Different providers legitimately produce different CONTENT (the mock
    // is a fixed canned response) - the portability guarantee is about
    // shape/contract conformance, never about identical output.
    expect(referenceData.output.summary).not.toBe(mockData.output.summary);
    expect(Object.keys(referenceData.output).sort()).toEqual(Object.keys(mockData.output).sort());
  });

  it("the mock provider still enforces the same input contract (rejects malformed input) - portability never means skipping validation", async () => {
    const mock = createMockCallSummaryProvider();
    const result = await mock.execute({ tenant_id: "t", call_id: "c", transcript: [] });
    expect(result.status).toBe("FAILURE");
  });
});
