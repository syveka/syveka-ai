import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The nightly usage-rollup job: purges on the first page only, checks a
 * bounded page of organizations per delivery, chains the next page as its
 * own job, and refuses a malformed body. Mocked: the QStash verifier (the
 * body is passed through), the database, entitlements and the queue.
 */
const m = vi.hoisted(() => ({
  orgs: [] as Array<{ id: string; members: Array<{ userId: string }> }>,
  usage: {} as Record<string, number>,
  notifications: [] as Array<Record<string, unknown>>,
  deleteMany: vi.fn(async () => ({ count: 2 })),
  findMany: vi.fn(),
  enqueue: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (r: Request) => r.text() }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    contact: { deleteMany: m.deleteMany },
    document: { deleteMany: m.deleteMany },
    conversation: { deleteMany: m.deleteMany },
    organization: {
      findMany: m.findMany.mockImplementation(
        async ({ where, take }: { where: { id?: { gt: string } }; take: number }) =>
          m.orgs.filter((o) => !where.id || o.id > where.id.gt).slice(0, take),
      ),
    },
    notification: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        m.notifications.push(data);
        return data;
      }),
    },
  },
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => ({ aiMessagesPerOrgMonth: 100, voiceMinutesMonth: 0 })),
  getMonthUsage: vi.fn(async (orgId: string, metric: string) =>
    metric === "AI_MESSAGES" ? (m.usage[orgId] ?? 0) : 0,
  ),
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: m.enqueue }));

import { POST } from "@/app/api/v1/jobs/usage-rollup/route";
import { USAGE_ROLLUP_BATCH_SIZE } from "@/server/jobs/usage-rollup";

const orgId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const job = (body = "") =>
  new Request("https://jobs.test/api/v1/jobs/usage-rollup", { method: "POST", body });

beforeEach(() => {
  vi.clearAllMocks();
  m.orgs = [];
  m.usage = {};
  m.notifications = [];
});

describe("usage-rollup", () => {
  it("the scheduled (bodiless) delivery purges, warns the owners over 80%, and ends when the page isn't full", async () => {
    m.orgs = [1, 2, 3].map((n) => ({ id: orgId(n), members: [{ userId: `owner-${n}` }] }));
    m.usage[orgId(2)] = 85;

    const res = await POST(job());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      purged: { contacts: 2, documents: 2, conversations: 2 },
      warned: 1,
      nextCursor: null,
    });
    expect(m.deleteMany).toHaveBeenCalledTimes(3);
    expect(m.notifications).toEqual([
      expect.objectContaining({
        organizationId: orgId(2),
        userId: "owner-2",
        type: "usage.warning",
      }),
    ]);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("a full page chains the next page as its own job, deduplicated by cursor", async () => {
    m.orgs = Array.from({ length: USAGE_ROLLUP_BATCH_SIZE + 1 }, (_, i) => ({
      id: orgId(i + 1),
      members: [{ userId: `owner-${i + 1}` }],
    }));

    const res = await POST(job());

    const last = orgId(USAGE_ROLLUP_BATCH_SIZE);
    expect(await res.json()).toMatchObject({ nextCursor: last });
    expect(m.enqueue).toHaveBeenCalledWith(
      "usage-rollup",
      { cursor: last },
      { deduplicationId: `usage-rollup:${last}` },
    );
  });

  it("a chained page continues after the cursor and never purges again", async () => {
    m.orgs = [1, 2, 3].map((n) => ({ id: orgId(n), members: [{ userId: `owner-${n}` }] }));
    m.usage[orgId(1)] = 90;
    m.usage[orgId(3)] = 90;

    const res = await POST(job(JSON.stringify({ cursor: orgId(1) })));

    expect(await res.json()).toEqual({ ok: true, purged: null, warned: 1, nextCursor: null });
    expect(m.deleteMany).not.toHaveBeenCalled();
    expect(m.notifications.map((n) => n.organizationId)).toEqual([orgId(3)]);
  });

  it("answers 500 (deliver again) when the next page can't be enqueued, keeping this page's warnings", async () => {
    m.orgs = Array.from({ length: USAGE_ROLLUP_BATCH_SIZE }, (_, i) => ({
      id: orgId(i + 1),
      members: [{ userId: `owner-${i + 1}` }],
    }));
    m.usage[orgId(1)] = 95;
    m.enqueue.mockRejectedValueOnce(new Error("qstash down"));

    const res = await POST(job());

    expect(res.status).toBe(500);
    expect(m.notifications).toHaveLength(1);
  });

  it.each(["not json", "{", '{"cursor":"nope"}', '{"orgId":"x"}'])(
    "%s is an invalid payload (400), nothing purged or checked",
    async (body) => {
      const res = await POST(job(body));
      expect(res.status).toBe(400);
      expect(m.deleteMany).not.toHaveBeenCalled();
      expect(m.findMany).not.toHaveBeenCalled();
    },
  );
});
