import { describe, expect, it } from "vitest";
import { stepSchema, triggerSchema } from "@/lib/validators/workflows";
import {
  ALWAYS_OPEN_RULES,
  BOOKING_TRIGGERS,
  FIXTURE_ORGS,
  TRIGGER_PAYLOAD_KEYS,
  activitySubject,
  ownerEmail,
  pickJourneySlots,
  subAddress,
  workflowName,
  workflowSteps,
} from "../../scripts/e2e-booking-workflow-fixture-config";

/**
 * The staging booking-workflow fixture writes workflows straight into the
 * database, so these checks keep it valid against the app's own workflow
 * validators and keep the spec's expectations in step with what the
 * fixture's CRM step writes.
 */

describe("booking-workflow fixture definition", () => {
  it.each(BOOKING_TRIGGERS)(
    "%s: trigger and steps pass the app's workflow validators",
    (trigger) => {
      expect(triggerSchema.safeParse({ type: trigger }).success).toBe(true);
      for (const step of workflowSteps(trigger)) {
        expect(stepSchema.safeParse(step).success).toBe(true);
      }
    },
  );

  it.each(BOOKING_TRIGGERS)(
    "%s: the only step is an internal CRM note on trigger.contactId",
    (trigger) => {
      const steps = workflowSteps(trigger) as Array<{ type: string; contactIdVar?: string }>;
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        type: "crm.create_activity",
        contactIdVar: "trigger.contactId",
      });
    },
  );

  it.each(BOOKING_TRIGGERS)("%s: the step's subject renders to activitySubject()", (trigger) => {
    const step = workflowSteps(trigger)[0] as { subject: string };
    const rendered = step.subject.replace("{{trigger.bookingId}}", "booking-123");
    expect(rendered).toBe(activitySubject(trigger, "booking-123"));
  });

  it("workflow names are unique per trigger, so re-running updates instead of duplicating", () => {
    const names = BOOKING_TRIGGERS.map(workflowName);
    expect(new Set(names).size).toBe(names.length);
  });

  it("two distinct fixture organizations", () => {
    expect(FIXTURE_ORGS).toHaveLength(2);
    expect(new Set(FIXTURE_ORGS.map((o) => o.slug)).size).toBe(2);
  });

  it("the payload keys the spec expects never include free-form guest notes", () => {
    for (const keys of Object.values(TRIGGER_PAYLOAD_KEYS)) {
      expect(keys).not.toContain("notes");
      expect(keys).not.toContain("guestNotes");
      expect(keys).toContain("contactId");
    }
  });

  it("the schedule is open all day, every day", () => {
    expect(ALWAYS_OPEN_RULES.map((r) => r.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const rule of ALWAYS_OPEN_RULES)
      expect([rule.startMinute, rule.endMinute]).toEqual([0, 1440]);
  });
});

describe("fixture addresses", () => {
  it("sub-addresses the E2E mailbox", () => {
    expect(subAddress("qa@example.test", "x")).toBe("qa+x@example.test");
    expect(ownerEmail("qa@example.test", "a")).toBe("qa+booking-owner-a@example.test");
    expect(ownerEmail("qa@example.test", "b")).toBe("qa+booking-owner-b@example.test");
  });

  it.each(["", "no-at-sign", "@example.test", "qa@"])("rejects %j", (email) => {
    expect(() => subAddress(email, "x")).toThrow();
  });
});

describe("pickJourneySlots", () => {
  it("takes the first slot and one at least a day later", () => {
    expect(
      pickJourneySlots([
        "2026-11-03T10:00:00.000Z",
        "2026-11-02T09:00:00.000Z",
        "2026-11-02T09:30:00.000Z",
        "2026-11-03T09:00:00.000Z",
      ]),
    ).toEqual({ first: "2026-11-02T09:00:00.000Z", later: "2026-11-03T09:00:00.000Z" });
  });

  it("fails clearly without slots or without a later day", () => {
    expect(() => pickJourneySlots([])).toThrow("no bookable slots");
    expect(() =>
      pickJourneySlots(["2026-11-02T09:00:00.000Z", "2026-11-02T12:00:00.000Z"]),
    ).toThrow("no reschedule slot");
  });
});
