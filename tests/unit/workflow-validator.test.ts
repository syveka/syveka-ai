import { describe, expect, it } from "vitest";
import { workflowSchema } from "@/lib/validators/workflows";

const base = { name: "Notify", trigger: { type: "contact.created" } };
const notify = (id: string) => ({ id, type: "notify.member", title: "Hi" });

/** booking.ts emits these events; a workflow must be able to subscribe to them. */
describe("workflowSchema booking triggers", () => {
  it.each(["booking.created", "booking.canceled", "booking.rescheduled"])("accepts %s", (type) => {
    expect(
      workflowSchema.safeParse({ ...base, trigger: { type }, steps: [notify("a")] }).success,
    ).toBe(true);
  });

  it("still rejects an unknown trigger", () => {
    expect(
      workflowSchema.safeParse({
        ...base,
        trigger: { type: "booking.deleted" },
        steps: [notify("a")],
      }).success,
    ).toBe(false);
  });
});

/** step.id is the run's durable per-step execution identity (unique per run). */
describe("workflowSchema step ids", () => {
  it("accepts distinct step ids", () => {
    expect(workflowSchema.safeParse({ ...base, steps: [notify("a"), notify("b")] }).success).toBe(
      true,
    );
  });

  it("rejects a repeated step id and points at the second occurrence", () => {
    const result = workflowSchema.safeParse({
      ...base,
      steps: [notify("a"), notify("b"), notify("a")],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ message: "duplicate_step_id", path: ["steps", 2, "id"] }),
    ]);
  });

  it("treats ids case-sensitively, like the execution engine", () => {
    expect(workflowSchema.safeParse({ ...base, steps: [notify("a"), notify("A")] }).success).toBe(
      true,
    );
  });
});
