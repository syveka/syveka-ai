import { describe, expect, it } from "vitest";
import { runTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";
import { createCallSummaryProvider } from "../providers/call-summary/index.js";
import type { CallSummaryResult } from "../schemas/call-summary.js";

/**
 * Tenant isolation and audit-safety proof for "voice-pilot/call-summary" -
 * task brief §4/§8. Tenant isolation here is enforced at the application
 * layer, from the caller-supplied `tenant_id` field, which is expected to
 * be populated from a server-verified session/tenant context by whatever
 * calls this Skill (see CLAUDE.md §4) - never from anything embedded in
 * the transcript itself. The provider is deliberately stateless (no shared
 * mutable state, no cache, no database) so there is no code path by which
 * one tenant's call could influence another's result.
 */

function turn(speaker: "agent" | "caller", text: string) {
  return { speaker, text };
}

function inputFor(tenantId: string, transcript = [turn("caller", "Hello, I have a question.")]) {
  return { tenant_id: tenantId, call_id: "call-shared-id", transcript };
}

async function run(tenantId: string, transcript?: ReturnType<typeof turn>[], taskId?: string) {
  const id = taskId ?? `eval-tenant-${tenantId}`;
  const gate = new ApprovalGate();
  gate.decide(`${id}:voice.call_summary`, "APPROVED");
  return runTask(id, "Please summarize this call for me", {
    providerMap: { "voice-pilot-call-summary": createCallSummaryProvider() },
    approvalGate: gate,
    actionForCapability: () => "voice.call_summary.execute",
    context: inputFor(tenantId, transcript),
  });
}

describe("call-summary: tenant isolation", () => {
  it("tenant A's result is scoped to tenant A, never tenant B, even for the identical call_id", async () => {
    const reportA = await run("tenant-a");
    const reportB = await run("tenant-b");

    const dataA = reportA.verification.evidence.items.find((i) => i.type === "test");
    const dataB = reportB.verification.evidence.items.find((i) => i.type === "test");
    expect(dataA).toBeDefined();
    expect(dataB).toBeDefined();

    // The only tenant-identifying signal in the audit-visible message is
    // whatever this run's OWN input declared - proven by re-deriving it
    // directly from the provider rather than trusting the report alone.
    const provider = createCallSummaryProvider();
    const resultA = await provider.execute(inputFor("tenant-a"));
    const resultB = await provider.execute(inputFor("tenant-b"));
    const outA = resultA.data as CallSummaryResult;
    const outB = resultB.data as CallSummaryResult;
    expect(outA.meta.tenant_ref).toBe("tenant-a");
    expect(outB.meta.tenant_ref).toBe("tenant-b");
    expect(outA.meta.tenant_ref).not.toBe(outB.meta.tenant_ref);
  });

  it("running tenant B immediately after tenant A does not leak tenant A's transcript content into tenant B's result", async () => {
    const provider = createCallSummaryProvider();
    const secretTranscript = [turn("caller", "My secret account note is PROJECT-NIGHTINGALE-A.")];
    const resultA = await provider.execute(inputFor("tenant-a", secretTranscript));
    const dataA = resultA.data as CallSummaryResult;
    expect(dataA.meta.tenant_ref).toBe("tenant-a");

    const resultB = await provider.execute(inputFor("tenant-b", [turn("caller", "Hi there.")]));
    const dataB = resultB.data as CallSummaryResult;
    const bText = JSON.stringify(dataB.output);
    expect(bText).not.toContain("PROJECT-NIGHTINGALE-A");
    expect(dataB.meta.tenant_ref).toBe("tenant-b");
  });

  it("missing tenant context fails closed - no output is produced, not even a partial one", async () => {
    const provider = createCallSummaryProvider();
    const result = await provider.execute({
      call_id: "call-no-tenant",
      transcript: [turn("caller", "Hello")],
    });
    expect(result.status).toBe("FAILURE");
    // No structured output is produced on failure - only observability
    // metadata (see call-summary.test.ts "malformed transcript payload").
    expect((result.data as { output?: unknown } | undefined)?.output).toBeUndefined();
  });

  it("an empty-string tenant_id also fails closed (not treated as 'no scoping needed')", async () => {
    const provider = createCallSummaryProvider();
    const result = await provider.execute(inputFor(""));
    expect(result.status).toBe("FAILURE");
  });

  it("the orchestrator's full report for a missing-tenant call is FAILED, never COMPLETE", async () => {
    const gate = new ApprovalGate();
    gate.decide("eval-tenant-missing:voice.call_summary", "APPROVED");
    const report = await runTask("eval-tenant-missing", "Please summarize this call for me", {
      providerMap: { "voice-pilot-call-summary": createCallSummaryProvider() },
      approvalGate: gate,
      actionForCapability: () => "voice.call_summary.execute",
      context: { call_id: "call-x", transcript: [turn("caller", "Hello")] },
    });
    expect(report.status).toBe("FAILED");
  });
});

describe("call-summary: audit/evidence does not store raw transcript content", () => {
  it("neither the audit trail nor the evidence bundle contains the raw transcript text, only metadata", async () => {
    const secretPhrase = "MY-SENSITIVE-TRANSCRIPT-PHRASE-7f3a";
    const gate = new ApprovalGate();
    gate.decide("eval-tenant-audit:voice.call_summary", "APPROVED");
    const report = await runTask("eval-tenant-audit", "Please summarize this call for me", {
      providerMap: { "voice-pilot-call-summary": createCallSummaryProvider() },
      approvalGate: gate,
      actionForCapability: () => "voice.call_summary.execute",
      context: inputFor("tenant-audit", [turn("caller", secretPhrase)]),
    });

    const auditText = JSON.stringify(report.audit_trail);
    expect(auditText).not.toContain(secretPhrase);

    const evidenceText = JSON.stringify(report.verification.evidence.items);
    expect(evidenceText).not.toContain(secretPhrase);
  });

  it("the operational message/evidence records tenant reference, provider, and status - real metadata, not a bare claim", async () => {
    const provider = createCallSummaryProvider();
    const result = await provider.execute(inputFor("tenant-observability"));
    expect(result.message).toContain("tenant-observability");
    const data = result.data as CallSummaryResult;
    expect(data.meta.skill).toBe("voice-pilot/call-summary");
    expect(data.meta.provider).toBe("voice-pilot-call-summary");
    expect(data.meta.status).toBe("success");
    expect(typeof data.meta.duration_ms).toBe("number");
    expect(data.meta.started_at).toBeTruthy();
    expect(data.meta.ended_at).toBeTruthy();
  });
});
