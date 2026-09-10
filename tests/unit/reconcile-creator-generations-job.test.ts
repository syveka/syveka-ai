import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(async (request: Request): Promise<string | null> => request.text()),
  reconcileCreatorGenerations: vi.fn(async (..._args: unknown[]) => ({
    staleGeneratingChecked: 0,
    resumedRunning: 0,
    recoveredCompleted: 0,
    recoveredFailed: 0,
    manualReviewFlagged: 0,
    settlementChecked: 0,
    settlementRepaired: 0,
    nextGeneratingCursor: null as string | null,
    nextSettlementCursor: null as string | null,
  })),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
vi.mock("@/server/services/creator-generation-recovery", () => ({
  reconcileCreatorGenerations: mocks.reconcileCreatorGenerations,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));

import { POST } from "@/app/api/v1/jobs/reconcile-creator-generations/route";

function jobRequest(body: string = "{}") {
  return new Request("http://localhost/api/v1/jobs/reconcile-creator-generations", {
    method: "POST",
    headers: { "upstash-signature": "sig" },
    body,
  });
}

const CURSOR_A = "00000000-0000-4000-8000-000000000001";
const CURSOR_B = "00000000-0000-4000-8000-000000000002";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyJobRequest.mockImplementation(async (request: Request) => request.text());
  mocks.reconcileCreatorGenerations.mockResolvedValue({
    staleGeneratingChecked: 0,
    resumedRunning: 0,
    recoveredCompleted: 0,
    recoveredFailed: 0,
    manualReviewFlagged: 0,
    settlementChecked: 0,
    settlementRepaired: 0,
    nextGeneratingCursor: null,
    nextSettlementCursor: null,
  });
  mocks.enqueue.mockResolvedValue(undefined);
});

describe("reconcile-creator-generations job: signature and payload", () => {
  it("returns 401 for an invalid QStash signature, and never invokes the reconciler", async () => {
    mocks.verifyJobRequest.mockResolvedValue(null);
    const response = await POST(jobRequest());
    expect(response.status).toBe(401);
    expect(mocks.reconcileCreatorGenerations).not.toHaveBeenCalled();
  });

  it("a validly signed empty request invokes the reconciler and returns its result as 200 JSON", async () => {
    const response = await POST(jobRequest("{}"));
    expect(response.status).toBe(200);
    expect(mocks.reconcileCreatorGenerations).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileCreatorGenerations).toHaveBeenCalledWith({
      generatingCursor: undefined,
      settlementCursor: undefined,
    });
    const body = await response.json();
    expect(body.staleGeneratingChecked).toBe(0);
  });

  it("malformed signed JSON returns 400 without invoking the reconciler", async () => {
    const response = await POST(jobRequest("{not valid json"));
    expect(response.status).toBe(400);
    expect(mocks.reconcileCreatorGenerations).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized field (e.g. a client-supplied organizationId) rather than passing it through", async () => {
    const response = await POST(
      jobRequest(JSON.stringify({ organizationId: "00000000-0000-4000-8000-000000000099" })),
    );
    expect(response.status).toBe(400);
    expect(mocks.reconcileCreatorGenerations).not.toHaveBeenCalled();
  });

  it("passes only the two documented cursors through to the reconciler, unmodified", async () => {
    await POST(
      jobRequest(JSON.stringify({ generatingCursor: CURSOR_A, settlementCursor: CURSOR_B })),
    );
    expect(mocks.reconcileCreatorGenerations).toHaveBeenCalledWith({
      generatingCursor: CURSOR_A,
      settlementCursor: CURSOR_B,
    });
  });
});

describe("reconcile-creator-generations job: pagination follow-up", () => {
  it("enqueues exactly one follow-up job when the reconciler reports a next cursor", async () => {
    mocks.reconcileCreatorGenerations.mockResolvedValue({
      staleGeneratingChecked: 25,
      resumedRunning: 0,
      recoveredCompleted: 0,
      recoveredFailed: 0,
      manualReviewFlagged: 0,
      settlementChecked: 0,
      settlementRepaired: 0,
      nextGeneratingCursor: CURSOR_A,
      nextSettlementCursor: null,
    });
    const response = await POST(jobRequest());
    expect(response.status).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "reconcile-creator-generations",
      { generatingCursor: CURSOR_A },
      { deduplicationId: `reconcile-creator-generations-${CURSOR_A}-x` },
    );
  });

  it("enqueues nothing when the reconciler reports no next cursor in either scan", async () => {
    const response = await POST(jobRequest());
    expect(response.status).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("returns 500 (never a false success) when publishing the follow-up job fails", async () => {
    mocks.reconcileCreatorGenerations.mockResolvedValue({
      staleGeneratingChecked: 25,
      resumedRunning: 0,
      recoveredCompleted: 0,
      recoveredFailed: 0,
      manualReviewFlagged: 0,
      settlementChecked: 0,
      settlementRepaired: 0,
      nextGeneratingCursor: CURSOR_A,
      nextSettlementCursor: null,
    });
    mocks.enqueue.mockRejectedValueOnce(new Error("qstash unavailable"));
    const response = await POST(jobRequest());
    expect(response.status).toBe(500);
  });
});

describe("reconcile-creator-generations job: reconciler failure handling", () => {
  it("propagates a reconciler failure rather than swallowing it into a false 200", async () => {
    mocks.reconcileCreatorGenerations.mockRejectedValue(new Error("database unavailable"));
    await expect(POST(jobRequest())).rejects.toThrow("database unavailable");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
