import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * The real post-call job against a real Postgres with the full migration history: real
 * Prisma queries, real interactive transactions and advisory locks, independent
 * connections. Mocked: the QStash signature, Redis, the summary provider (no paid call)
 * and the workflow event queue (no notification leaves the database).
 *
 * Two runs of the job are interleaved deterministically: the first run to finish a guarded
 * "already recorded?" read waits, before it may insert, until the second run has made the
 * same read (no serialization: both see nothing) or is seen waiting for an advisory lock
 * in pg_locks (serialization). Assertions are on committed rows.
 *
 * The second run starts once the first has reached its usage check: the route imports its
 * dependencies lazily, and two of those imports in flight at once can bypass vi.mock in
 * Vitest (seen as the real QStash verifier answering 401). The gates then make the runs
 * meet at each check.
 *
 * Skipped unless VOICE_PG_URL points at a scratch database prepared as in CI:
 * tests/migrations/supabase-compatibility.sql, then `prisma migrate deploy`. Synthetic
 * organizations only.
 */

const PG_URL = process.env.VOICE_PG_URL;

type Gate = { arrivals: number; second: boolean; outcome?: "contention" | "both_checked" };
const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  gates: null as Map<string, Gate> | null,
  contended: async () => false,
  failOnce: null as null | "activity.create" | "contact.link",
  onUsageCheck: null as null | (() => void),
  summaries: 0,
}));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by the post-call job");
  },
}));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (r: Request) => r.text() }));
vi.mock("@/server/integrations/redis", () => ({ redis: {} }));
vi.mock("@/server/ai/router", () => ({
  routeModel: () => ({ model: "synthetic", maxTokens: 64 }),
}));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: {
    messages: {
      create: vi.fn(async () => {
        holder.summaries += 1;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Synthetic summary.",
                sentiment: "neutral",
                followUps: ["Synthetic follow-up"],
              }),
            },
          ],
        };
      }),
    },
  },
}));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: vi.fn(async () => {}) }));

/** The first run to finish a gated check waits until the second run catches up there. */
async function passGate(name: string): Promise<void> {
  if (name === "usage") holder.onUsageCheck?.();
  const gates = holder.gates;
  if (!gates) return;
  const gate = gates.get(name) ?? { arrivals: 0, second: false };
  gates.set(name, gate);
  gate.arrivals += 1;
  if (gate.arrivals > 1) {
    gate.second = true;
    gate.outcome ??= "both_checked";
    return;
  }
  const deadline = Date.now() + 10_000;
  while (!gate.second && Date.now() < deadline) {
    if (await holder.contended()) {
      gate.outcome = "contention";
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (gate.second) gate.outcome ??= "both_checked";
}

type Row = Record<string, unknown>;
type Db = {
  organization: { create: (a: object) => Promise<{ id: string }> };
  user: { create: (a: object) => Promise<{ id: string }> };
  organizationMember: { create: (a: object) => Promise<unknown> };
  voiceAssistant: { create: (a: object) => Promise<{ id: string }> };
  voiceCall: {
    create: (a: object) => Promise<{ id: string; vapiCallId: string }>;
    findUnique: (a: object) => Promise<Row | null>;
  };
  usageRecord: { count: (a: object) => Promise<number> };
  activity: { count: (a: object) => Promise<number> };
  notification: { count: (a: object) => Promise<number> };
  contact: { findMany: (a: object) => Promise<Row[]> };
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
  $disconnect: () => Promise<void>;
};

describe.skipIf(!PG_URL)("post-call job on real Postgres", () => {
  let base: Db;
  let POST: (request: Request) => Promise<Response>;

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
    ]);
    // Several connections stand in for concurrent serverless instances.
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 8 }),
    });
    base = prisma as unknown as Db;
    const gated =
      (name: string) =>
      async ({ args, query }: { args: unknown; query: (a: unknown) => Promise<unknown> }) => {
        // Held after the read: the other run must also read (no serialization) or be
        // waiting for this run's lock (serialization) before this run may insert.
        const result = await query(args);
        await passGate(name);
        return result;
      };
    holder.client = prisma.$extends({
      query: {
        usageRecord: { findFirst: gated("usage") },
        contact: { findFirst: gated("contact") },
        activity: {
          findFirst: gated("activity"),
          async create({ args, query }) {
            if (holder.failOnce === "activity.create") {
              holder.failOnce = null;
              throw new Error("synthetic failure creating the activity");
            }
            return query(args);
          },
        },
        notification: { findFirst: gated("notification") },
        voiceCall: {
          async update({ args, query }) {
            if (holder.failOnce === "contact.link" && "contactId" in (args.data as object)) {
              holder.failOnce = null;
              throw new Error("synthetic failure linking the contact");
            }
            return query(args);
          },
        },
      },
    });
    holder.contended = async () => {
      const rows = await base.$queryRaw`
        select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted`;
      return Number(rows[0]?.waiting) > 0;
    };
    // Loaded on its own first: the route imports it alongside six other modules at once,
    // and loaded that way its "@/server/db/tenant" import missed the mock above, so the
    // organization check ran on the real client (DATABASE_URL, not this database).
    await import("@/server/jobs/organization-guard");
    ({ POST } = await import("@/app/api/v1/jobs/post-call/route"));
  });

  afterAll(async () => {
    await base?.$disconnect();
  });

  beforeEach(() => {
    holder.gates = null;
    holder.failOnce = null;
    holder.summaries = 0;
  });

  /** A synthetic organization with an owner, an assistant and one ended, unprocessed call. */
  async function seedCall(label: string) {
    const org = await base.organization.create({
      data: { name: `Synthetic post-call ${label}`, slug: `post-call-${label}-${randomUUID()}` },
    });
    const owner = await base.user.create({
      data: { id: randomUUID(), email: `owner-${randomUUID()}@example.test` },
    });
    await base.organizationMember.create({
      data: { organizationId: org.id, userId: owner.id, role: "OWNER" },
    });
    const assistant = await base.voiceAssistant.create({
      data: {
        organizationId: org.id,
        name: `Assistant ${label}`,
        firstMessage: "Hello",
        systemPrompt: "Synthetic",
        language: "EN",
      },
    });
    const phone = `+35840${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const call = await base.voiceCall.create({
      data: {
        organizationId: org.id,
        assistantId: assistant.id,
        vapiCallId: `call-${randomUUID()}`,
        callerNumber: phone,
        status: "COMPLETED",
        startedAt: new Date(Date.now() - 120_000),
        endedAt: new Date(),
        durationSeconds: 95,
        transcript: [{ role: "user", message: "synthetic transcript of a call" }],
      },
    });
    return { orgId: org.id, callId: call.id, vapiCallId: call.vapiCallId, phone };
  }

  /** Starts `second` once `first` has reached its usage check (its imports are done). */
  async function staggered(first: () => Promise<Response>, second: () => Promise<Response>) {
    let reached = () => {};
    const atUsageCheck = new Promise<void>((resolve) => (reached = resolve));
    holder.onUsageCheck = reached;
    const firstRun = first();
    await Promise.race([atUsageCheck, firstRun.catch(() => undefined)]);
    holder.onUsageCheck = null;
    return Promise.all([firstRun, second()]);
  }

  const run = (orgId: string, vapiCallId: string) =>
    POST(
      new Request("http://localhost/api/v1/jobs/post-call", {
        method: "POST",
        body: JSON.stringify({ orgId, vapiCallId }),
      }),
    );

  async function state(c: { orgId: string; callId: string; phone: string }) {
    const call = await base.voiceCall.findUnique({ where: { id: c.callId } });
    return {
      usage: await base.usageRecord.count({
        where: {
          organizationId: c.orgId,
          metric: "VOICE_MINUTES",
          metadata: { path: ["callId"], equals: c.callId },
        },
      }),
      activities: await base.activity.count({
        where: {
          organizationId: c.orgId,
          type: "VOICE_AI_CALL",
          metadata: { path: ["voiceCallId"], equals: c.callId },
        },
      }),
      notifications: await base.notification.count({
        where: {
          organizationId: c.orgId,
          type: "call.completed",
          href: `/voice/calls/${c.callId}`,
        },
      }),
      contacts: await base.contact.findMany({
        where: { organizationId: c.orgId, phone: c.phone },
        select: { id: true },
      }),
      contactId: call?.contactId ?? null,
      processed: call?.postCallProcessedAt instanceof Date,
    };
  }

  it("two simultaneous runs for one call record usage, contact, activity and notification once", async () => {
    const c = await seedCall("race");
    holder.gates = new Map();

    const responses = await staggered(
      () => run(c.orgId, c.vapiCallId),
      () => run(c.orgId, c.vapiCallId),
    );

    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const s = await state(c);
    // Labelled: the evidence workflow checks which of these fails on previous code.
    expect(s.usage, "usage rows").toBe(1);
    expect(s.contacts, "contact rows").toHaveLength(1);
    expect(s.contactId).toBe(s.contacts[0]!.id);
    expect(s.activities, "activity rows").toBe(1);
    expect(s.notifications, "notification rows").toBe(1);
    expect(s.processed).toBe(true);
    // The runs really met at each guarded check: one waited on the other's lock.
    for (const name of ["usage", "contact", "activity", "notification"]) {
      expect(holder.gates.get(name)?.outcome, name).toBe("contention");
    }
    // Known limit: each run may pay for its own summary (both here); one activity results.
    expect(holder.summaries).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it("a retry after a failure part-way runs only the unfinished steps", async () => {
    const c = await seedCall("partial");
    holder.failOnce = "activity.create";

    await expect(run(c.orgId, c.vapiCallId)).rejects.toThrow(
      "synthetic failure creating the activity",
    );
    const partial = await state(c);
    expect(partial).toMatchObject({ usage: 1, activities: 0, notifications: 0, processed: false });
    expect(partial.contacts).toHaveLength(1);

    const retry = await run(c.orgId, c.vapiCallId);

    expect(retry.status).toBe(200);
    const done = await state(c);
    expect(done).toMatchObject({ usage: 1, activities: 1, notifications: 1, processed: true });
    expect(done.contacts).toHaveLength(1);
    // The saved summary is reused: no second paid summary on the retry.
    expect(holder.summaries).toBe(1);
  });

  it("a step that fails inside its transaction leaves nothing behind, and the retry completes", async () => {
    const c = await seedCall("rollback");
    holder.failOnce = "contact.link";

    await expect(run(c.orgId, c.vapiCallId)).rejects.toThrow(
      "synthetic failure linking the contact",
    );
    const failed = await state(c);
    // The contact created in the same transaction was rolled back with the failed link.
    expect(failed.contacts).toHaveLength(0);
    expect(failed.contactId).toBeNull();
    expect(failed.usage).toBe(1);

    expect((await run(c.orgId, c.vapiCallId)).status).toBe(200);
    const done = await state(c);
    expect(done.contacts).toHaveLength(1);
    expect(done.contactId).toBe(done.contacts[0]!.id);
    expect(done).toMatchObject({ usage: 1, activities: 1, notifications: 1, processed: true });
  });

  it("calls of two organizations processed at the same time stay within their organization", async () => {
    const a = await seedCall("tenant-a");
    const b = await seedCall("tenant-b");

    holder.gates = new Map();
    await staggered(
      () => run(a.orgId, a.vapiCallId),
      () => run(b.orgId, b.vapiCallId),
    );
    // Different calls take different locks: neither run waited for the other.
    for (const name of ["usage", "contact", "activity", "notification"]) {
      expect(holder.gates.get(name)?.outcome, name).toBe("both_checked");
    }
    holder.gates = null;
    // Organization B naming organization A's call finds nothing to process.
    const crossed = await run(b.orgId, a.vapiCallId);

    expect(await crossed.json()).toEqual({ skipped: "call not found" });
    for (const c of [a, b]) {
      const s = await state(c);
      expect(s).toMatchObject({ usage: 1, activities: 1, notifications: 1, processed: true });
      expect(s.contacts).toHaveLength(1);
    }
    // Nothing of A's call was recorded under B.
    const leaked = await base.usageRecord.count({
      where: { organizationId: b.orgId, metadata: { path: ["callId"], equals: a.callId } },
    });
    expect(leaked).toBe(0);
  }, 30_000);
});
