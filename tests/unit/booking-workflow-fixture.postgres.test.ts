import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type * as BookingService from "@/server/services/booking";
import type * as RunWorkflowRoute from "@/app/api/v1/jobs/run-workflow/route";

/**
 * Local, real-Postgres rehearsal of the staging booking → workflow journey
 * (tests/e2e/booking-workflows.spec.ts). Runs the real fixture script
 * (scripts/ensure-e2e-booking-workflow-fixtures.ts) against a migrated
 * database, then the real public booking services and the real run-workflow
 * job route on that data: booking.created, booking.rescheduled and
 * booking.canceled each run their fixture workflow once, write the CRM note
 * on the guest's contact in the right organization, carry the expected
 * payload without the guest's notes, and never touch the other fixture
 * organization. Only the queue, email, reminders, audit, Redis cache and
 * job signature are faked; the queue's jobs are delivered to the route by
 * hand, which is what QStash does on staging.
 *
 * Opt-in: BOOKING_FIXTURE_PG_URL must point at a disposable database with the
 * full migration history and tests/migrations/supabase-compatibility.sql
 * applied, plus `raw_app_meta_data jsonb` on auth.users and the two fixture
 * owner rows (see the PR description for the exact local setup). Never point
 * it at staging or production.
 */

const PG_URL = process.env.BOOKING_FIXTURE_PG_URL;
const E2E_EMAIL = "qa@example.test";

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  jobs: [] as Array<{ job: string; payload: Record<string, unknown> }>,
  delivered: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  // The public booking path and the job route use unscopedPrisma with
  // explicit organization filters; nothing in this journey reads tenantDb.
  tenantDb: () => {
    throw new Error("tenantDb is not used on the public booking/job path");
  },
}));
vi.mock("@/server/jobs/queue", () => ({
  enqueue: vi.fn(async (job: string, payload: Record<string, unknown>) => {
    holder.jobs.push({ job, payload });
  }),
}));
vi.mock("@/server/jobs/verify", () => ({ verifyJobRequest: async (req: Request) => req.text() }));
vi.mock("@/server/integrations/redis", () => ({
  redis: { get: async () => null, set: async () => "OK", del: async () => 1 },
  rateLimiters: {},
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

type Prisma = {
  $queryRawUnsafe: <T>(sql: string, ...values: unknown[]) => Promise<T>;
  $disconnect: () => Promise<void>;
};

describe.skipIf(!PG_URL)("booking-workflow fixture on real Postgres", () => {
  let db: Prisma;
  let booking: typeof BookingService;
  let runWorkflow: typeof RunWorkflowRoute;
  const orgIds: Record<"a" | "b", string> = { a: "", b: "" };

  const fixture = (mode: "prepare" | "cleanup") =>
    execFileSync(
      process.execPath,
      [
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        "scripts/ensure-e2e-booking-workflow-fixtures.ts",
        mode,
      ],
      {
        env: {
          ...process.env,
          DIRECT_URL: PG_URL,
          E2E_USER_EMAIL: E2E_EMAIL,
          // Both fixture owners already exist in this database, so the
          // Supabase admin API is never called.
          SUPABASE_URL: "http://127.0.0.1:9",
          SUPABASE_SERVICE_ROLE_KEY: "local-only",
        },
        encoding: "utf8",
      },
    );

  /** Delivers every queued run-workflow job to the real route, as QStash would. */
  async function drainJobs(): Promise<void> {
    while (holder.jobs.length) {
      const { job, payload } = holder.jobs.shift()!;
      holder.delivered.push(payload);
      expect(job).toBe("run-workflow");
      const res = await runWorkflow.POST(
        new Request("https://example.test/api/v1/jobs/run-workflow", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      );
      expect(res.status).toBe(200);
    }
  }

  const runs = (orgId: string) =>
    db.$queryRawUnsafe<
      Array<{ name: string; status: string; trigger_data: Record<string, unknown> }>
    >(
      `select w.name, r.status, r.trigger_data from workflow_runs r join workflows w on w.id = r.workflow_id
       where r.organization_id = $1::uuid order by r.started_at`,
      orgId,
    );

  const notes = (orgId: string) =>
    db.$queryRawUnsafe<Array<{ subject: string; contact_id: string; body: string | null }>>(
      "select subject, contact_id, body from activities where organization_id = $1::uuid and subject like 'E2E %' order by created_at",
      orgId,
    );

  const contactId = async (orgId: string, email: string) => {
    const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
      "select id from contacts where organization_id = $1::uuid and lower(email) = lower($2)",
      orgId,
      email,
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  };

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
    ]);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 4 }),
    }) as unknown as Prisma;
    holder.client = db;
    fixture("prepare");
    fixture("prepare"); // idempotent: the second run must not duplicate anything
    for (const key of ["a", "b"] as const) {
      const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
        "select id from organizations where slug = $1",
        `syveka-e2e-booking-${key}`,
      );
      orgIds[key] = rows[0]!.id;
    }
    booking = await import("@/server/services/booking");
    runWorkflow = await import("@/app/api/v1/jobs/run-workflow/route");
  }, 120_000);

  afterAll(async () => {
    if (db) {
      fixture("cleanup");
      await db.$disconnect();
    }
  });

  it("re-running prepare keeps exactly one of every fixture object", async () => {
    const [counts] = await db.$queryRawUnsafe<
      Array<{ orgs: number; types: number; workflows: number; grants: number; rules: number }>
    >(
      `select
         (select count(*)::int from organizations where slug like 'syveka-e2e-booking-%') as orgs,
         (select count(*)::int from booking_types t join organizations o on o.id = t.organization_id where o.slug like 'syveka-e2e-booking-%') as types,
         (select count(*)::int from workflows w join organizations o on o.id = w.organization_id where o.slug like 'syveka-e2e-booking-%') as workflows,
         (select count(*)::int from entitlement_grants g join organizations o on o.id = g.organization_id where o.slug like 'syveka-e2e-booking-%') as grants,
         (select count(*)::int from availability_rules r join availability_schedules s on s.id = r.schedule_id join organizations o on o.id = s.organization_id where o.slug like 'syveka-e2e-booking-%') as rules`,
    );
    expect(counts).toEqual({ orgs: 2, types: 2, workflows: 6, grants: 2, rules: 14 });
  });

  it("create → reschedule → cancel runs each workflow once, on the right contact, in one org only", async () => {
    const from = new Date(Date.now() + 2 * 86_400_000);
    const to = new Date(Date.now() + 9 * 86_400_000);
    const slotsA = await booking.getPublicSlots({
      orgSlug: "syveka-e2e-booking-a",
      typeSlug: "e2e-intro",
      from,
      to,
    });
    const slotsB = await booking.getPublicSlots({
      orgSlug: "syveka-e2e-booking-b",
      typeSlug: "e2e-intro",
      from,
      to,
    });
    expect(slotsA.slots.length).toBeGreaterThan(48);
    const first = slotsA.slots[0]!.toISOString();
    const later = slotsA.slots.find((s) => s.getTime() >= slotsA.slots[0]!.getTime() + 86_400_000)!;
    const secret = "PRIVATE-NOTE-should-not-leak";
    const guestA = { name: "Guest A", email: "qa+booking-guest-a@example.test" };
    const guestB = { name: "Guest B", email: "qa+booking-guest-b@example.test" };
    const input = (guest: typeof guestA, startsAt: string) => ({
      startsAt,
      timezone: "UTC",
      ...guest,
      notes: secret,
      consent: true,
      locale: "en" as const,
    });

    const createdA = await booking.createPublicBooking({
      orgSlug: "syveka-e2e-booking-a",
      typeSlug: "e2e-intro",
      input: input(guestA, first),
    });
    const createdB = await booking.createPublicBooking({
      orgSlug: "syveka-e2e-booking-b",
      typeSlug: "e2e-intro",
      input: input(guestB, slotsB.slots[0]!.toISOString()),
    });
    await drainJobs();
    const contactA = await contactId(orgIds.a, guestA.email);
    const contactB = await contactId(orgIds.b, guestB.email);

    const moved = await booking.rescheduleBookingViaToken(
      createdA.manageToken,
      later.toISOString(),
    );
    await drainJobs();
    await booking.cancelBookingViaToken(moved.manageToken, "E2E reason");
    await drainJobs();

    const runsA = await runs(orgIds.a);
    const runsB = await runs(orgIds.b);
    expect(runsA.map((r) => [r.name, r.status])).toEqual([
      ["E2E booking.created", "SUCCEEDED"],
      ["E2E booking.rescheduled", "SUCCEEDED"],
      ["E2E booking.canceled", "SUCCEEDED"],
    ]);
    expect(runsB.map((r) => [r.name, r.status])).toEqual([["E2E booking.created", "SUCCEEDED"]]);

    expect(runsA[0]!.trigger_data).toEqual({
      bookingId: createdA.booking.id,
      contactId: contactA,
      bookingType: "E2E Intro",
      guestName: guestA.name,
      guestEmail: guestA.email,
      startsAt: first,
    });
    expect(runsA[1]!.trigger_data).toEqual({
      bookingId: moved.booking.id,
      previousBookingId: createdA.booking.id,
      contactId: contactA,
      bookingType: "E2E Intro",
      guestName: guestA.name,
      guestEmail: guestA.email,
      startsAt: later.toISOString(),
      previousStartsAt: first,
    });
    expect(runsA[2]!.trigger_data).toEqual({
      bookingId: moved.booking.id,
      contactId: contactA,
      bookingType: "E2E Intro",
      guestName: guestA.name,
      guestEmail: guestA.email,
      startsAt: later.toISOString(),
      reason: "E2E reason",
    });
    expect(runsB[0]!.trigger_data).toMatchObject({
      bookingId: createdB.booking.id,
      contactId: contactB,
    });

    expect(await notes(orgIds.a)).toEqual([
      expect.objectContaining({
        subject: `E2E booking.created ${createdA.booking.id}`,
        contact_id: contactA,
      }),
      expect.objectContaining({
        subject: `E2E booking.rescheduled ${moved.booking.id}`,
        contact_id: contactA,
      }),
      expect.objectContaining({
        subject: `E2E booking.canceled ${moved.booking.id}`,
        contact_id: contactA,
      }),
    ]);
    expect(await notes(orgIds.b)).toEqual([
      expect.objectContaining({
        subject: `E2E booking.created ${createdB.booking.id}`,
        contact_id: contactB,
      }),
    ]);

    const everything = JSON.stringify([runsA, runsB, await notes(orgIds.a), await notes(orgIds.b)]);
    expect(everything).not.toContain(secret);
  });

  it("redelivering every job (a queue retry) adds no run and no note", async () => {
    const before = [
      await runs(orgIds.a),
      await runs(orgIds.b),
      await notes(orgIds.a),
      await notes(orgIds.b),
    ];
    expect(holder.delivered).toHaveLength(4);
    holder.jobs.push(...holder.delivered.map((payload) => ({ job: "run-workflow", payload })));
    await drainJobs();
    const after = [
      await runs(orgIds.a),
      await runs(orgIds.b),
      await notes(orgIds.a),
      await notes(orgIds.b),
    ];
    expect(after).toEqual(before);
  });

  it("cleanup removes the journey's data and keeps the fixture", async () => {
    fixture("cleanup");
    const [left] = await db.$queryRawUnsafe<
      Array<{ runs: number; notes: number; bookings: number; contacts: number; workflows: number }>
    >(
      `select
         (select count(*)::int from workflow_runs r join organizations o on o.id = r.organization_id where o.slug like 'syveka-e2e-booking-%') as runs,
         (select count(*)::int from activities a join organizations o on o.id = a.organization_id where o.slug like 'syveka-e2e-booking-%') as notes,
         (select count(*)::int from bookings b join organizations o on o.id = b.organization_id where o.slug like 'syveka-e2e-booking-%') as bookings,
         (select count(*)::int from contacts c join organizations o on o.id = c.organization_id where o.slug like 'syveka-e2e-booking-%') as contacts,
         (select count(*)::int from workflows w join organizations o on o.id = w.organization_id where o.slug like 'syveka-e2e-booking-%') as workflows`,
    );
    expect(left).toEqual({ runs: 0, notes: 0, bookings: 0, contacts: 0, workflows: 6 });
  });
});
