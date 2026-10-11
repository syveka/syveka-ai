import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * The real Vapi webhook route against a real Postgres with the full migration history:
 * real Prisma upserts, the real unique vapi_call_id and real concurrency. Only the
 * signature check, Redis, the job queue and the plan lookup are mocked.
 *
 * Concurrent requests start one after the other's assistant lookup: the route imports its
 * dependencies lazily, and two of those imports in flight at once can bypass vi.mock in
 * Vitest (seen as the real signature check running). A gate then holds both at the
 * upsert, so the database writes really overlap.
 *
 * Skipped unless VOICE_PG_URL points at a scratch database prepared as in CI:
 * tests/migrations/supabase-compatibility.sql, then `prisma migrate deploy`. Synthetic
 * organizations only.
 */

const PG_URL = process.env.VOICE_PG_URL;

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  redis: new Map<string, string>(),
  enqueued: [] as { orgId: string; vapiCallId: string }[],
  failEnqueueOnce: false,
  onAssistantLookup: null as null | (() => void),
  upsertGate: null as null | (() => Promise<void>),
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
    if (holder.failEnqueueOnce) {
      holder.failEnqueueOnce = false;
      throw new Error("synthetic queue outage");
    }
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
  $executeRawUnsafe: (sql: string) => Promise<number>;
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
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 4 }),
    });
    db = prisma as unknown as Db;
    holder.client = prisma.$extends({
      query: {
        voiceAssistant: {
          async findFirst({ args, query }) {
            holder.onAssistantLookup?.();
            return query(args);
          },
        },
        voiceCall: {
          async upsert({ args, query }) {
            await holder.upsertGate?.();
            return query(args);
          },
        },
      },
    });
    ({ POST } = await import("@/app/api/v1/voice/webhook/route"));
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    holder.redis.clear();
    holder.enqueued.length = 0;
    holder.failEnqueueOnce = false;
    errorSpy?.mockRestore();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  const conflictLogged = () =>
    errorSpy.mock.calls.flat().map(String).join(" ").includes("voice_call_org_conflict");

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

  /** Organization A's completed call, its row as committed, and organization B. */
  async function aCallAndB() {
    const a = await seedOrg("a");
    const b = await seedOrg("b");
    const callId = `call-${randomUUID()}`;
    expect((await statusUpdate(a.vapiAssistantId, callId)).status).toBe(200);
    expect((await report(a.vapiAssistantId, callId)).status).toBe(200);
    const before = await callRow(callId);
    expect(before).toMatchObject({ organizationId: a.orgId, status: "COMPLETED" });
    holder.enqueued.length = 0;
    holder.redis.clear();
    errorSpy.mockClear();
    return { a, b, callId, before };
  }

  it("B's end-of-call report for A's call id changes nothing, is refused 409 and queues nothing", async () => {
    const { b, callId, before } = await aCallAndB();

    // Prisma runs this as INSERT ... ON CONFLICT DO UPDATE ... WHERE organization_id = B:
    // A's row is not updated and no row comes back (the null outcome).
    const forged = await report(b.vapiAssistantId, callId, {
      durationSeconds: 999,
      endedReason: "forged",
      artifact: { messages: [{ role: "user", message: "forged" }] },
    });

    expect(forged.status).toBe(409);
    await expect(forged.json()).resolves.toEqual({ error: "call_conflict" });
    expect(await callRow(callId)).toEqual(before);
    expect(holder.enqueued).toEqual([]);
    expect(conflictLogged()).toBe(true);
    expect(await db.voiceCall.findMany({ where: { organizationId: b.orgId } })).toEqual([]);
  });

  it("B's status update for A's call id changes nothing and records nothing", async () => {
    const { b, callId, before } = await aCallAndB();

    // Nothing to update: Prisma runs SELECT (within B) then INSERT, which fails on the
    // unique call id (the P2002 outcome).
    const forged = await statusUpdate(b.vapiAssistantId, callId);

    expect(forged.status).toBe(200);
    expect(await callRow(callId)).toEqual(before);
    expect(conflictLogged()).toBe(true);
    expect(await db.voiceCall.findMany({ where: { organizationId: b.orgId } })).toEqual([]);
  });

  it("A's own retries are accepted: a redelivered report, and a report whose enqueue failed", async () => {
    const a = await seedOrg("retry");
    const callId = `call-${randomUUID()}`;
    holder.failEnqueueOnce = true;

    expect((await report(a.vapiAssistantId, callId)).status).toBe(500);
    const afterFailure = await callRow(callId);
    expect(afterFailure).toMatchObject({ organizationId: a.orgId, status: "COMPLETED" });
    expect(holder.enqueued).toEqual([]);

    expect((await report(a.vapiAssistantId, callId)).status).toBe(200);
    const redelivered = await report(a.vapiAssistantId, callId);

    await expect(redelivered.json()).resolves.toMatchObject({ duplicate: true });
    expect(holder.enqueued).toEqual([{ vapiCallId: callId, orgId: a.orgId }]);
    expect(await callRow(callId)).toEqual(afterFailure);
    expect(conflictLogged()).toBe(false);
  });

  it("concurrent first writes for one call within one organization leave exactly one complete row", async () => {
    const a = await seedOrg("race");
    for (let i = 0; i < 10; i++) {
      const callId = `call-${randomUUID()}`;
      // Both orders: the status update first on even rounds, the report first on odd ones.
      const [first, second] =
        i % 2 === 0
          ? [() => statusUpdate(a.vapiAssistantId, callId), () => report(a.vapiAssistantId, callId)]
          : [
              () => report(a.vapiAssistantId, callId),
              () => statusUpdate(a.vapiAssistantId, callId),
            ];
      let arrivals = 0;
      let release = () => {};
      const bothAtUpsert = new Promise<void>((resolve) => (release = resolve));
      holder.upsertGate = async () => {
        arrivals += 1;
        if (arrivals === 2) release();
        await bothAtUpsert;
      };
      let looked = () => {};
      const firstLookedUp = new Promise<void>((resolve) => (looked = resolve));
      holder.onAssistantLookup = looked;
      const firstResponse = first();
      await firstLookedUp;
      holder.onAssistantLookup = null;
      const responses = await Promise.all([firstResponse, second()]);
      holder.upsertGate = null;
      // Both reached the upsert together (a P2002 retry upserts a third time).
      expect(arrivals).toBeGreaterThanOrEqual(2);

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

  it("a genuine database failure fails the request so Vapi retries; it isn't called a conflict", async () => {
    const a = await seedOrg("failure");
    const callId = `fail-${randomUUID()}`;
    // A failure raised by the database itself, only for this test's call ids.
    await db.$executeRawUnsafe(`
      create or replace function voice_test_reject_call() returns trigger language plpgsql as $$
      begin
        if new.vapi_call_id like 'fail-%' then raise exception 'synthetic database failure'; end if;
        return new;
      end $$`);
    await db.$executeRawUnsafe(`
      create trigger voice_test_reject_call before insert or update on voice_calls
      for each row execute function voice_test_reject_call()`);
    try {
      await expect(report(a.vapiAssistantId, callId)).rejects.toThrow();
      await expect(statusUpdate(a.vapiAssistantId, callId)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe("drop trigger voice_test_reject_call on voice_calls");
      await db.$executeRawUnsafe("drop function voice_test_reject_call()");
    }

    expect(holder.enqueued).toEqual([]);
    expect(await callRow(callId)).toBeNull();
    expect(conflictLogged()).toBe(false);
  });
});
