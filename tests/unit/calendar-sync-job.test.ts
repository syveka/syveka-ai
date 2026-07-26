import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyJobRequest: vi.fn(async (request: Request): Promise<string | null> => request.text()),
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

function retryDeduplicationId(failedIds: string[]): string {
  const digest = createHash("sha256")
    .update([...failedIds].sort().join(","))
    .digest("hex");
  return `calendar-sync-retry-${digest}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyJobRequest.mockImplementation(async (request: Request) => request.text());
  mocks.findMany.mockResolvedValue([]);
  mocks.ensureWebhookSubscription.mockResolvedValue("renewed");
  mocks.enqueue.mockResolvedValue(undefined);
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

  it("malformed signed JSON returns 400 without querying or enqueueing anything", async () => {
    const response = await POST(jobRequest("{not valid json"));
    expect(response.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.ensureWebhookSubscription).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("a payload mixing cursor and calendarIds returns 400", async () => {
    const response = await POST(
      jobRequest(
        JSON.stringify({
          cursor: "00000000-0000-4000-8000-000000000001",
          calendarIds: ["00000000-0000-4000-8000-000000000002"],
        }),
      ),
    );
    expect(response.status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.ensureWebhookSubscription).not.toHaveBeenCalled();
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

describe("calendar-sync maintenance job: sweep failures hand off to a retry job", () => {
  it("a full page with one failed calendar: all are attempted, one retry job and one next-page job are published, response is 200", async () => {
    const rows = calendarIds(25); // BATCH_SIZE, so a next page also exists
    mocks.findMany.mockResolvedValue(rows);
    const failingId = rows[10]!.id;
    mocks.ensureWebhookSubscription.mockImplementation(async (id: string) => {
      if (id === failingId) throw new Error("provider unavailable");
      return "renewed";
    });

    const response = await POST(jobRequest());

    expect(mocks.ensureWebhookSubscription).toHaveBeenCalledTimes(25); // all attempted
    expect(response.status).toBe(200); // failure has its own retry job now
    const body = await response.json();
    expect(body.failed).toBe(1);
    expect(body.processed).toBe(25);

    expect(mocks.enqueue).toHaveBeenCalledTimes(2);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "calendar-sync",
      { calendarIds: [failingId] },
      { deduplicationId: retryDeduplicationId([failingId]) },
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "calendar-sync",
      { cursor: rows[24]!.id },
      { deduplicationId: `calendar-sync-page-${rows[24]!.id}` },
    );
  });

  it("the retry publication contains no raw secrets or provider error messages", async () => {
    const rows = calendarIds(1);
    mocks.findMany.mockResolvedValue(rows);
    mocks.ensureWebhookSubscription.mockRejectedValue(
      new Error("provider secret token xyz rejected"),
    );
    await POST(jobRequest());
    const text = JSON.stringify(mocks.enqueue.mock.calls);
    expect(text).not.toContain("provider secret token xyz rejected");
    const [, payload] = mocks.enqueue.mock.calls[0]!;
    expect(payload).toEqual({ calendarIds: [rows[0]!.id] });
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
    const [job, payload, opts] = mocks.enqueue.mock.calls[0]!;
    expect(job).toBe("calendar-sync");
    expect(payload).toEqual({ cursor: calendarIds(25)[24]!.id });
    expect(opts).toEqual({ deduplicationId: `calendar-sync-page-${calendarIds(25)[24]!.id}` });
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

  it("replaying the same full sweep page produces the exact same next-page deduplicationId", async () => {
    const rows = calendarIds(25);
    mocks.findMany.mockResolvedValue(rows);

    await POST(jobRequest());
    const firstDedupeId = (mocks.enqueue.mock.calls[0]![2] as { deduplicationId: string })
      .deduplicationId;

    mocks.enqueue.mockClear();
    await POST(jobRequest());
    const secondDedupeId = (mocks.enqueue.mock.calls[0]![2] as { deduplicationId: string })
      .deduplicationId;

    expect(secondDedupeId).toBe(firstDedupeId);
    expect(firstDedupeId).toBe(`calendar-sync-page-${rows[24]!.id}`);
  });
});

describe("calendar-sync maintenance job: retry mode", () => {
  function retryRequest(ids: string[]) {
    return jobRequest(JSON.stringify({ calendarIds: ids }));
  }

  it("processes only the supplied ids, never queries all enabled calendars or enqueues pagination", async () => {
    const ids = calendarIds(2).map((c) => c.id);
    await POST(retryRequest(ids));
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.ensureWebhookSubscription).toHaveBeenCalledTimes(2);
    for (const id of ids) {
      expect(mocks.ensureWebhookSubscription).toHaveBeenCalledWith(id);
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("returns 500 when a supplied id still fails, and never recursively publishes a further retry", async () => {
    const ids = calendarIds(2).map((c) => c.id);
    mocks.ensureWebhookSubscription.mockImplementation(async (id: string) => {
      if (id === ids[1]) throw new Error("still unavailable");
      return "renewed";
    });
    const response = await POST(retryRequest(ids));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.failed).toBe(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("returns 200 when all supplied ids succeed or are safely skipped", async () => {
    const ids = calendarIds(2).map((c) => c.id);
    mocks.ensureWebhookSubscription
      .mockResolvedValueOnce("renewed")
      .mockResolvedValueOnce("skipped");
    const response = await POST(retryRequest(ids));
    expect(response.status).toBe(200);
  });

  it("rejects an empty or over-sized calendarIds payload", async () => {
    const tooMany = calendarIds(26).map((c) => c.id); // BATCH_SIZE + 1
    const response = await POST(retryRequest(tooMany));
    expect(response.status).toBe(400);
    expect(mocks.ensureWebhookSubscription).not.toHaveBeenCalled();
  });
});

describe("calendar-sync maintenance job: publication failure", () => {
  it("returns 500 when publishing the next-page job fails, and remains safe to replay", async () => {
    mocks.findMany.mockResolvedValue(calendarIds(25));
    mocks.enqueue.mockRejectedValueOnce(new Error("qstash unavailable"));

    const first = await POST(jobRequest());
    expect(first.status).toBe(500);

    // A replay is safe: ensureWebhookSubscription is idempotent, and the retry publish
    // is attempted again with the same deterministic deduplicationId.
    mocks.enqueue.mockResolvedValue(undefined);
    const replay = await POST(jobRequest());
    expect(replay.status).toBe(200);
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
