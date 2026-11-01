import { describe, expect, it } from "vitest";
import { supersededActionIds } from "@/lib/chat/superseded-actions";
import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";

/**
 * Which earlier Business DNA proposals a newer one in the conversation
 * replaces: the user corrected a fact, so the older card about the same
 * field must not stay confirmable.
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

describe("supersededActionIds", () => {
  it("a correction (a later proposal about the same field) supersedes the earlier one", () => {
    const ids = supersededActionIds(
      [dna("hours-17", ["openingHours"]), dna("hours-16", ["openingHours"])],
      NOW,
    );
    expect([...ids]).toEqual(["hours-17"]);
  });

  it("proposals about different fields stay independent", () => {
    const ids = supersededActionIds(
      [dna("hours", ["openingHours"]), dna("languages", ["supportedLocales"])],
      NOW,
    );
    expect(ids.size).toBe(0);
  });

  it("one shared field is enough; the newest of a chain is never superseded", () => {
    const ids = supersededActionIds(
      [
        dna("a", ["industry", "description"]),
        dna("b", ["description", "keyFacts"]),
        dna("c", ["keyFacts"]),
      ],
      NOW,
    );
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("an earlier proposal already decided, or expired, is left as it is; a decided newer one supersedes nothing", () => {
    expect(
      supersededActionIds(
        [dna("done", ["openingHours"], { restored: "done" }), dna("new", ["openingHours"])],
        NOW,
      ).size,
    ).toBe(0);
    expect(
      supersededActionIds(
        [dna("old", ["openingHours"]), dna("canceled", ["openingHours"], { restored: "canceled" })],
        NOW,
      ).size,
    ).toBe(0);
    expect(
      supersededActionIds(
        [dna("old", ["openingHours"]), dna("expired", ["openingHours"], { expiresAt: NOW - 1 })],
        NOW,
      ).size,
    ).toBe(0);
  });

  it("decisions made in this view count like restored ones: cancel the correction and the earlier one is offered again; apply it and the earlier one stays replaced", () => {
    const thread = [dna("hours-17", ["openingHours"]), dna("hours-16", ["openingHours"])];
    expect([...supersededActionIds(thread, NOW, new Map())]).toEqual(["hours-17"]);
    expect(supersededActionIds(thread, NOW, new Map([["hours-16", "canceled"]])).size).toBe(0);
    expect(supersededActionIds(thread, NOW, new Map([["hours-16", "failed"]])).size).toBe(0);
    expect([...supersededActionIds(thread, NOW, new Map([["hours-16", "done"]]))]).toEqual([
      "hours-17",
    ]);
    // Once the earlier one is decided (e.g. restored after a reload), nothing is superseded.
    expect(supersededActionIds(thread, NOW, new Map([["hours-17", "superseded"]])).size).toBe(0);
  });

  it("other tools' proposals are never superseded and supersede nothing", () => {
    const ids = supersededActionIds(
      [booking("meeting-1"), dna("hours", ["openingHours"]), booking("meeting-2")],
      NOW,
    );
    expect(ids.size).toBe(0);
  });
});
