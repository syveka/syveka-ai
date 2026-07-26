import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(
    async (request: Request): Promise<string | null> => request.text(),
  ),
  findMany: vi.fn(async (..._args: unknown[]) => [] as Array<{ id: string }>),
  ensureWebhookSubscription: vi.fn(
    async (_id: string): Promise<"reused" | "renewed" | "skipped"> => "renewed",
  ),
  syncExternalCalendar: vi.fn(async (..._args: unknown[]) => ({})),
  handleProviderWebhook: vi.fn(async (..._args: unknown[]) => false),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: mocks.verifyJobRequest }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { externalCalendar: { findMany: mocks.findMany } },
}));
vi.mock("@/server/services/calendar-sync", () => ({
  ensureWebhookSubscription: mocks.ensureWebhookSubscription,
  syncExternalCalendar: mocks.syncExternalCalendar,
  handleProviderWebhook: mocks.handleProviderWebhook,
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: mocks.enqueue }));

import { POST } from "@/app/api/v1/jobs/calendar-sync/route";

function jobRequest(body: string = "{}") {
  return new Request("http://localhost/api/v1/jobs/calendar-sync", {
    method: "POST",
    headers: { "upstash-signature": "sig" },
    body,
  });
}

function calendarIds(count: number, startAt = 0): Array<{ id: string }> {
  // Deterministic, sortable, 36-char UUID-shaped ids so `orderBy id asc` is stable.
  return Array.from({ length: count }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(startAt + i).padStart(12, "0")}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyJobRequest.mockImplementation(async (request: Request) => request.text());
  mocks.findMany.mockResolvedValue([]);
  mocks.ensureWebhookSubscription.mockResolvedValue("renewed");
});

describe("calendar-sync maintenance job: signature and payload", () => {
  it("returns 401 for an invalid QStash signature", async () => {
    mocks.verifyJobRequest.mockResolvedValue(null);
    const response = await POST(jobRequest());
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("an empty valid request processes the first batch", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(2));
    const response = await POST(jobRequest("{}"));
    expect(response.status).toBe(200);
    expect(mocks.ensureWebhookSubscription).toHaveBeenCalledTimes(2);
  });
});

describe("calendar-sync maintenance job: selection", () => {
  it("only selects syncEnabled calendars (enforced in the query, not re-checked here)", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(1));
    await POST(jobRequest());
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ syncEnabled: true }) }),
    );
  });

  it("calls ensureWebhookSubscription exactly once per selected calendar", async () => {
    const rows = calendarIds(3);
    mocks.findMany.mockResolvedValue(rows);
    await POST(jobRequest());
    expect(mocks.ensureWebhookSubscription).toHaveBeenCalledTimes(3);
    for (const row of rows) {
      expect(mocks.ensureWebhookSubscription).toHaveBeenCalledWith(row.id);
    }
  });

  it("never calls an event-synchronization function", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(2));
    await POST(jobRequest());
    expect(mocks.syncExternalCalendar).not.toHaveBeenCalled();
    expect(mocks.handleProviderWebhook).not.toHaveBeenCalled();
  });
});

describe("calendar-sync maintenance job: partial failure isolation", () => {
  it("a failing calendar does not prevent the others in the same batch from being processed", async () => {
    const rows = calendarIds(3);
    mocks.findMany.mockResolvedValue(rows);
    mocks.ensureWebhookSubscription
      .mockResolvedValueOnce("renewed")
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce("reused");

    const response = await POST(jobRequest());
    expect(mocks.ensureWebhookSubscription).toHaveBeenCalledTimes(3); // all three attempted
    // A batch with any failure is visible to the job system (retryable, non-2xx) —
    // safe because ensureWebhookSubscription is idempotent for a QStash retry.
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.failed).toBe(1);
    expect(body.renewed).toBe(1);
    expect(body.reused).toBe(1);
  });

  it("never exposes raw verification secrets in the response body", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(1));
    const response = await POST(jobRequest());
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(/secret/i);
    expect(text).not.toMatch(/token/i);
  });
});

describe("calendar-sync maintenance job: bounded pagination", () => {
  it("enqueues exactly one follow-up job with the next cursor when a full page is returned", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(25)); // BATCH_SIZE
    const response = await POST(jobRequest());
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [job, payload] = mocks.enqueue.mock.calls[0]!;
    expect(job).toBe("calendar-sync");
    expect(payload).toEqual({ cursor: calendarIds(25)[24]!.id });
    const body = await response.json();
    expect(body.nextCursor).toBe(calendarIds(25)[24]!.id);
  });

  it("the cursor advances deterministically to the last row's id, ordered ascending by id", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(25));
    await POST(jobRequest());
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: "asc" } }),
    );
  });

  it("a short/last page (< BATCH_SIZE) does not enqueue another page", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(3));
    const response = await POST(jobRequest());
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.nextCursor).toBeNull();
  });

  it("passes the provided cursor through to the query filter", async () => {
    mocks.findMany.mockResolvedValue([]);
    const cursor = "00000000-0000-4000-8000-000000000005";
    await POST(jobRequest(JSON.stringify({ cursor })));
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { gt: cursor } }) }),
    );
  });

  it("never loops unboundedly inside one invocation (findMany called exactly once)", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(25));
    await POST(jobRequest());
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("calendar-sync maintenance job: replay safety", () => {
  it("replaying the same page is safe (ensureWebhookSubscription is idempotent, called again with the same ids)", async () => {
    const rows = calendarIds(2);
    mocks.findMany.mockResolvedValue(rows);

    const first = await POST(jobRequest());
    expect(first.status).toBe(200);
    const firstCallCount = mocks.ensureWebhookSubscription.mock.calls.length;

    const replay = await POST(jobRequest());
    expect(replay.status).toBe(200);
    expect(mocks.ensureWebhookSubscription.mock.calls.length).toBe(firstCallCount * 2);
    for (const row of rows) {
      expect(mocks.ensureWebhookSubscription).toHaveBeenCalledWith(row.id);
    }
  });
});
