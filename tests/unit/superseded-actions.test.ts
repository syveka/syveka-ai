import { describe, expect, it } from "vitest";
import { supersededActions } from "@/lib/chat/superseded-actions";
import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";

/**
 * Which earlier Business DNA proposals a newer one in the conversation
 * replaces: the user corrected a fact, so the older card about the same
 * field must not stay confirmable. (The thread and card interaction is in
 * chat-thread-supersession.test.tsx.)
 */
const NOW = 1_800_000_000_000;

function dna(
  id: string,
  fields: string[],
  o: Partial<ProposedActionView & { restored?: RestoredActionState }> = {},
): ProposedActionView & { restored?: RestoredActionState } {
  return {
    id,
    tool: "proposeBusinessDnaUpdate",
    digest: "a".repeat(64),
    conversationId: "c",
    expiresAt: NOW + 600_000,
    details: {
      tool: "proposeBusinessDnaUpdate",
      missingAfter: [],
      changes: fields.map((field) => ({
        field: field as never,
        kind: "modified",
        before: null,
        after: { type: "text", value: "x" },
      })),
    },
    ...o,
  };
}

const booking = (id: string): ProposedActionView => ({
  id,
  tool: "bookMeeting",
  digest: "b".repeat(64),
  conversationId: "c",
  expiresAt: NOW + 600_000,
  details: {
    tool: "bookMeeting",
    title: "Demo",
    startsAt: "2026-11-02T09:00:00.000Z",
    durationMinutes: 30,
    timezone: "Europe/Helsinki",
  },
});

const ids = (m: Map<string, unknown>) => [...m.keys()].sort();

describe("supersededActions", () => {
  it("a correction (a later proposal about the same field) supersedes the earlier one", () => {
    const m = supersededActions(
      [dna("hours-17", ["openingHours"]), dna("hours-16", ["openingHours"])],
      NOW,
    );
    expect(ids(m)).toEqual(["hours-17"]);
    expect(m.get("hours-17")).toEqual({ notCarriedOver: [] });
  });

  it("proposals about different fields stay independent", () => {
    const m = supersededActions(
      [dna("hours", ["openingHours"]), dna("languages", ["supportedLocales"])],
      NOW,
    );
    expect(m.size).toBe(0);
  });

  it("one shared field is enough; the newest of a chain is never superseded", () => {
    const m = supersededActions(
      [
        dna("a", ["industry", "description"]),
        dna("b", ["description", "keyFacts"]),
        dna("c", ["keyFacts"]),
      ],
      NOW,
    );
    expect(ids(m)).toEqual(["a", "b"]);
  });

  it("a partial correction names the earlier fields it doesn't carry over", () => {
    // A proposes hours and languages; B corrects only the hours.
    const m = supersededActions(
      [dna("a", ["openingHours", "supportedLocales"]), dna("b", ["openingHours"])],
      NOW,
    );
    expect(m.get("a")).toEqual({ notCarriedOver: ["supportedLocales"] });
    // Covered across several later proposals: nothing is left out.
    const m2 = supersededActions(
      [
        dna("a", ["openingHours", "supportedLocales"]),
        dna("b", ["openingHours"]),
        dna("c", ["supportedLocales"]),
      ],
      NOW,
    );
    expect(m2.get("a")).toEqual({ notCarriedOver: [] });
    expect(m2.has("b")).toBe(false);
    expect(m2.has("c")).toBe(false);
  });

  it("an earlier proposal already decided, or expired, is left as it is; a decided newer one supersedes nothing", () => {
    expect(
      supersededActions(
        [dna("done", ["openingHours"], { restored: "done" }), dna("new", ["openingHours"])],
        NOW,
      ).size,
    ).toBe(0);
    expect(
      supersededActions(
        [dna("old", ["openingHours"]), dna("canceled", ["openingHours"], { restored: "canceled" })],
        NOW,
      ).size,
    ).toBe(0);
    expect(
      supersededActions(
        [dna("old", ["openingHours"]), dna("expired", ["openingHours"], { expiresAt: NOW - 1 })],
        NOW,
      ).size,
    ).toBe(0);
    expect(
      supersededActions(
        [dna("expired", ["openingHours"], { expiresAt: NOW - 1 }), dna("new", ["openingHours"])],
        NOW,
      ).size,
    ).toBe(0);
  });

  it("an applied newer proposal keeps the earlier one replaced", () => {
    expect(
      ids(
        supersededActions(
          [dna("old", ["openingHours"]), dna("applied", ["openingHours"], { restored: "done" })],
          NOW,
        ),
      ),
    ).toEqual(["old"]);
  });

  it("decisions made in this view count like restored ones: cancel the correction and the earlier one is offered again; apply it and the earlier one stays replaced", () => {
    const thread = [dna("hours-17", ["openingHours"]), dna("hours-16", ["openingHours"])];
    expect(ids(supersededActions(thread, NOW, new Map()))).toEqual(["hours-17"]);
    expect(supersededActions(thread, NOW, new Map([["hours-16", "canceled"]])).size).toBe(0);
    expect(supersededActions(thread, NOW, new Map([["hours-16", "failed"]])).size).toBe(0);
    expect(supersededActions(thread, NOW, new Map([["hours-16", "unknown"]])).size).toBe(0);
    expect(ids(supersededActions(thread, NOW, new Map([["hours-16", "done"]])))).toEqual([
      "hours-17",
    ]);
    // The earlier one decided here (before the correction arrived): left as it is.
    expect(supersededActions(thread, NOW, new Map([["hours-17", "done"]])).size).toBe(0);
  });

  it("other tools' proposals are never superseded and supersede nothing", () => {
    const m = supersededActions(
      [booking("meeting-1"), dna("hours", ["openingHours"]), booking("meeting-2")],
      NOW,
    );
    expect(m.size).toBe(0);
  });
});
