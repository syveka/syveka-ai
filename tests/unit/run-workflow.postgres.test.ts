import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, createHmac, randomUUID } from "node:crypto";

const JOB_URL = "https://example.test/api/v1/jobs/run-workflow";

/** A QStash-style signature (HS256 JWT, issuer Upstash, URL and body hash). */
function signed(body: string): string {
  const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = b64(
    JSON.stringify({
      iss: "Upstash",
      sub: JOB_URL,
      iat: now,
      nbf: now - 5,
      exp: now + 300,
      jti: randomUUID(),
      body: createHash("sha256").update(body).digest("base64url"),
    }),
  );
  const signature = createHmac("sha256", "test-only-current-signing-key")
    .update(`${header}.${claims}`)
    .digest("base64url");
  return `${header}.${claims}.${signature}`;
}

/**
 * The run-workflow job route against real PostgreSQL: its claim, reclaim,
 * resume, step ledger and failure record run on the database; only the queue
 * signature, external providers, plan entitlements and feature flags are
 * mocked. Faults are injected where they really happen:
 *
 * - a notification insert that fails: a PostgreSQL trigger, switched on per
 *   workflow through a control table;
 * - a commit whose success the client never learns, and a transient
 *   database error in the contact lookup: at the Prisma client boundary.
 *
 * Skipped unless WORKFLOW_PG_URL points at a scratch database prepared as in
 * CI (tests/migrations/supabase-compatibility.sql, then `prisma migrate
 * deploy`). Each test uses its own organization; the trigger, its function
 * and the control table are created here and dropped afterwards.
 */
const PG_URL = process.env.WORKFLOW_PG_URL;

type AnyClient = Record<string | symbol, unknown> & {
  $transaction: (fn: unknown, opts?: unknown) => Promise<unknown>;
  $disconnect: () => Promise<void>;
};

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  /** The next contact lookup throws, like a dropped database connection. */
  failNextContactLookup: false,
  /** The next transaction commits, then the client reports an error. */
  errorAfterNextCommit: false,
  contactLookups: 0,
  /** Claims (fresh-run creates) held until the test releases them together. */
  claimBarrier: null as null | { arrived: number; release: Promise<void> },
}));

vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used by the job");
  },
}));
// The real QStash signature check runs, with test-only signing keys made up
// here: every delivery below is signed like QStash signs it (signed()).
vi.hoisted(() => {
  process.env.QSTASH_TOKEN = "test-only-token";
  process.env.QSTASH_CURRENT_SIGNING_KEY = "test-only-current-signing-key";
  process.env.QSTASH_NEXT_SIGNING_KEY = "test-only-next-signing-key";
  process.env.SKIP_ENV_VALIDATION = "1";
});
vi.mock("@/server/services/feature-flags", () => ({
  isFeatureEnabled: vi.fn(async () => false),
  // The pilot organization's internal-only restriction (crm.create_activity is allowed).
  isRestrictionSet: vi.fn(async () => true),
}));
vi.mock("@/server/jobs/queue", () => ({ enqueue: vi.fn(async () => undefined) }));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({ sendEmail: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: vi.fn(async () => undefined),
  getEntitlements: async () => ({ readOnly: false, activeWorkflows: 1 }),
}));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: async () => undefined,
  AiSpendError: class extends Error {},
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

import { CONTACT_NOT_FOUND_ERROR, isTerminalRunError } from "@/lib/workflows/run-failure";

type Pg = {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

describe.skipIf(!PG_URL)("run-workflow job on PostgreSQL", () => {
  let real: AnyClient;
  let sql: Pg;
  let POST: (req: Request) => Promise<Response>;

  /** One organization per test, with a member creator, a contact and an active workflow. */
  async function fixture(opts: { creatorIsMember?: boolean; notificationFails?: boolean } = {}) {
    const orgId = randomUUID();
    const creatorId = randomUUID();
    const contactId = randomUUID();
    const workflowId = randomUUID();
    const workflowName = `pg-run-${workflowId}`;
    await sql.query(
      `insert into organizations (id, name, slug, updated_at) values ($1, $2, $3, now())`,
      [orgId, "Workflow PG test", `wf-pg-${orgId}`],
    );
    await sql.query(`insert into users (id, email, updated_at) values ($1, $2, now())`, [
      creatorId,
      `${creatorId}@example.test`,
    ]);
    if (opts.creatorIsMember !== false) {
      await sql.query(
        `insert into organization_members (organization_id, user_id, role) values ($1, $2, 'OWNER')`,
        [orgId, creatorId],
      );
    }
    await sql.query(
      `insert into contacts (id, organization_id, first_name, updated_at) values ($1, $2, 'Pilot', now())`,
      [contactId, orgId],
    );
    await sql.query(
      `insert into workflows (id, organization_id, created_by_id, name, trigger, steps, is_active, updated_at)
       values ($1, $2, $3, $4, $5, $6, true, now())`,
      [
        workflowId,
        orgId,
        creatorId,
        workflowName,
        JSON.stringify({ type: "contact.created" }),
        JSON.stringify([
          {
            id: "s1",
            type: "crm.create_activity",
            contactIdVar: "trigger.contactId",
            activityType: "TASK",
            subject: "Pilot workflow activity test",
          },
        ]),
      ],
    );
    if (opts.notificationFails) {
      await sql.query(`insert into test_failing_notification_titles (title) values ($1)`, [
        workflowName,
      ]);
    }
    const deliver = (payload: Record<string, unknown>, attempt = "0") => {
      const body = JSON.stringify({ workflowId, orgId, ...payload });
      return POST(
        new Request(JOB_URL, {
          method: "POST",
          headers: { "upstash-retried": attempt, "upstash-signature": signed(body) },
          body,
        }),
      );
    };
    const event = (id: string) => ({
      triggerType: "contact.created",
      triggerData: { contactId: id },
      sourceEventKey: `contact.created:${id}`,
    });
    const count = async (table: string) =>
      Number(
        (
          await sql.query(`select count(*)::int as n from ${table} where organization_id = $1`, [
            orgId,
          ])
        ).rows[0]!.n,
      );
    const runs = async () =>
      (
        await sql.query(
          `select id, status::text as status, error from workflow_runs where organization_id = $1 order by started_at`,
          [orgId],
        )
      ).rows as Array<{ id: string; status: string; error: string | null }>;
    return { orgId, creatorId, contactId, workflowId, workflowName, deliver, event, count, runs };
  }

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }, pg] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
      import("pg"),
    ]);
    real = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 8 }),
    }) as unknown as AnyClient;
    // The client the route sees: the real one, with faults injected at its
    // boundary only when a test asks for them.
    holder.client = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "contact") {
          const contact = Reflect.get(target, prop, receiver) as Record<string, unknown>;
          return new Proxy(contact, {
            get(c, p, r) {
              if (p !== "findFirst") return Reflect.get(c, p, r);
              return async (args: unknown) => {
                holder.contactLookups += 1;
                if (holder.failNextContactLookup) {
                  holder.failNextContactLookup = false;
                  throw Object.assign(new Error("Connection terminated unexpectedly"), {
                    name: "DriverAdapterError",
                  });
                }
                return (c.findFirst as (a: unknown) => Promise<unknown>)(args);
              };
            },
          });
        }
        if (prop === "workflowRun") {
          const runs = Reflect.get(target, prop, receiver) as Record<string, unknown>;
          return new Proxy(runs, {
            get(r, p, rec) {
              if (p !== "create" || !holder.claimBarrier) return Reflect.get(r, p, rec);
              return async (args: unknown) => {
                const barrier = holder.claimBarrier!;
                barrier.arrived += 1;
                await barrier.release;
                return (r.create as (a: unknown) => Promise<unknown>)(args);
              };
            },
          });
        }
        if (prop === "$transaction") {
          return async (fn: unknown, opts?: unknown) => {
            const result = await target.$transaction(fn, opts);
            if (holder.errorAfterNextCommit) {
              holder.errorAfterNextCommit = false;
              throw new Error("Connection lost after COMMIT");
            }
            return result;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    sql = new (pg.default ?? pg).Client({
      connectionString: PG_URL,
    } as never) as unknown as Pg;
    await sql.connect();
    await sql.query(
      `create table if not exists test_failing_notification_titles (title text primary key)`,
    );
    await sql.query(`
      create or replace function test_fail_notification() returns trigger language plpgsql as $$
      begin
        if exists (select 1 from test_failing_notification_titles where title = new.title) then
          raise exception 'test: notification insert refused';
        end if;
        return new;
      end $$`);
    await sql.query(`drop trigger if exists test_fail_notification on notifications`);
    await sql.query(
      `create trigger test_fail_notification before insert on notifications for each row execute function test_fail_notification()`,
    );
    await import("@/server/jobs/organization-guard");
    ({ POST } = (await import("@/app/api/v1/jobs/run-workflow/route")) as never);
    // An unsigned request is refused before anything is read or written.
    const unsigned = await POST(new Request(JOB_URL, { method: "POST", body: "{}" }));
    expect(unsigned.status).toBe(401);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.query(`drop trigger if exists test_fail_notification on notifications`);
    await sql.query(`drop function if exists test_fail_notification()`);
    await sql.query(`drop table if exists test_failing_notification_titles`);
    await sql.query(`delete from organizations where slug like 'wf-pg-%'`);
    await sql.query(
      `delete from users where email like '%@example.test' and id not in (select user_id from organization_members)`,
    );
    await sql.end();
    await real.$disconnect();
  });

  /**
   * Starts n deliveries one after another (so the route's per-request module
   * loading never overlaps), holds each at its run claim, and releases them
   * together once all n are waiting there: they then race for the same claim.
   */
  async function atTheSameClaim(n: number, start: () => Promise<Response>) {
    let release!: () => void;
    holder.claimBarrier = { arrived: 0, release: new Promise<void>((r) => (release = r)) };
    const pending: Array<Promise<Response>> = [];
    for (let i = 1; i <= n; i++) {
      pending.push(start());
      await vi.waitFor(() => expect(holder.claimBarrier!.arrived).toBe(i), { timeout: 10_000 });
    }
    holder.claimBarrier = null; // later claims (redeliveries) aren't held
    release();
    return Promise.all(pending);
  }

  beforeEach(() => {
    holder.claimBarrier = null;
    holder.failNextContactLookup = false;
    holder.errorAfterNextCommit = false;
    holder.contactLookups = 0;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("a terminal event delivered again (same sourceEventKey) stays FAILED, runs once, notifies once", async () => {
    const f = await fixture();
    const missing = randomUUID();
    const first = await f.deliver(f.event(missing));
    expect(first.status).toBe(200);
    expect(await f.runs()).toMatchObject([{ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR }]);
    for (const attempt of ["0", "1", "2"]) {
      const again = await f.deliver(f.event(missing), attempt);
      expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    }
    expect(holder.contactLookups).toBe(1);
    expect(await f.count("workflow_step_executions")).toBe(1);
    expect(await f.count("notifications")).toBe(1);
    expect(await f.count("activities")).toBe(0);
  });

  it("a terminal manual run delivered again with its runId stays FAILED and notifies once", async () => {
    const f = await fixture();
    const runId = randomUUID();
    const triggerData = { test: true, triggeredBy: f.creatorId };
    await sql.query(
      `insert into workflow_runs (id, workflow_id, organization_id, status, trigger_data) values ($1, $2, $3, 'RUNNING', $4)`,
      [runId, f.workflowId, f.orgId, JSON.stringify(triggerData)],
    );
    const payload = { triggerType: "manual", triggerData, runId, resumeFromIndex: 0 };
    expect((await f.deliver(payload)).status).toBe(200);
    const again = await f.deliver(payload, "1");
    expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    expect((await f.runs())[0]!.status).toBe("FAILED");
    expect(isTerminalRunError((await f.runs())[0]!.error)).toBe(true);
    expect(await f.count("workflow_step_executions")).toBe(1);
    expect(await f.count("notifications")).toBe(1);
  });

  it("a notification insert that fails rolls back the terminal record; the redelivery records both once", async () => {
    const f = await fixture({ notificationFails: true });
    const missing = randomUUID();
    const first = await f.deliver(f.event(missing));
    expect(first.status).toBe(500);
    const [run] = await f.runs();
    // Neither the terminal error nor the notification is committed: the run
    // carries a retryable error instead.
    expect(run!.status).toBe("FAILED");
    expect(isTerminalRunError(run!.error)).toBe(false);
    expect(await f.count("notifications")).toBe(0);

    await sql.query(`delete from test_failing_notification_titles where title = $1`, [
      f.workflowName,
    ]);
    const retry = await f.deliver(f.event(missing), "1");
    expect(retry.status).toBe(200);
    expect(await f.runs()).toMatchObject([{ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR }]);
    expect(await f.count("notifications")).toBe(1);
    expect(holder.contactLookups).toBe(2); // the step ran again once, after the rollback
    expect(await (await f.deliver(f.event(missing), "2")).json()).toEqual({
      skipped: "terminal_failure",
    });
    expect(await f.count("notifications")).toBe(1);
  });

  it("a failure record that committed although the client got an error stays terminal: one notification", async () => {
    const f = await fixture();
    const missing = randomUUID();
    // The unknown contact fails before any step transaction, so the next
    // transaction is the failure record.
    holder.errorAfterNextCommit = true;
    expect((await f.deliver(f.event(missing))).status).toBe(500);
    expect(await f.runs()).toMatchObject([{ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR }]);
    expect(await f.count("notifications")).toBe(1);
    expect(await (await f.deliver(f.event(missing), "1")).json()).toEqual({
      skipped: "terminal_failure",
    });
    expect(holder.contactLookups).toBe(1);
    expect(await f.count("notifications")).toBe(1);
  });

  it("a transient database error stays retryable: the redelivery succeeds with one activity and no notification", async () => {
    const f = await fixture();
    holder.failNextContactLookup = true;
    const first = await f.deliver(f.event(f.contactId));
    expect(first.status).toBe(500);
    expect(isTerminalRunError((await f.runs())[0]!.error)).toBe(false);
    const retry = await f.deliver(f.event(f.contactId), "1");
    expect(await retry.json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(1);
    expect(await f.count("notifications")).toBe(0);
  });

  it("a final attempt's transient failure notifies its creator once; a non-member creator is not notified", async () => {
    const member = await fixture();
    holder.failNextContactLookup = true;
    expect((await member.deliver(member.event(member.contactId), "3")).status).toBe(500);
    expect(await member.count("notifications")).toBe(1);

    const former = await fixture({ creatorIsMember: false });
    expect((await former.deliver(former.event(randomUUID()))).status).toBe(200);
    expect(await former.runs()).toMatchObject([
      { status: "FAILED", error: CONTACT_NOT_FOUND_ERROR },
    ]);
    expect(await former.count("notifications")).toBe(0);
  });

  it("simultaneous deliveries of one terminal event: one run, one step execution, one notification", async () => {
    const f = await fixture();
    const missing = randomUUID();
    const responses = await atTheSameClaim(5, () => f.deliver(f.event(missing)));
    // Losers see the run in progress (409, delivered again later) or already terminal.
    for (const res of responses) expect([200, 409]).toContain(res.status);
    expect(await f.runs()).toMatchObject([{ status: "FAILED", error: CONTACT_NOT_FOUND_ERROR }]);
    expect(await f.count("workflow_step_executions")).toBe(1);
    expect(await f.count("notifications")).toBe(1);
    // The redeliveries QStash makes for the 409s change nothing.
    for (const res of responses.filter((r) => r.status === 409)) {
      void res;
      expect((await f.deliver(f.event(missing), "1")).status).toBe(200);
    }
    expect(await f.count("notifications")).toBe(1);
  });

  it("simultaneous deliveries of one successful event create exactly one activity", async () => {
    const f = await fixture();
    const responses = await atTheSameClaim(5, () => f.deliver(f.event(f.contactId)));
    for (const res of responses) expect([200, 409]).toContain(res.status);
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(1);
    expect(await f.count("notifications")).toBe(0);
  });

  it("a runId or workflow from another organization changes nothing there", async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const runId = randomUUID();
    await sql.query(
      `insert into workflow_runs (id, workflow_id, organization_id, status, trigger_data) values ($1, $2, $3, 'FAILED', '{}')`,
      [runId, theirs.workflowId, theirs.orgId],
    );
    // My workflow with their run id: not found for this workflow and org.
    const res = await mine.deliver({
      triggerType: "manual",
      triggerData: { contactId: mine.contactId },
      runId,
      resumeFromIndex: 0,
    });
    expect(await res.json()).toEqual({ skipped: "run not found for workflow" });
    expect(await theirs.runs()).toMatchObject([{ id: runId, status: "FAILED", error: null }]);
    expect(await theirs.count("activities")).toBe(0);
    expect(await theirs.count("notifications")).toBe(0);
    expect(await mine.count("workflow_runs")).toBe(0);
  });
});
