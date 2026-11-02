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
 * resume, step ledger and failure record run on the database, and the real
 * QStash signature check runs (test-only keys). Only external providers,
 * plan entitlements and feature flags are mocked. Faults are injected where
 * they happen:
 *
 * - a notification insert refused by a PostgreSQL trigger (a control table
 *   names the workflows it refuses);
 * - at the Prisma client boundary: a transaction that commits but whose
 *   client gets an error, a transaction that fails before it starts, and a
 *   query error in the contact lookup (the pool itself stays healthy);
 * - after an enqueue fails: the next transactions failing, or the database
 *   unreachable for every query until the test brings it back.
 *
 * Concurrency is controlled with barriers: deliveries start one after another
 * (the route loads its modules per request, and simultaneous first loads race
 * vitest's module mocks), are held at a chosen claim, and released together.
 * That proves contention at that claim; it does not reproduce every
 * interleaving of real parallel requests.
 *
 * Skipped unless WORKFLOW_PG_URL points at a local scratch database prepared
 * as in CI (tests/migrations/supabase-compatibility.sql, then `prisma migrate
 * deploy`); it refuses any non-local URL. It adds a test trigger, function
 * and table, dropped afterwards. Not wired into CI yet (protected ci.yml
 * change).
 */
const PG_URL = process.env.WORKFLOW_PG_URL;

type AnyClient = Record<string | symbol, unknown> & {
  $transaction: (fn: unknown, opts?: unknown) => Promise<unknown>;
  $disconnect: () => Promise<void>;
};
type Barrier = {
  on: "workflowRun" | "workflowStepExecution";
  method: "create" | "updateMany";
  arrived: number;
  release: Promise<void>;
};

const holder = vi.hoisted(() => ({
  client: undefined as unknown,
  /** The pilot's internal-only restriction (blocks email, AI and wait steps). */
  internalOnly: true,
  /** The next contact lookup throws a query error. */
  failNextContactLookup: false,
  /** Runs before the next contact lookup (to change the database meanwhile). */
  beforeContactLookup: null as null | (() => Promise<void>),
  /** The next transaction commits, then the client reports an error. */
  errorAfterNextCommit: false,
  /** The next transaction fails before it starts (nothing commits). */
  failNextTransaction: false,
  /** This many next transactions fail before they start. */
  failTransactions: 0,
  /** Every query fails, as when the database is unreachable. */
  databaseDown: false,
  /** Runs when an enqueue fails (to fail the database writes that follow). */
  onEnqueueFailure: null as null | (() => void),
  /** Runs when an enqueue succeeds (to lose the completion write after it). */
  onEnqueueSuccess: null as null | (() => void),
  /** Each enqueue's deduplicationId. */
  deduplicationIds: [] as Array<string | undefined>,
  failNextUsage: false,
  failNextEnqueue: false,
  enqueued: 0,
  emailsSent: 0,
  contactLookups: 0,
  barrier: null as null | {
    on: "workflowRun" | "workflowStepExecution";
    method: "create" | "updateMany";
    arrived: number;
    release: Promise<void>;
  },
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
  isRestrictionSet: vi.fn(async () => holder.internalOnly),
}));
vi.mock("@/server/jobs/queue", () => ({
  enqueue: vi.fn(async (_job: string, _payload: unknown, opts?: { deduplicationId?: string }) => {
    if (holder.failNextEnqueue) {
      holder.failNextEnqueue = false;
      holder.onEnqueueFailure?.();
      throw new Error("QStash unavailable");
    }
    holder.enqueued += 1;
    holder.deduplicationIds.push(opts?.deduplicationId);
    holder.onEnqueueSuccess?.();
  }),
}));
vi.mock("@/server/integrations/anthropic", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));
vi.mock("@/server/ai/router", () => ({ routeModel: () => ({ model: "m", maxTokens: 1 }) }));
vi.mock("@/server/integrations/resend", () => ({
  sendEmail: vi.fn(async () => {
    holder.emailsSent += 1;
  }),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  recordUsage: vi.fn(async () => {
    if (holder.failNextUsage) {
      holder.failNextUsage = false;
      throw new Error("usage write failed");
    }
  }),
  getEntitlements: async () => ({ readOnly: false, activeWorkflows: 1 }),
}));
vi.mock("@/server/services/ai-spend", () => ({
  assertAiQuotaAvailable: async () => undefined,
  AiSpendError: class extends Error {},
}));
vi.mock("../../emails/workflow-notification", () => ({ WorkflowNotificationEmail: () => null }));

import {
  CONTACT_NOT_FOUND_ERROR,
  INVALID_RECIPIENT_ERROR_PREFIX,
  isTerminalRunError,
} from "@/lib/workflows/run-failure";

type Pg = {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

const CRM_STEP = {
  id: "s1",
  type: "crm.create_activity",
  contactIdVar: "trigger.contactId",
  activityType: "TASK",
  subject: "Pilot workflow activity test",
};
const WAIT_STEP = { id: "w1", type: "wait.duration", seconds: 60 };
/** Activity, wait, activity: what a recovered run must do exactly once each. */
const AROUND_A_WAIT = [CRM_STEP, WAIT_STEP, { ...CRM_STEP, id: "s2" }];
/** The step and run claims' stale window, in seconds. */
const STALE_SECONDS = 360;

/** A 409 telling QStash to deliver again just after `seconds` from now. */
function expectRetryAfter(res: Response, seconds: number) {
  expect(res.status).toBe(409);
  const retryAfter = Number(res.headers.get("retry-after"));
  expect(retryAfter).toBeGreaterThan(seconds - 30);
  expect(retryAfter).toBeLessThanOrEqual(seconds + 10);
}

describe.skipIf(!PG_URL)("run-workflow job on PostgreSQL", () => {
  let real: AnyClient;
  let sql: Pg;
  let POST: (req: Request) => Promise<Response>;
  const createdOrgs: string[] = [];
  const createdUsers: string[] = [];

  /** One organization per test, with a creator, a contact and an active workflow. */
  async function fixture(
    opts: { creatorIsMember?: boolean; notificationFails?: boolean; steps?: unknown[] } = {},
  ) {
    const orgId = randomUUID();
    const creatorId = randomUUID();
    const contactId = randomUUID();
    const workflowId = randomUUID();
    const workflowName = `pg-run-${workflowId}`;
    createdOrgs.push(orgId);
    createdUsers.push(creatorId);
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
        JSON.stringify(opts.steps ?? [CRM_STEP]),
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
    /** Each step's ledger status, by step id. */
    const steps = async () =>
      Object.fromEntries(
        (
          await sql.query(
            `select step_id, status::text as status from workflow_step_executions where organization_id = $1`,
            [orgId],
          )
        ).rows.map((r) => [r.step_id, r.status]),
      );
    /** Lets time pass for the step claims: all move back together. */
    const passTime = (minutes: number) =>
      sql.query(
        `update workflow_step_executions set started_at = started_at - make_interval(mins => $2)
         where organization_id = $1`,
        [orgId, minutes],
      );
    /** The resume message the job enqueues for a run parked on a wait. */
    const resume = (runId: string, resumeFromIndex: number) => ({
      triggerType: "contact.created",
      triggerData: { contactId },
      runId,
      resumeFromIndex,
    });
    const manualRun = async (triggerData: Record<string, unknown>) => {
      const runId = randomUUID();
      await sql.query(
        `insert into workflow_runs (id, workflow_id, organization_id, status, trigger_data) values ($1, $2, $3, 'RUNNING', $4)`,
        [runId, workflowId, orgId, JSON.stringify(triggerData)],
      );
      return { triggerType: "manual", triggerData, runId, resumeFromIndex: 0 };
    };
    return {
      orgId,
      creatorId,
      contactId,
      workflowId,
      workflowName,
      deliver,
      event,
      count,
      runs,
      steps,
      passTime,
      resume,
      manualRun,
    };
  }

  /** Wraps one model's create or updateMany so the active barrier can hold it. */
  const heldCreate = (model: Barrier["on"], delegate: Record<string, unknown>) =>
    new Proxy(delegate, {
      get(d, p, r) {
        const barrier = holder.barrier;
        if (barrier?.on !== model || p !== barrier.method) return Reflect.get(d, p, r);
        return async (args: unknown) => {
          barrier.arrived += 1;
          await barrier.release;
          return (d[p] as (a: unknown) => Promise<unknown>)(args);
        };
      },
    });

  beforeAll(async () => {
    if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(PG_URL!)) {
      throw new Error("WORKFLOW_PG_URL must point at a local scratch database");
    }
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
        if (holder.databaseDown) {
          const unreachable = async () => {
            throw Object.assign(new Error("Can't reach database server"), {
              name: "DriverAdapterError",
            });
          };
          return prop === "$transaction" ? unreachable : new Proxy({}, { get: () => unreachable });
        }
        if (prop === "contact") {
          const contact = Reflect.get(target, prop, receiver) as Record<string, unknown>;
          return new Proxy(contact, {
            get(c, p, r) {
              if (p !== "findFirst") return Reflect.get(c, p, r);
              return async (args: unknown) => {
                holder.contactLookups += 1;
                const before = holder.beforeContactLookup;
                holder.beforeContactLookup = null;
                if (before) await before();
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
        if (prop === "workflowRun" || prop === "workflowStepExecution") {
          return heldCreate(prop, Reflect.get(target, prop, receiver) as Record<string, unknown>);
        }
        if (prop === "$transaction") {
          return async (fn: unknown, opts?: unknown) => {
            if (holder.failNextTransaction || holder.failTransactions > 0) {
              holder.failNextTransaction = false;
              holder.failTransactions = Math.max(0, holder.failTransactions - 1);
              throw new Error("Transaction API error: could not start a transaction");
            }
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
    // Only what this suite created; organizations cascade to their rows.
    await sql.query(`delete from organizations where id = any($1::uuid[])`, [createdOrgs]);
    await sql.query(`delete from users where id = any($1::uuid[])`, [createdUsers]);
    await sql.end();
    await real.$disconnect();
  });

  /**
   * Starts n deliveries one after another, holds each at the given model's
   * create (the run claim or the step claim) or updateMany (the run reclaim),
   * runs `meanwhile` once all n are waiting there, then releases them
   * together. A delivery that finishes without reaching that call fails the
   * test at once (and leaves no wait behind for later tests).
   */
  async function atTheSameClaim(
    on: Barrier["on"],
    n: number,
    start: () => Promise<Response>,
    method: Barrier["method"] = "create",
    meanwhile?: () => Promise<void>,
  ): Promise<Response[]> {
    let release!: () => void;
    const barrier: Barrier = {
      on,
      method,
      arrived: 0,
      release: new Promise<void>((r) => (release = r)),
    };
    holder.barrier = barrier;
    const pending: Array<Promise<Response>> = [];
    try {
      for (let i = 1; i <= n; i++) {
        const started = start();
        pending.push(started);
        const arrived = await Promise.race([
          vi.waitFor(() => expect(barrier.arrived).toBe(i), { timeout: 10_000 }).then(() => true),
          started.then(() => false),
        ]);
        if (!arrived) throw new Error(`delivery ${i} finished without reaching ${on}.${method}`);
      }
    } finally {
      holder.barrier = null; // later calls (redeliveries) aren't held
    }
    await meanwhile?.();
    release();
    return Promise.all(pending);
  }

  beforeEach(() => {
    Object.assign(holder, {
      internalOnly: true,
      failNextContactLookup: false,
      beforeContactLookup: null,
      errorAfterNextCommit: false,
      failNextTransaction: false,
      failTransactions: 0,
      databaseDown: false,
      onEnqueueFailure: null,
      onEnqueueSuccess: null,
      deduplicationIds: [],
      failNextUsage: false,
      failNextEnqueue: false,
      enqueued: 0,
      emailsSent: 0,
      contactLookups: 0,
      barrier: null,
    });
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
    const payload = await f.manualRun({ test: true, triggeredBy: f.creatorId });
    expect((await f.deliver(payload)).status).toBe(200);
    const again = await f.deliver(payload, "1");
    expect(await again.json()).toEqual({ skipped: "terminal_failure" });
    expect((await f.runs())[0]!.status).toBe("FAILED");
    expect(isTerminalRunError((await f.runs())[0]!.error)).toBe(true);
    expect(await f.count("workflow_step_executions")).toBe(1);
    expect(await f.count("notifications")).toBe(1);
  });

  it("an invalid recipient is terminal: nothing is sent, the creator is told once", async () => {
    holder.internalOnly = false;
    const f = await fixture({
      steps: [{ id: "e1", type: "email.send", to: "not-an-address", subject: "Hi", body: "Hi" }],
    });
    const missing = randomUUID();
    expect((await f.deliver(f.event(missing))).status).toBe(200);
    const [run] = await f.runs();
    expect(run!.status).toBe("FAILED");
    expect(run!.error!.startsWith(INVALID_RECIPIENT_ERROR_PREFIX)).toBe(true);
    expect(await (await f.deliver(f.event(missing), "1")).json()).toEqual({
      skipped: "terminal_failure",
    });
    expect(holder.emailsSent).toBe(0);
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

  it("a step whose transaction committed although the client got an error is not run again", async () => {
    const f = await fixture();
    // The contact exists, so the next transaction is the step's own (the
    // activity and its SUCCEEDED ledger row).
    holder.errorAfterNextCommit = true;
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    expect(await f.count("activities")).toBe(1);
    const retry = await f.deliver(f.event(f.contactId), "1");
    expect(await retry.json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(1); // the step was skipped, not repeated
    expect(await f.count("notifications")).toBe(0);
  });

  it("a transient query error stays retryable: the redelivery succeeds with one activity and no notification", async () => {
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

  it("a final attempt's transient failure is recorded retryable and its creator told once", async () => {
    const f = await fixture();
    holder.failNextContactLookup = true;
    expect((await f.deliver(f.event(f.contactId), "3")).status).toBe(500);
    const [run] = await f.runs();
    expect(run!.status).toBe("FAILED");
    expect(isTerminalRunError(run!.error)).toBe(false);
    expect(await f.count("notifications")).toBe(1);
  });

  it("a final attempt whose failure record can't be written still tells the creator, once", async () => {
    const f = await fixture();
    holder.failNextContactLookup = true;
    holder.failNextTransaction = true; // the failure record; the fallback then succeeds
    expect((await f.deliver(f.event(f.contactId), "3")).status).toBe(500);
    const [run] = await f.runs();
    expect(run!.status).toBe("FAILED");
    expect(run!.error).toMatch(/^failure not recorded \(/);
    expect(await f.count("notifications")).toBe(1);
  });

  it("a creator who is no longer a member is not told; the run still fails", async () => {
    const former = await fixture({ creatorIsMember: false });
    expect((await former.deliver(former.event(randomUUID()))).status).toBe(200);
    expect(await former.runs()).toMatchObject([
      { status: "FAILED", error: CONTACT_NOT_FOUND_ERROR },
    ]);
    expect(await former.count("notifications")).toBe(0);
  });

  it("a run waiting on a resume whose enqueue and failure record both fail is recovered by the redelivery", async () => {
    holder.internalOnly = false;
    const f = await fixture({
      steps: [{ id: "w1", type: "wait.duration", seconds: 60 }, CRM_STEP],
    });
    holder.failNextEnqueue = true;
    holder.failNextTransaction = true; // the failure record; the fallback then succeeds
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    // Not left WAITING without a scheduled resume: failed, and retryable.
    const [run] = await f.runs();
    expect(run!.status).toBe("FAILED");
    expect(isTerminalRunError(run!.error)).toBe(false);
    const retry = await f.deliver(f.event(f.contactId), "1");
    expect(await retry.json()).toMatchObject({ ok: true, waiting: 60 });
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);
    expect(holder.enqueued).toBe(1);
  });

  it("a fresh-event run left WAITING with nothing recorded is reclaimed once its wait claim is stale", async () => {
    holder.internalOnly = false;
    const f = await fixture({ steps: AROUND_A_WAIT });
    // The resume can't be enqueued, and then the database is unreachable: the
    // wait step can't be failed and the run's failure can't be recorded.
    holder.failNextEnqueue = true;
    holder.onEnqueueFailure = () => (holder.databaseDown = true);
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    holder.databaseDown = false;
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);
    expect(await f.steps()).toEqual({ s1: "SUCCEEDED", w1: "CLAIMED" });

    // The redelivery can't tell yet whether that worker is alive: QStash is
    // told to come back just after the claim goes stale, not acknowledged.
    expectRetryAfter(await f.deliver(f.event(f.contactId), "1"), STALE_SECONDS);
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);

    await f.passTime(7);
    const recovered = await f.deliver(f.event(f.contactId), "2");
    expect(await recovered.json()).toMatchObject({ ok: true, waiting: 60 });
    expect(holder.enqueued).toBe(1);
    expect(await f.count("activities")).toBe(1);
    expect(await f.steps()).toEqual({ s1: "SUCCEEDED", w1: "SUCCEEDED" });

    const [run] = await f.runs();
    expect(await (await f.deliver(f.resume(run!.id, 2))).json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(2);
    expect(await f.count("notifications")).toBe(0);

    // A later delivery of the event changes nothing.
    expect(await (await f.deliver(f.event(f.contactId), "3")).json()).toEqual({
      skipped: "duplicate_trigger",
      duplicate: true,
    });
    expect(holder.enqueued).toBe(1);
    expect(await f.count("activities")).toBe(2);
  });

  it("a fresh-event run left WAITING with its wait step failed is reclaimed by the next redelivery", async () => {
    holder.internalOnly = false;
    const f = await fixture({ steps: AROUND_A_WAIT });
    holder.failNextEnqueue = true;
    holder.onEnqueueFailure = () => (holder.failTransactions = 2); // the record and its fallback
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);
    expect(await f.steps()).toEqual({ s1: "SUCCEEDED", w1: "FAILED" });

    const recovered = await f.deliver(f.event(f.contactId), "1");
    expect(await recovered.json()).toMatchObject({ ok: true, waiting: 60 });
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);
    expect(holder.enqueued).toBe(1);
    expect(await f.count("activities")).toBe(1);
    expect(await f.count("notifications")).toBe(0);
  });

  it("two redeliveries of a WAITING run with no resume, released together at the run reclaim, enqueue one resume", async () => {
    holder.internalOnly = false;
    const f = await fixture({ steps: AROUND_A_WAIT });
    holder.failNextEnqueue = true;
    holder.onEnqueueFailure = () => (holder.failTransactions = 2);
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);

    const responses = await atTheSameClaim(
      "workflowRun",
      2,
      () => f.deliver(f.event(f.contactId), "1"),
      "updateMany",
    );
    for (const res of responses) expect([200, 409]).toContain(res.status);
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies.filter((b) => b.waiting === 60)).toHaveLength(1);
    expect(holder.enqueued).toBe(1);
    expect(await f.steps()).toEqual({ s1: "SUCCEEDED", w1: "SUCCEEDED" });
    expect(await f.count("activities")).toBe(1);
    expect(await f.count("notifications")).toBe(0);
    // The loser's redelivery finds the resume scheduled.
    expect(await (await f.deliver(f.event(f.contactId), "2")).json()).toEqual({
      skipped: "duplicate_trigger",
      duplicate: false,
    });
    expect(holder.enqueued).toBe(1);
  });

  it("a resume enqueued whose wait completion was lost is enqueued again under the same deduplicationId", async () => {
    holder.internalOnly = false;
    const f = await fixture({ steps: AROUND_A_WAIT });
    // The resume is enqueued, then the database is unreachable: the wait step
    // stays CLAIMED although its resume is scheduled.
    holder.onEnqueueSuccess = () => (holder.databaseDown = true);
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    holder.databaseDown = false;
    holder.onEnqueueSuccess = null;
    expect(await f.steps()).toEqual({ s1: "SUCCEEDED", w1: "CLAIMED" });

    expectRetryAfter(await f.deliver(f.event(f.contactId), "1"), STALE_SECONDS);
    await f.passTime(7);
    expect(await (await f.deliver(f.event(f.contactId), "2")).json()).toMatchObject({
      waiting: 60,
    });
    // The same resume again: QStash keeps one of the two (deduplication).
    const [run] = await f.runs();
    expect(holder.deduplicationIds).toEqual([
      `workflow-resume:${run!.id}:w1`,
      `workflow-resume:${run!.id}:w1`,
    ]);
    expect(await f.count("activities")).toBe(1);

    expect(await (await f.deliver(f.resume(run!.id, 2))).json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(2);
    expect(await f.count("notifications")).toBe(0);
  });

  it("a stale claim left behind on an earlier wait doesn't reclaim a run its resume moved on", async () => {
    holder.internalOnly = false;
    const f = await fixture({
      steps: [...AROUND_A_WAIT, { ...WAIT_STEP, id: "w2" }, { ...CRM_STEP, id: "s3" }],
    });
    holder.onEnqueueSuccess = () => (holder.databaseDown = true);
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    holder.databaseDown = false;
    holder.onEnqueueSuccess = null;
    const [run] = await f.runs();
    // The scheduled resume runs on and parks on the second wait.
    expect(await (await f.deliver(f.resume(run!.id, 2))).json()).toMatchObject({ waiting: 60 });
    await f.passTime(7);
    expect(await f.steps()).toEqual({
      s1: "SUCCEEDED",
      w1: "CLAIMED",
      s2: "SUCCEEDED",
      w2: "SUCCEEDED",
    });

    expect(await (await f.deliver(f.event(f.contactId), "1")).json()).toEqual({
      skipped: "duplicate_trigger",
      duplicate: false,
    });
    expect(holder.enqueued).toBe(2);
    const stored = await sql.query(`select step_results from workflow_runs where id = $1`, [
      run!.id,
    ]);
    expect(stored.rows[0]!.step_results).toEqual(
      expect.arrayContaining([expect.objectContaining({ stepId: "s2", status: "ok" })]),
    );

    expect(await (await f.deliver(f.resume(run!.id, 4))).json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(3);
  });

  it("an unfinished claim past the first wait is left to the resume message, not the event", async () => {
    holder.internalOnly = false;
    const f = await fixture({
      steps: [...AROUND_A_WAIT, { ...WAIT_STEP, id: "w2" }, { ...CRM_STEP, id: "s3" }],
    });
    expect(await (await f.deliver(f.event(f.contactId))).json()).toMatchObject({ waiting: 60 });
    const [run] = await f.runs();
    // The resume can't enqueue the second wait's resume, and nothing is recorded
    // but the wait step's failure.
    holder.failNextEnqueue = true;
    holder.onEnqueueFailure = () => (holder.failTransactions = 2);
    expect((await f.deliver(f.resume(run!.id, 2))).status).toBe(500);
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);
    expect(await f.steps()).toMatchObject({ s2: "SUCCEEDED", w2: "FAILED" });

    // A duplicate of the original event can't recover that part: acknowledged,
    // the run and its results untouched.
    expect(await (await f.deliver(f.event(f.contactId), "1")).json()).toEqual({
      skipped: "duplicate_trigger",
      duplicate: false,
    });
    expect(await f.runs()).toMatchObject([{ status: "WAITING" }]);
    const stored = await sql.query(`select step_results from workflow_runs where id = $1`, [
      run!.id,
    ]);
    expect(stored.rows[0]!.step_results).toEqual(
      expect.arrayContaining([expect.objectContaining({ stepId: "s2", status: "ok" })]),
    );
    expect(holder.enqueued).toBe(1);

    // The resume message's own redelivery recovers it.
    expect(await (await f.deliver(f.resume(run!.id, 2), "1")).json()).toMatchObject({
      waiting: 60,
    });
    expect(holder.enqueued).toBe(2);
    expect(await (await f.deliver(f.resume(run!.id, 4))).json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(3);
    expect(await f.count("notifications")).toBe(0);
  });

  it("a WAITING run a resume takes between the read and the reclaim is not reclaimed", async () => {
    holder.internalOnly = false;
    const f = await fixture({ steps: AROUND_A_WAIT });
    holder.failNextEnqueue = true;
    holder.onEnqueueFailure = () => (holder.failTransactions = 2);
    expect((await f.deliver(f.event(f.contactId))).status).toBe(500);
    // A resumed run keeps its first start time, here past the stale window.
    await sql.query(
      `update workflow_runs set started_at = started_at - interval '10 minutes' where organization_id = $1`,
      [f.orgId],
    );
    const before = (
      await sql.query(`select started_at from workflow_runs where organization_id = $1`, [f.orgId])
    ).rows[0]!.started_at;

    // Held at the reclaim; meanwhile a resume of this run sets it RUNNING
    // (its start time unchanged).
    const [res] = await atTheSameClaim(
      "workflowRun",
      1,
      () => f.deliver(f.event(f.contactId), "1"),
      "updateMany",
      async () => {
        await sql.query(`update workflow_runs set status = 'RUNNING' where organization_id = $1`, [
          f.orgId,
        ]);
      },
    );

    expectRetryAfter(res!, STALE_SECONDS);
    const after = (
      await sql.query(
        `select status::text as status, started_at from workflow_runs where organization_id = $1`,
        [f.orgId],
      )
    ).rows[0]!;
    expect(after.status).toBe("RUNNING");
    expect(after.started_at).toEqual(before);
    expect(holder.enqueued).toBe(0);
    expect(await f.count("activities")).toBe(1);
  });

  it("a run left WAITING by a resume whose enqueue and records failed is recovered by that resume's redelivery", async () => {
    holder.internalOnly = false;
    const f = await fixture({
      steps: [...AROUND_A_WAIT, { ...WAIT_STEP, id: "w2" }, { ...CRM_STEP, id: "s3" }],
    });
    expect(await (await f.deliver(f.event(f.contactId))).json()).toMatchObject({ waiting: 60 });
    const [run] = await f.runs();
    holder.failNextEnqueue = true;
    holder.onEnqueueFailure = () => (holder.databaseDown = true);
    expect((await f.deliver(f.resume(run!.id, 2))).status).toBe(500);
    holder.databaseDown = false;
    expect(await f.steps()).toMatchObject({ s2: "SUCCEEDED", w2: "CLAIMED" });

    const early = await f.deliver(f.resume(run!.id, 2), "1");
    expectRetryAfter(early, STALE_SECONDS);
    expect(await early.json()).toEqual({ error: "step_in_progress", stepId: "w2" });

    await f.passTime(7);
    const recovered = await f.deliver(f.resume(run!.id, 2), "2");
    expect(await recovered.json()).toMatchObject({ ok: true, waiting: 60 });
    expect(holder.enqueued).toBe(2);
    expect(await f.count("activities")).toBe(2);

    expect(await (await f.deliver(f.resume(run!.id, 4))).json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(3);
    expect(await f.count("notifications")).toBe(0);
  });

  it("a delivery finding the event's run RUNNING within the stale window is retried just after it", async () => {
    const f = await fixture();
    await sql.query(
      `insert into workflow_runs (workflow_id, organization_id, status, trigger_data, source_event_key, started_at)
       values ($1, $2, 'RUNNING', '{}', $3, now() - interval '5 minutes')`,
      [f.workflowId, f.orgId, f.event(f.contactId).sourceEventKey],
    );
    expectRetryAfter(await f.deliver(f.event(f.contactId), "1"), STALE_SECONDS - 300);
    expect(await f.count("activities")).toBe(0);
  });

  it("a WAITING run whose resume is scheduled is only acknowledged by a redelivery", async () => {
    holder.internalOnly = false;
    const f = await fixture({ steps: AROUND_A_WAIT });
    expect(await (await f.deliver(f.event(f.contactId))).json()).toMatchObject({ waiting: 60 });
    expect(await (await f.deliver(f.event(f.contactId), "1")).json()).toEqual({
      skipped: "duplicate_trigger",
      duplicate: false,
    });
    expect(holder.enqueued).toBe(1);
    expect(await f.count("activities")).toBe(1);
    expect(await f.steps()).toEqual({ s1: "SUCCEEDED", w1: "SUCCEEDED" });
  });

  it("a usage write that fails after success leaves the run SUCCEEDED and tells no one", async () => {
    const f = await fixture();
    holder.failNextUsage = true;
    expect(await (await f.deliver(f.event(f.contactId))).json()).toEqual({ ok: true });
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("notifications")).toBe(0);
  });

  it("a run reclaimed by another delivery meanwhile is not overwritten by this one's failure", async () => {
    const f = await fixture();
    // While this delivery looks the contact up, another one reclaims the run
    // (a new claim time).
    holder.beforeContactLookup = async () => {
      await sql.query(
        `update workflow_runs set started_at = started_at + interval '1 second' where organization_id = $1`,
        [f.orgId],
      );
    };
    const res = await f.deliver(f.event(randomUUID()));
    expect(await res.json()).toEqual({ skipped: "run_superseded" });
    expect(await f.runs()).toMatchObject([{ status: "RUNNING", error: null }]);
    expect(await f.count("notifications")).toBe(0);
  });

  it("five deliveries of one terminal event released together at the run claim: one run, one step, one notification", async () => {
    const f = await fixture();
    const missing = randomUUID();
    const responses = await atTheSameClaim("workflowRun", 5, () => f.deliver(f.event(missing)));
    // Losers see the run in progress (409, delivered again later) or already terminal.
    for (const res of responses) expect([200, 409]).toContain(res.status);
    expect(responses.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
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

  it("five deliveries of one successful event released together at the run claim create one activity", async () => {
    const f = await fixture();
    const responses = await atTheSameClaim("workflowRun", 5, () => f.deliver(f.event(f.contactId)));
    for (const res of responses) expect([200, 409]).toContain(res.status);
    expect(await f.runs()).toMatchObject([{ status: "SUCCEEDED" }]);
    expect(await f.count("activities")).toBe(1);
    expect(await f.count("notifications")).toBe(0);
  });

  it("two resume deliveries of one runId released together at the step claim create one activity", async () => {
    const f = await fixture();
    const payload = await f.manualRun({ contactId: f.contactId });
    const responses = await atTheSameClaim("workflowStepExecution", 2, () => f.deliver(payload));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await f.count("activities")).toBe(1);
    expect(await f.count("workflow_step_executions")).toBe(1);
  });

  it("a runId of another organization's run is not resumed and changes nothing there", async () => {
    const mine = await fixture();
    const theirs = await fixture();
    const runId = randomUUID();
    await sql.query(
      `insert into workflow_runs (id, workflow_id, organization_id, status, trigger_data) values ($1, $2, $3, 'FAILED', '{}')`,
      [runId, theirs.workflowId, theirs.orgId],
    );
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
