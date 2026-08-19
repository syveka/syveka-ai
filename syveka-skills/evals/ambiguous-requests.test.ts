import { describe, expect, it } from "vitest";
import { classifyIntent } from "../core/intent/index.js";
import { runTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";

describe("ambiguous user requests", () => {
  it("a vague request with no matching keywords returns low confidence, not a guessed capability", () => {
    const result = classifyIntent("do the thing");
    expect(result.confidence).toBe("low");
    expect(result.capabilities).toHaveLength(0);
    expect(result.taskType).toBe("clarification_needed");
  });

  it("an empty-ish request also returns clarification_needed rather than matching by accident", () => {
    const result = classifyIntent("please help");
    expect(result.taskType).toBe("clarification_needed");
  });

  it("the orchestrator reports CAPABILITY_UNAVAILABLE (asks for clarification), never fabricates a plan, for a low-confidence request", async () => {
    const report = await runTask("eval-ambiguous-1", "do the thing", {
      providerMap: {},
      approvalGate: new ApprovalGate(),
    });
    expect(report.status).toBe("CAPABILITY_UNAVAILABLE");
    expect(report.plan.steps).toHaveLength(1);
    expect(report.plan.steps[0]!.capability).toBe("clarification.request");
  });

  it("a clearly-worded request still classifies with high confidence (the classifier is not overly cautious)", () => {
    const result = classifyIntent("Fix this failing workflow");
    expect(result.confidence).toBe("high");
    expect(result.taskType).toBe("bug_fix");
  });
});
