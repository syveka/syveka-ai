import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/tenant", () => ({ tenantDb: vi.fn() }));

const {
  deriveRecordingSyncState,
  recordingStatusKind,
  RECORDING_SYNC_APPLIED: APPLIED,
  RECORDING_SYNC_FAILED: FAILED,
  RECORDING_SYNC_STARTED: STARTED,
} = await import("@/server/voice/recording-sync");

/** Seconds on a fixed clock, so each order of events is stated exactly. */
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 6, 12, 0, seconds));
const NOW = at(50);

const started = (attempt: string, recordingEnabled: boolean, seconds: number) => ({
  action: STARTED,
  createdAt: at(seconds),
  after: { attempt, recordingEnabled },
});
const applied = (attempt: string, seconds: number) => ({
  action: APPLIED,
  createdAt: at(seconds),
  after: { attempt },
});
const failed = (attempt: string, seconds: number) => ({
  action: FAILED,
  createdAt: at(seconds),
  after: { attempt },
});

describe("what the record says Vapi accepted", () => {
  it("says applied once the attempt for the setting asked for is accepted", () => {
    const state = deriveRecordingSyncState([started("a", false, 0), applied("a", 1)], false, NOW);
    expect(state).toEqual({
      status: "applied",
      lastAccepted: { enabled: false, at: at(1) },
    });
  });

  it("keeps saying failed on a later read, with what Vapi last accepted", () => {
    const events = [
      started("old", true, 0),
      applied("old", 1),
      started("new", false, 10),
      failed("new", 11),
    ];
    // Worked out only from the stored rows, so it's the same after a reload or in a new session.
    const first = deriveRecordingSyncState(events, false, NOW);
    const later = deriveRecordingSyncState(events, false, new Date(NOW.getTime() + 86_400_000));
    expect(first).toEqual({ status: "failed", lastAccepted: { enabled: true, at: at(1) } });
    expect(later).toEqual(first);
  });

  it("recovers when a retry succeeds", () => {
    const state = deriveRecordingSyncState(
      [started("a", false, 0), failed("a", 1), started("retry", false, 20), applied("retry", 21)],
      false,
      NOW,
    );
    expect(state.status).toBe("applied");
    expect(state.lastAccepted).toEqual({ enabled: false, at: at(21) });
  });

  it("stays failed when the retry fails too", () => {
    const state = deriveRecordingSyncState(
      [started("a", false, 0), failed("a", 1), started("retry", false, 20), failed("retry", 21)],
      false,
      NOW,
    );
    expect(state).toEqual({ status: "failed", lastAccepted: null });
  });

  it("is pending while the attempt could still be running, then uncertain", () => {
    const events = [started("a", false, 40)];
    expect(deriveRecordingSyncState(events, false, NOW).status).toBe("pending");
    const much = new Date(at(40).getTime() + 61_000);
    expect(deriveRecordingSyncState(events, false, much).status).toBe("uncertain");
  });

  it("is uncertain with no attempt on record", () => {
    expect(deriveRecordingSyncState([], false, NOW)).toEqual({
      status: "uncertain",
      lastAccepted: null,
    });
  });

  it("is uncertain when the setting changed with no attempt to send it, as after a crash", () => {
    const state = deriveRecordingSyncState([started("a", true, 0), applied("a", 1)], false, NOW);
    expect(state.status).toBe("uncertain");
  });
});

describe("two updates at once", () => {
  it("an older attempt finishing late can't confirm the newer setting", () => {
    // New accepted first, then the old one comes back: Vapi may have applied them in that order.
    const state = deriveRecordingSyncState(
      [started("old", true, 0), started("new", false, 1), applied("new", 2), applied("old", 3)],
      false,
      NOW,
    );
    expect(state.status).toBe("uncertain");
  });

  it("is uncertain whichever order the results arrive in", () => {
    const state = deriveRecordingSyncState(
      [started("old", true, 0), started("new", false, 1), applied("old", 2), applied("new", 3)],
      false,
      NOW,
    );
    expect(state.status).toBe("uncertain");
  });

  it("an older attempt that failed by timeout may still have reached Vapi", () => {
    const state = deriveRecordingSyncState(
      [started("old", true, 0), started("new", false, 1), applied("new", 2), failed("old", 21)],
      false,
      NOW,
    );
    expect(state.status).toBe("uncertain");
  });

  it("an older attempt with no result could still land if it began within the last minute", () => {
    const state = deriveRecordingSyncState(
      [started("old", true, 0), started("new", false, 30), applied("new", 31)],
      false,
      NOW,
    );
    expect(state.status).toBe("uncertain");
  });

  it("an older attempt that was long dead can't land", () => {
    const state = deriveRecordingSyncState(
      [
        { ...started("old", true, 0), createdAt: new Date(at(0).getTime() - 120_000) },
        started("new", false, 30),
        applied("new", 31),
      ],
      false,
      NOW,
    );
    expect(state.status).toBe("applied");
  });

  it("attempts with the same setting can't disagree about recording", () => {
    // A save and a Business DNA resync often overlap.
    const state = deriveRecordingSyncState(
      [
        started("resync", false, 0),
        started("save", false, 1),
        applied("save", 2),
        applied("resync", 3),
      ],
      false,
      NOW,
    );
    expect(state.status).toBe("applied");
  });

  it("finished before the newer one began, it can't have overwritten it", () => {
    const state = deriveRecordingSyncState(
      [started("old", true, 0), applied("old", 1), started("new", false, 10), applied("new", 11)],
      false,
      NOW,
    );
    expect(state.status).toBe("applied");
  });

  it("treats results too close to call across servers' clocks as overlapping", () => {
    const state = deriveRecordingSyncState(
      [started("old", true, 0), applied("old", 9), started("new", false, 10), applied("new", 11)],
      false,
      NOW,
    );
    expect(state.status).toBe("uncertain");
  });
});

describe("rows that aren't attempts", () => {
  it("ignores a failed sync with no attempt, from an assistant that sent no setting", () => {
    const state = deriveRecordingSyncState(
      [started("a", false, 0), applied("a", 1), { action: FAILED, createdAt: at(2), after: {} }],
      false,
      NOW,
    );
    expect(state.status).toBe("applied");
  });

  it("ignores a result for an attempt it has no start for, and unreadable rows", () => {
    const state = deriveRecordingSyncState(
      [
        applied("unknown", 1),
        { action: STARTED, createdAt: at(2), after: null },
        { action: STARTED, createdAt: at(3), after: { attempt: "x", recordingEnabled: "off" } },
      ],
      false,
      NOW,
    );
    expect(state).toEqual({ status: "uncertain", lastAccepted: null });
  });
});

describe("what the settings page shows", () => {
  const sync = (status: "applied" | "failed" | "uncertain" | "pending") => ({
    status,
    lastAccepted: null,
  });
  const kind = (over: Partial<Parameters<typeof recordingStatusKind>[0]>) =>
    recordingStatusKind({
      requested: false,
      inVapi: true,
      sync: sync("applied"),
      reportedByVapi: null,
      ...over,
    });

  it("doesn't take a local save as proof", () => {
    // Saved as off, and nothing says Vapi took it.
    expect(kind({ sync: sync("uncertain") })).toBe("uncertain");
    expect(kind({ sync: sync("failed") })).toBe("failed");
    expect(kind({ sync: null })).toBe("unreadable");
  });

  it("shows an assistant never set here as needing review", () => {
    expect(kind({ requested: null, sync: null })).toBe("needsReview");
    expect(kind({ requested: null, sync: null, reportedByVapi: true })).toBe("needsReview");
  });

  it("has nothing to say about an assistant not at Vapi", () => {
    expect(kind({ inVapi: false, sync: null })).toBe("notConnected");
  });

  it("lets a differing value from Vapi override a record that says accepted", () => {
    expect(kind({ reportedByVapi: true })).toBe("mismatch");
    expect(kind({ reportedByVapi: false })).toBe("applied");
  });

  it("doesn't call a send still running a mismatch", () => {
    expect(kind({ sync: sync("pending"), reportedByVapi: true })).toBe("pending");
  });

  it("says nothing more when Vapi's read leaves the value out", () => {
    expect(kind({ sync: sync("failed"), reportedByVapi: null })).toBe("failed");
  });
});
