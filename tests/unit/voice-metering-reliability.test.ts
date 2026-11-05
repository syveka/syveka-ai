import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  billableMinutes,
  callOutcomeFields,
  resolveCallDurationSeconds,
} from "@/server/voice/call-outcome";

/**
 * Metering when webhooks are lost, late, repeated or wrong. Synthetic data; the database is
 * an in-memory fake, and Vapi and the job queue are mocked, so no paid or real call is made.
 * Concurrent charging is proven separately on real PostgreSQL (post-call-concurrency).
 */
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-20T12:00:00Z");
const MINUTES_AGO = (m: number) => new Date(NOW.getTime() - m * 60_000);

type Row = {
  id: string;
  organizationId: string;
  vapiCallId: string;
  assistantId: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number | null;
  postCallProcessedAt: Date | null;
  status?: string;
  assistant?: { vapiAssistantId: string | null };
};

const m = vi.hoisted(() => ({
  rows: [] as Row[],
  assistants: [] as Array<{ id: string; organizationId: string; vapiAssistantId: string }>,
  getMonthUsage: vi.fn(async () => 0),
  getVapiCall: vi.fn(),
  listVapiCalls: vi.fn(async () => [] as unknown[]),
  enqueue: vi.fn(async () => undefined),
  updateMany: vi.fn(),
  markCallRefused: vi.fn(async () => undefined),
  confirmNotice: vi.fn(async (..._args: unknown[]) => "absent"),
}));

function matchesKnownCallQuery(row: Row, where: Record<string, never>): boolean {
  const w = where as unknown as {
    startedAt?: { gte?: Date };
    id?: { gt: string };
    OR?: Array<Record<string, { lt?: Date; not?: null } | null>>;
  };
  if (row.postCallProcessedAt !== null) return false;
  if (w.startedAt?.gte && row.startedAt < w.startedAt.gte) return false;
  if (w.id && row.id <= w.id.gt) return false;
  return (w.OR ?? []).some((branch) =>
    Object.entries(branch).every(([field, test]) => {
      const value = row[field as keyof Row] as Date | number | null;
      if (test === null) return value === null;
      if (test.not === null) return value !== null;
      return value !== null && test.lt !== undefined && value < test.lt;
    }),
  );
}

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    voiceCall: {
      findMany: vi.fn(async ({ where }: { where: Record<string, never> }) => {
        const w = where as unknown as {
          organizationId?: string;
          vapiCallId?: { not?: string; in?: string[] };
          OR?: unknown;
          startedAt?: { gte?: Date };
        };
        if (w.vapiCallId?.in) {
          return m.rows.filter((r) => w.vapiCallId!.in!.includes(r.vapiCallId));
        }
        if (w.OR) return m.rows.filter((r) => matchesKnownCallQuery(r, where));
        return m.rows.filter(
          (r) =>
            r.organizationId === w.organizationId &&
            r.postCallProcessedAt === null &&
            r.vapiCallId !== w.vapiCallId?.not &&
            (!w.startedAt?.gte || r.startedAt >= w.startedAt.gte),
        );
      }),
      updateMany: m.updateMany,
      upsert: vi.fn(async ({ create }: { create: Row }) => {
        m.rows.push({ ...create, id: `row-${m.rows.length}`, postCallProcessedAt: null });
        return { id: "new" };
      }),
    },
    voiceAssistant: {
      findMany: vi.fn(async () => m.assistants),
      findFirst: vi.fn(async ({ where }: { where: { vapiAssistantId: string } }) =>
        where.vapiAssistantId === "vapi-assistant-of-org-b" ? { organizationId: ORG_B } : null,
      ),
    },
  },
}));
vi.mock("@/server/integrations/vapi", () => {
  class VapiHttpError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
    }
  }
  return { VapiHttpError, getVapiCall: m.getVapiCall, listVapiCalls: m.listVapiCalls };
});
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));
vi.mock("@/server/voice/disclosure-gate", () => ({
  callDisclosureState: async (_org: string, id: string) =>
    id === "unconfirmed-call" ? "unverified" : id === "unreadable-notice" ? "unknown" : "verified",
  confirmNoticeFromCallRecord: m.confirmNotice,
}));
vi.mock("@/server/voice/call-admission", () => ({
  markCallRefused: m.markCallRefused,
  callRefusal: async (_org: string, id: string) =>
    id === "refused-call"
      ? "ended"
      : id === "running-refused-call"
        ? "running"
        : id === "unreadable-refusal"
          ? "unknown"
          : id === "notice-refused-call"
            ? "notice"
            : null,
}));
vi.mock("@/server/services/billing/entitlements", () => ({ getMonthUsage: m.getMonthUsage }));

const { VapiHttpError } = (await import("@/server/integrations/vapi")) as unknown as {
  VapiHttpError: new (message: string, status: number) => Error;
};
const { reconcileVoiceCalls, RECONCILE_CALL_BATCH } =
  await import("@/server/voice/reconcile-calls");
const { getVoiceUsageState, minutesCountedForLimits, remainingVoiceMinutes } =
  await import("@/server/services/billing/voice-usage");

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    organizationId: ORG_A,
    vapiCallId: "vapi-1",
    assistantId: "assistant-a",
    startedAt: MINUTES_AGO(60),
    endedAt: null,
    durationSeconds: null,
    postCallProcessedAt: null,
    assistant: { vapiAssistantId: "vapi-assistant-a" },
    ...overrides,
  };
}

const ENDED = {
  id: "vapi-1",
  assistantId: "vapi-assistant-a",
  status: "ended",
  startedAt: MINUTES_AGO(60).toISOString(),
  endedAt: MINUTES_AGO(57).toISOString(),
  endedReason: "customer-ended-call",
  cost: 0.27,
};

beforeEach(() => {
  m.rows = [];
  m.assistants = [];
  vi.clearAllMocks();
  m.getMonthUsage.mockResolvedValue(0);
  m.listVapiCalls.mockResolvedValue([]);
  m.updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Partial<Row> }) => {
    const target = m.rows.find(
      (r) => r.id === where.id && r.organizationId === where.organizationId,
    );
    if (target && target.postCallProcessedAt === null && target.durationSeconds === null) {
      Object.assign(target, data);
      return { count: 1 };
    }
    return { count: 0 };
  });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("how long a call was", () => {
  it("prefers the documented times over the undocumented field", () => {
    expect(
      resolveCallDurationSeconds({
        startedAt: "2026-11-20T10:00:00Z",
        endedAt: "2026-11-20T10:03:00.500Z",
        durationSeconds: 1,
      }),
    ).toBe(181);
  });

  it("falls back to durationSeconds only without the times", () => {
    expect(resolveCallDurationSeconds({ durationSeconds: 42.2 })).toBe(43);
  });

  it.each([
    ["nothing at all", {}],
    ["only a start", { startedAt: "2026-11-20T10:00:00Z" }],
    [
      "an end before the start",
      { startedAt: "2026-11-20T10:05:00Z", endedAt: "2026-11-20T10:00:00Z" },
    ],
    ["garbage times", { startedAt: "soon", endedAt: "later" }],
    [
      "an impossible length",
      { startedAt: "2026-11-01T00:00:00Z", endedAt: "2026-11-20T00:00:00Z" },
    ],
    ["a negative duration", { durationSeconds: -5 }],
    ["an absurd duration", { durationSeconds: 1e12 }],
    ["an infinite duration", { durationSeconds: Number.POSITIVE_INFINITY }],
    ["bad times, with no fallback", { startedAt: "x", endedAt: "y", durationSeconds: null }],
  ])("is unknown given %s, never zero", (_name, times) => {
    expect(resolveCallDurationSeconds(times)).toBeNull();
  });

  it("rounds minutes up, and charges nothing for a call that never connected", () => {
    expect(billableMinutes(0)).toBe(0);
    expect(billableMinutes(1)).toBe(1);
    expect(billableMinutes(60)).toBe(1);
    expect(billableMinutes(61)).toBe(2);
  });

  it("maps a transfer, and stores cost in whole cents", () => {
    const fields = callOutcomeFields({
      endedReason: "assistant-forwarded-call",
      cost: 0.275,
      durationSeconds: 60,
      endedAt: NOW,
    });
    expect(fields.status).toBe("TRANSFERRED");
    expect(fields.costCents).toBe(28);
  });
});

describe("billable and uncertain usage stay separate", () => {
  it("counts recorded usage as billable and unsettled calls only as uncertain", async () => {
    m.getMonthUsage.mockResolvedValue(10);
    m.rows = [row({ durationSeconds: 125, endedAt: MINUTES_AGO(50) })];
    const state = await getVoiceUsageState(ORG_A, { now: NOW });
    expect(state).toEqual({
      billableMinutes: 10,
      uncertainCalls: 1,
      uncertainMinutes: 3,
      inFlightCalls: 0,
      inFlightMinutes: 0,
    });
  });

  it("assumes the longest length for a call with lost news", async () => {
    m.rows = [row({ startedAt: MINUTES_AGO(120) })];
    expect((await getVoiceUsageState(ORG_A, { now: NOW })).uncertainMinutes).toBe(15);
  });

  it("counts a report with no length as the longest, however recent", async () => {
    m.rows = [row({ startedAt: MINUTES_AGO(2), endedAt: MINUTES_AGO(1) })];
    expect((await getVoiceUsageState(ORG_A, { now: NOW })).uncertainMinutes).toBe(15);
  });

  it("counts a live call by its elapsed time, and leaves out the caller's own call", async () => {
    m.rows = [row({ startedAt: MINUTES_AGO(4) })];
    expect(await getVoiceUsageState(ORG_A, { now: NOW })).toMatchObject({
      uncertainMinutes: 0,
      inFlightCalls: 1,
      inFlightMinutes: 4,
    });
    const own = await getVoiceUsageState(ORG_A, { now: NOW, excludeVapiCallId: "vapi-1" });
    expect(own.inFlightMinutes).toBe(0);
  });

  it("ignores other organizations' calls", async () => {
    m.rows = [row({ organizationId: ORG_B })];
    expect((await getVoiceUsageState(ORG_A, { now: NOW })).uncertainCalls).toBe(0);
  });

  it("counts both for limits, and the remainder is never negative", async () => {
    const state = {
      billableMinutes: 90,
      uncertainCalls: 2,
      uncertainMinutes: 30,
      inFlightCalls: 1,
      inFlightMinutes: 5,
    };
    expect(minutesCountedForLimits(state)).toBe(125);
    expect(remainingVoiceMinutes(state, 100)).toBe(0);
    expect(remainingVoiceMinutes(state, 500)).toBe(375);
  });
});

describe("recovering lost webhooks", () => {
  it("settles a stale call from Vapi and requeues the one idempotent job", async () => {
    m.rows = [row()];
    m.getVapiCall.mockResolvedValue(ENDED);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.settled).toBe(1);
    expect(m.rows[0]).toMatchObject({ durationSeconds: 180, costCents: 27, status: "COMPLETED" });
    expect(m.enqueue).toHaveBeenCalledWith(
      "post-call",
      { vapiCallId: "vapi-1", orgId: ORG_A },
      expect.objectContaining({ deduplicationId: expect.stringContaining("voice-reconcile-") }),
    );
  });

  it("recovers a report that came with no length", async () => {
    m.rows = [row({ endedAt: MINUTES_AGO(40) })];
    m.getVapiCall.mockResolvedValue(ENDED);
    await reconcileVoiceCalls({ now: NOW });
    expect(m.rows[0]!.durationSeconds).toBe(180);
  });

  it("requeues a settled call whose job went missing, without asking Vapi", async () => {
    m.rows = [row({ endedAt: MINUTES_AGO(40), durationSeconds: 60 })];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.requeued).toBe(1);
    expect(m.getVapiCall).not.toHaveBeenCalled();
  });

  it("leaves a fresh call alone, because its report may still arrive", async () => {
    m.rows = [row({ startedAt: MINUTES_AGO(5) })];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.checked).toBe(0);
    expect(m.getVapiCall).not.toHaveBeenCalled();
  });

  it("marks a call Syveka never saw, which never connected, as zero seconds", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([{ ...ENDED, startedAt: null }]);
    await reconcileVoiceCalls({ now: NOW });
    expect(m.rows[0]!.durationSeconds).toBe(0);
  });

  it.each([
    ["Vapi is down", () => m.getVapiCall.mockRejectedValue(new Error("network"))],
    ["Vapi has no such call", () => m.getVapiCall.mockRejectedValue(new VapiHttpError("x", 404))],
    ["Vapi answers an error", () => m.getVapiCall.mockRejectedValue(new VapiHttpError("x", 500))],
    ["the answer is malformed", () => m.getVapiCall.mockResolvedValue({ nonsense: true })],
    [
      "the call is still running",
      () => m.getVapiCall.mockResolvedValue({ ...ENDED, status: "in-progress" }),
    ],
    [
      "the times are impossible",
      () => m.getVapiCall.mockResolvedValue({ ...ENDED, endedAt: "2020-01-01T00:00:00Z" }),
    ],
  ])("changes nothing and charges nothing when %s", async (_name, arrange) => {
    arrange();
    m.rows = [row()];
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.unresolved).toBe(1);
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
    expect(m.rows[0]!.durationSeconds).toBeNull();
  });

  it("one failing call doesn't stop the others", async () => {
    m.rows = [
      row({ id: "aaaaaaaa-0000-4000-8000-000000000001", vapiCallId: "broken" }),
      row({ id: "aaaaaaaa-0000-4000-8000-000000000002" }),
    ];
    m.getVapiCall.mockImplementation(async (id: string) => {
      if (id === "broken") throw new Error("network");
      return ENDED;
    });
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result).toMatchObject({ checked: 2, settled: 1, unresolved: 1 });
  });

  it("never applies a provider answer that belongs to another assistant", async () => {
    m.rows = [row()];
    m.getVapiCall.mockResolvedValue({ ...ENDED, assistantId: "vapi-assistant-of-org-b" });
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.unresolved).toBe(1);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("never applies a provider answer about a different call", async () => {
    m.rows = [row()];
    m.getVapiCall.mockResolvedValue({ ...ENDED, id: "another-call" });
    await reconcileVoiceCalls({ now: NOW });
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("scopes every write to the row's own organization, and keeps a report that won the race", async () => {
    m.rows = [row()];
    m.getVapiCall.mockImplementation(async () => {
      // A report arrives while the provider is being asked.
      m.rows[0]!.durationSeconds = 999;
      return ENDED;
    });
    await reconcileVoiceCalls({ now: NOW });
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_A,
          postCallProcessedAt: null,
          durationSeconds: null,
        }),
      }),
    );
    expect(m.rows[0]!.durationSeconds).toBe(999);
  });

  it("uses a dedupe key per organization, call and time bucket", async () => {
    m.rows = [row({ endedAt: MINUTES_AGO(40), durationSeconds: 60 })];
    await reconcileVoiceCalls({ now: NOW });
    await reconcileVoiceCalls({ now: new Date(NOW.getTime() + 60_000) });
    const keys = m.enqueue.mock.calls.map((c) => (c as unknown[])[2]);
    expect((keys[0] as { deduplicationId: string }).deduplicationId).toBe(
      (keys[1] as { deduplicationId: string }).deduplicationId,
    );
  });

  it("settles a call whose assistant has since been given a new id", async () => {
    m.rows = [row()];
    m.getVapiCall.mockResolvedValue({ ...ENDED, assistantId: "an-old-deleted-assistant" });
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.settled).toBe(1);
  });

  it("uses the row's own start when Vapi gives none, because the row proves it connected", async () => {
    m.rows = [row({ startedAt: MINUTES_AGO(60) })];
    m.getVapiCall.mockResolvedValue({ ...ENDED, startedAt: null });
    await reconcileVoiceCalls({ now: NOW });
    expect(m.rows[0]!.durationSeconds).toBe(180);
  });

  it("skips a scan already finished in this chain", async () => {
    m.rows = [row()];
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    await reconcileVoiceCalls({ now: NOW, callsDone: true });
    expect(m.getVapiCall).not.toHaveBeenCalled();
    expect(m.listVapiCalls).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    m.getVapiCall.mockResolvedValue(ENDED);
    await reconcileVoiceCalls({ now: NOW, assistantsDone: true });
    expect(m.getVapiCall).toHaveBeenCalledTimes(1);
    expect(m.listVapiCalls).not.toHaveBeenCalled();
  });

  it("stops at its time budget and continues from there, after at least one call", async () => {
    m.rows = [
      row({
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        vapiCallId: "v-1",
        endedAt: MINUTES_AGO(40),
        durationSeconds: 60,
      }),
      row({
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        vapiCallId: "v-2",
        endedAt: MINUTES_AGO(40),
        durationSeconds: 60,
      }),
    ];
    const result = await reconcileVoiceCalls({ now: NOW, deadlineMs: 0 });
    expect(result.checked).toBe(1);
    expect(result.nextCallCursor).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("gives a cursor when a page fills", async () => {
    m.rows = Array.from({ length: RECONCILE_CALL_BATCH }, (_, i) =>
      row({
        id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
        vapiCallId: `v-${i}`,
        endedAt: MINUTES_AGO(40),
        durationSeconds: 60,
      }),
    );
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.nextCallCursor).toBe(m.rows.at(-1)!.id);
  });

  it("finds a call Syveka never heard about, under its own organization", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([ENDED]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(1);
    expect(m.rows[0]).toMatchObject({ organizationId: ORG_A, vapiCallId: "vapi-1" });
    expect(m.enqueue).toHaveBeenCalledTimes(1);
  });

  it("ignores a listed call that belongs to another assistant, or isn't over", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([
      { ...ENDED, assistantId: "vapi-assistant-of-org-b" },
      { ...ENDED, id: "vapi-2", status: "in-progress" },
      { garbage: true },
    ]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.rows).toEqual([]);
  });

  it("doesn't recreate a known call", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.rows = [row({ startedAt: MINUTES_AGO(2) })];
    m.listVapiCalls.mockResolvedValue([ENDED]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.rows).toHaveLength(1);
  });

  it("doesn't bill a call Syveka itself refused", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([{ ...ENDED, id: "refused-call" }]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("leaves a call for the next run when its refusal can't be read", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([{ ...ENDED, id: "unreadable-refusal" }]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("does bill a refused call that couldn't be hung up, because it really ran", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([{ ...ENDED, id: "running-refused-call" }]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(1);
  });

  it("keeps nothing for a notice-refused call, even when the hang-up failed", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockResolvedValue([{ ...ENDED, id: "notice-refused-call" }]);
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.discovered).toBe(0);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("records a call its own record refuses, and leaves anything unsure for later", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    const messages = [{ role: "bot", message: "hello" }];
    m.listVapiCalls.mockResolvedValue([
      { ...ENDED, id: "unconfirmed-call", artifact: { messages } },
    ]);
    m.confirmNotice.mockResolvedValueOnce("contradicted");
    await reconcileVoiceCalls({ now: NOW });
    expect(m.confirmNotice).toHaveBeenCalledWith(expect.objectContaining({ messages }));
    expect(m.markCallRefused).toHaveBeenCalledWith(ORG_A, "unconfirmed-call", "notice");

    for (const outcome of ["unverifiable", "absent", "not_approved"]) {
      m.markCallRefused.mockClear();
      m.confirmNotice.mockResolvedValueOnce(outcome);
      const result = await reconcileVoiceCalls({ now: NOW });
      expect(result.unresolved).toBe(1);
      expect(m.markCallRefused).not.toHaveBeenCalled();
      expect(m.enqueue).not.toHaveBeenCalled();
    }
  });

  it.each(["unconfirmed-call", "unreadable-notice"])(
    "doesn't re-create a call the notice gate couldn't confirm: %s",
    async (id) => {
      m.assistants = [
        { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
      ];
      m.listVapiCalls.mockResolvedValue([{ ...ENDED, id }]);
      const result = await reconcileVoiceCalls({ now: NOW });
      expect(result.discovered).toBe(0);
      expect(m.rows).toEqual([]);
      expect(m.enqueue).not.toHaveBeenCalled();
    },
  );

  it("survives a failed listing", async () => {
    m.assistants = [
      { id: "assistant-a", organizationId: ORG_A, vapiAssistantId: "vapi-assistant-a" },
    ];
    m.listVapiCalls.mockRejectedValue(new Error("network"));
    const result = await reconcileVoiceCalls({ now: NOW });
    expect(result.unresolved).toBe(1);
  });
});
