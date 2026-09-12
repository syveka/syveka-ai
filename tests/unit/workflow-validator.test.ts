import { describe, expect, it } from "vitest";
import { workflowSchema } from "@/lib/validators/workflows";

function activityStep(id: string) {
  return {
    id,
    type: "crm.create_activity" as const,
    contactIdVar: "trigger.contactId",
    activityType: "NOTE" as const,
    subject: "A",
  };
}

function notifyStep(id: string) {
  return { id, type: "notify.member" as const, title: "B" };
}

describe("workflowSchema: step id uniqueness", () => {
  it("rejects two steps sharing the same id, even across different step types", () => {
    const result = workflowSchema.safeParse({
      name: "Dup test",
      trigger: { type: "manual" },
      steps: [activityStep("s123"), notifyStep("s123")],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      expect(issue.message.toLowerCase()).toContain("duplicate");
      // Points at the second (duplicate) occurrence, not just a generic
      // workflow-level error.
      expect(issue.path).toEqual(["steps", 1, "id"]);
    }
  });

  it("rejects three steps sharing the same id, flagging both later occurrences", () => {
    const result = workflowSchema.safeParse({
      name: "Triple dup test",
      trigger: { type: "manual" },
      steps: [activityStep("x"), notifyStep("x"), activityStep("x")],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("steps.1.id");
      expect(paths).toContain("steps.2.id");
    }
  });

  it("is case-sensitive: stepA and StepA are distinct ids", () => {
    const result = workflowSchema.safeParse({
      name: "Case test",
      trigger: { type: "manual" },
      steps: [activityStep("stepA"), notifyStep("StepA")],
    });
    expect(result.success).toBe(true);
  });

  it("accepts two steps of the same type with distinct ids", () => {
    const result = workflowSchema.safeParse({
      name: "Same type, distinct ids",
      trigger: { type: "manual" },
      steps: [
        { id: "s1", type: "email.send", to: "a@example.test", subject: "Hi", body: "Body" },
        { id: "s2", type: "email.send", to: "b@example.test", subject: "Hi", body: "Body" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a larger workflow (20 steps, all-unique ids)", () => {
    const steps = Array.from({ length: 20 }, (_, i) => activityStep(`s${i}`));
    const result = workflowSchema.safeParse({
      name: "Large workflow",
      trigger: { type: "manual" },
      steps,
    });
    expect(result.success).toBe(true);
  });

  it("still rejects a duplicate at the end of a large workflow", () => {
    const steps = Array.from({ length: 19 }, (_, i) => activityStep(`s${i}`));
    steps.push(activityStep("s0")); // duplicates the very first step's id
    const result = workflowSchema.safeParse({
      name: "Large workflow with a late duplicate",
      trigger: { type: "manual" },
      steps,
    });
    expect(result.success).toBe(false);
  });
});
