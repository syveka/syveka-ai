import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * The real Vapi webhook route against a real Postgres with the full migration history:
 * real Prisma upserts, the real unique vapi_call_id and real concurrency. Only the
 * signature check, Redis, the job queue and the plan lookup are mocked.
 *
 * Skipped unless VOICE_PG_URL points at a scratch database prepared as in CI:
 * tests/migrations/supabase-compatibility.sql, then `prisma migrate deploy`. Not run
 * in CI. Synthetic organizations only.
 */

const PG_URL = process.env.VOICE_PG_URL;

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  redis: new Map<string, string>(),
  enqueued: [] as { orgId: string; vapiCallId: string }[],
}));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by the webhook");
  },
}));
vi.mock("@/server/integrations/vapi", () => ({ verifyVapiSignature: () => true }));
vi.mock("@/server/services/billing/entitlements", () => ({
  getMonthUsage: vi.fn(async () => 0),
  getEntitlements: vi.fn(async () => ({ voiceMinutesMonth: 1000, readOnly: false })),
}));
vi.mock("@/server/jobs/queue", () => ({
  enqueue: vi.fn(async (_job: string, payload: { orgId: string; vapiCallId: string }) => {
    holder.enqueued.push(payload);
  }),
}));
vi.mock("@/server/integrations/redis", () => ({
  redis: {
    get: async (key: string) => holder.redis.get(key) ?? null,
    set: async (key: string, value: string) => {
      holder.redis.set(key, value);
      return "OK";
    },
    del: async (key: string) => Number(holder.redis.delete(key)),
    incr: async () => 1,
    decr: async () => 0,
    expire: async () => 1,
  },
}));
vi.mock("@/server/ai/tools", () => ({ executeTool: vi.fn() }));

type Row = Record<string, unknown>;
type Db = {
  organization: { create: (a: object) => Promise<{ id: string }> };
  voiceAssistant: { create: (a: object) => Promise<{ id: string }> };
  voiceCall: {
    findUnique: (a: object) => Promise<Row | null>;
    findMany: (a: object) => Promise<Row[]>;
  };
  $disconnect: () => Promise<void>;
};

describe.skipIf(!PG_URL)("Vapi webhook call rows on real Postgres", () => {
  let db: Db;
  let POST: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
    ]);
    // Several connections stand in for concurrent serverless instances.
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 4 }),
    }) as unknown as Db;
    holder.client = db;
    ({ POST } = await import("@/app/api/v1/voice/webhook/route"));
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(() => {
    holder.redis.clear();
    holder.enqueued.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  /** A synthetic organization with one active assistant; returns its Vapi assistant id. */
  async function seedOrg(label: string) {
    const org = await db.organization.create({
      data: { name: `Synthetic voice ${label}`, slug: `voice-${label}-${randomUUID()}` },
    });
    const vapiAssistantId = `va-${randomUUID()}`;
    await db.voiceAssistant.create({
      data: {
        organizationId: org.id,
        vapiAssistantId,
        name: `Assistant ${label}`,
        firstMessage: "Hello",
        systemPrompt: "Synthetic",
        isActive: true,
      },
    });
    return { orgId: org.id, vapiAssistantId };
  }

  const webhook = (message: Row) =>
    POST(
      new Request("http://localhost/api/v1/voice/webhook", {
        method: "POST",
        headers: { "x-vapi-signature": "synthetic" },
        body: JSON.stringify({ message }),
      }),
    );
  const statusUpdate = (vapiAssistantId: string, callId: string) =>
    webhook({
      type: "status-update",
      status: "in-progress",
      call: { id: callId, assistantId: vapiAssistantId, customer: { number: "+358401111111" } },
    });
  const report = (vapiAssistantId: string, callId: string, extra: Row = {}) =>
    webhook({
      type: "end-of-call-report",
      call: { id: callId, assistantId: vapiAssistantId },
      endedReason: "customer-ended-call",
      durationSeconds: 75,
      cost: 0.4,
      artifact: { messages: [{ role: "user", message: "synthetic transcript" }] },
      ...extra,
    });
  const callRow = (vapiCallId: string) => db.voiceCall.findUnique({ where: { vapiCallId } });

  it("organization B can't change organization A's call or start post-call work for it", async () => {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    const callId = `call-${randomUUID()}`;
    expect((await statusUpdate(a.vapiAssistantId, callId)).status).toBe(200);
    expect((await report(a.vapiAssistantId, callId)).status).toBe(200);
    const before = await callRow(callId);
    expect(before).toMatchObject({ organizationId: a.orgId, status: "COMPLETED" });
    holder.enqueued.length = 0;
    holder.redis.clear();

    const forgedReport = await report(b.vapiAssistantId, callId, {
      durationSeconds: 999,
      endedReason: "forged",
      artifact: { messages: [{ role: "user", message: "forged" }] },
    });
    const forgedStatus = await statusUpdate(b.vapiAssistantId, callId);

    expect(forgedReport.status).toBe(409);
    await expect(forgedReport.json()).resolves.toEqual({ error: "call_conflict" });
    expect(forgedStatus.status).toBe(200);
    expect(await callRow(callId)).toEqual(before);
    expect(holder.enqueued).toEqual([]);
    expect(await db.voiceCall.findMany({ where: { organizationId: b.orgId } })).toEqual([]);
  });

  it("concurrent first writes for one call within one organization leave exactly one complete row", async () => {
    const a = await seedOrg("race");
    for (let i = 0; i < 10; i++) {
      const callId = `call-${randomUUID()}`;
      const responses = await Promise.all([
        statusUpdate(a.vapiAssistantId, callId),
        report(a.vapiAssistantId, callId),
      ]);

      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const rows = await db.voiceCall.findMany({ where: { vapiCallId: callId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: a.orgId,
        status: "COMPLETED",
        durationSeconds: 75,
      });
      expect(holder.enqueued.filter((j) => j.vapiCallId === callId)).toEqual([
        { vapiCallId: callId, orgId: a.orgId },
      ]);
    }
  });

  it("a genuine database failure fails the request so Vapi retries, with no post-call work", async () => {
    const a = await seedOrg("failure");
    const callId = `call-${randomUUID()}`;

    // duration_seconds is a Postgres integer: this value is out of range.
    await expect(report(a.vapiAssistantId, callId, { durationSeconds: 1e12 })).rejects.toThrow();
    expect(holder.enqueued).toEqual([]);
    expect(await callRow(callId)).toBeNull();
  });
});
