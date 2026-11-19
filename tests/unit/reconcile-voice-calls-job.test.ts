import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(async (request: Request): Promise<string | null> => request.text()),
  reconcileVoiceCalls: vi.fn(),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
  getVapiEnv: vi.fn(() => ({})),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
vi.mock("@/server/voice/reconcile-calls", () => ({
  reconcileVoiceCalls: mocks.reconcileVoiceCalls,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));
vi.mock("@/env", () => ({ getVapiEnv: mocks.getVapiEnv }));

import { POST } from "@/app/api/v1/jobs/reconcile-voice-calls/route";

const CURSOR = "00000000-0000-4000-8000-000000000001";
const OTHER_CURSOR = "00000000-0000-4000-8000-000000000002";
const BEFORE_FIRST_ID = "00000000-0000-0000-0000-000000000000";

function deliver(body: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/v1/jobs/reconcile-voice-calls", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify(body),
    }),
  );
}

function reconcileReturns(nextCallCursor: string | null, nextAssistantCursor: string | null) {
  mocks.reconcileVoiceCalls.mockResolvedValue({
    checked: 0,
    settled: 0,
    requeued: 0,
    discovered: 0,
    unresolved: 0,
    nextCallCursor,
    nextAssistantCursor,
  });
}

function publishedId(call: number): string {
  const opts = mocks.enqueue.mock.calls[call]?.[2] as { deduplicationId: string };
  return opts.deduplicationId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyJobRequest.mockImplementation(async (request: Request) => request.text());
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.getVapiEnv.mockReturnValue({});
  reconcileReturns(null, null);
});

describe("reconcile-voice-calls job", () => {
  it("refuses a bad signature without reconciling", async () => {
    mocks.verifyJobRequest.mockResolvedValue(null);
    const response = await deliver({});
    expect(response.status).toBe(401);
    expect(mocks.reconcileVoiceCalls).not.toHaveBeenCalled();
  });

  it.each([[{ hop: -1 }], [{ hop: 1.5 }], [{ hop: "1" }], [{ other: true }]])(
    "refuses the payload %j",
    async (body) => {
      const response = await deliver(body);
      expect(response.status).toBe(400);
      expect(mocks.reconcileVoiceCalls).not.toHaveBeenCalled();
    },
  );

  it("publishes nothing when no page is left", async () => {
    const response = await deliver({});
    expect(response.status).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("doesn't hand the hop to the reconciler", async () => {
    await deliver({ callsDone: true, assistantCursor: CURSOR, hop: 2 });
    expect(mocks.reconcileVoiceCalls).toHaveBeenCalledWith({
      callsDone: true,
      assistantCursor: CURSOR,
    });
  });

  describe("a delivery that resumes from the cursor it was given", () => {
    // QStash drops a repeated deduplication id for 10 minutes, so an equal id would end the chain.
    it("publishes an id different from the one that triggered it", async () => {
      reconcileReturns(null, CURSOR);
      await deliver({ callsDone: true, assistantCursor: CURSOR });
      const triggeredBy = publishedId(0);
      const payload = mocks.enqueue.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload).toEqual({ callsDone: true, assistantCursor: CURSOR, hop: 1 });

      await deliver(payload);
      expect(publishedId(1)).not.toBe(triggeredBy);
      expect(mocks.enqueue.mock.calls[1]?.[1]).toEqual({ ...payload, hop: 2 });
    });

    it("keeps the same id when QStash retries one delivery, so the chain doesn't fork", async () => {
      reconcileReturns(null, CURSOR);
      const delivery = { callsDone: true, assistantCursor: CURSOR, hop: 3 };
      await deliver(delivery);
      await deliver(delivery);
      expect(publishedId(1)).toBe(publishedId(0));
    });
  });

  it("gives different pages different ids at the same hop", async () => {
    reconcileReturns(null, CURSOR);
    await deliver({ callsDone: true, assistantCursor: CURSOR, hop: 1 });
    reconcileReturns(null, OTHER_CURSOR);
    await deliver({ callsDone: true, assistantCursor: CURSOR, hop: 1 });
    expect(publishedId(1)).not.toBe(publishedId(0));
  });

  it("accepts the cursor that means starting from the first assistant", async () => {
    const response = await deliver({ callsDone: true, assistantCursor: BEFORE_FIRST_ID });
    expect(response.status).toBe(200);
    expect(mocks.reconcileVoiceCalls).toHaveBeenCalledTimes(1);
  });

  it("asks QStash to retry when the follow-up can't be published", async () => {
    reconcileReturns(CURSOR, null);
    mocks.enqueue.mockRejectedValue(new Error("qstash down"));
    const response = await deliver({});
    expect(response.status).toBe(500);
  });
});
