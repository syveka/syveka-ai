import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  CONTACT_MISSING_ERROR,
  CONTACT_MISSING_TEST_RUN_ERROR,
  CONTACT_NOT_FOUND_ERROR,
  INVALID_RECIPIENT_ERROR_PREFIX,
  isTerminalRunError,
  retryableFailedRunWhere,
} from "@/lib/workflows/run-failure";

/**
 * The run-workflow job's reclaim and resume conditions on real PostgreSQL:
 * SQL NULL semantics, agreement with isTerminalRunError(), the conditional
 * reclaim taken once, and reclaims blocked on a terminal failure's row lock
 * (proven with pg_blocking_pids against the holding transaction). The route
 * itself runs on PostgreSQL in run-workflow.postgres.test.ts. Not wired into
 * CI yet (protected ci.yml change): run it with WORKFLOW_PG_URL set.
 *
 * Skipped unless WORKFLOW_PG_URL points at a scratch database prepared as in
 * CI (tests/migrations/supabase-compatibility.sql, then `prisma migrate
 * deploy`). It creates its own organization, workflow and runs.
 */
const PG_URL = process.env.WORKFLOW_PG_URL;

type Run = { id: string; status: string; error: string | null };
type Where = Record<string, unknown>;
type Tx = {
  workflowRun: {
    update: (a: { where: Where; data: Where }) => Promise<Run>;
    updateMany: (a: { where: Where; data: Where }) => Promise<{ count: number }>;
  };
  notification: { create: (a: { data: Where }) => Promise<unknown> };
  $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
};
type Db = Tx & {
  $transaction: <T>(fn: (tx: Tx) => Promise<T>, opts?: object) => Promise<T>;
  organization: {
    create: (a: { data: Where }) => Promise<{ id: string }>;
    delete: (a: { where: Where }) => Promise<unknown>;
  };
  workflow: { create: (a: { data: Where }) => Promise<{ id: string }> };
  workflowRun: Tx["workflowRun"] & {
    create: (a: { data: Where }) => Promise<Run>;
    findMany: (a: { where: Where; select?: Where }) => Promise<Run[]>;
    findUniqueOrThrow: (a: { where: Where }) => Promise<Run>;
  };
  $disconnect: () => Promise<void>;
};

const INVALID_RECIPIENT = `${INVALID_RECIPIENT_ERROR_PREFIX} "not-an-address"`;
/** Every kind of stored error the job writes, plus edge cases. */
const ERRORS: Array<string | null> = [
  null,
  "",
  "step failed (DriverAdapterError)",
  "failure not recorded (PrismaClientKnownRequestError)",
  "email.send failed (EmailSendError)",
  CONTACT_MISSING_TEST_RUN_ERROR,
  CONTACT_MISSING_ERROR,
  CONTACT_NOT_FOUND_ERROR,
  INVALID_RECIPIENT,
  "ai_quota_exceeded",
  "step_not_allowed",
];

describe.skipIf(!PG_URL)("workflow run reclaim conditions on PostgreSQL", () => {
  let db: Db;
  let sql: {
    connect: () => Promise<void>;
    query: (q: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    end: () => Promise<void>;
  };
  let orgId: string;
  let workflowId: string;

  const createRun = (status: string, error: string | null, startedAt = new Date()) =>
    db.workflowRun.create({
      data: {
        organizationId: orgId,
        workflowId,
        status,
        error,
        triggerData: {},
        sourceEventKey: `test:${randomUUID()}`,
        startedAt,
      },
    });
  const reclaimWhere = (id: string): Where => ({
    id,
    OR: [retryableFailedRunWhere(), { status: "RUNNING", startedAt: { lt: new Date(0) } }],
  });

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }, pg] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
      import("pg"),
    ]);
    sql = new (pg.default ?? pg).Client({
      connectionString: PG_URL,
    } as never) as never;
    await sql.connect();
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 6 }),
    }) as unknown as Db;
    orgId = (
      await db.organization.create({
        data: { name: "Reclaim test org", slug: `reclaim-${randomUUID()}` },
      })
    ).id;
    workflowId = (
      await db.workflow.create({
        data: {
          organizationId: orgId,
          createdById: randomUUID(),
          name: "Reclaim test",
          trigger: { type: "contact.created" },
          steps: [],
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.organization.delete({ where: { id: orgId } }); // cascades to workflow and runs
    await db.$disconnect();
    await sql.end();
  });

  it("matches exactly the FAILED runs isTerminalRunError() calls retryable, NULL included", async () => {
    const runs = [
      ...(await Promise.all(ERRORS.map((e) => createRun("FAILED", e)))),
      await createRun("SUCCEEDED", null),
      await createRun("RUNNING", null),
      await createRun("CANCELED", "workflow_deactivated"),
    ];
    const matched = await db.workflowRun.findMany({
      where: { workflowId, id: { in: runs.map((r) => r.id) }, ...retryableFailedRunWhere() },
      select: { id: true },
    });
    const expected = runs.filter((r) => r.status === "FAILED" && !isTerminalRunError(r.error));
    expect(new Set(matched.map((r) => r.id))).toEqual(new Set(expected.map((r) => r.id)));
    // The NULL-error run is matched only because of the explicit `error: null`
    // branch: in SQL, NOT (NULL IN (...) OR NULL LIKE ...) is NULL, not true.
    const nullRun = runs[0]!;
    expect(matched.some((r) => r.id === nullRun.id)).toBe(true);
    const withoutNullBranch = await db.workflowRun.findMany({
      where: {
        id: nullRun.id,
        status: "FAILED",
        ...(retryableFailedRunWhere().OR as Where[])[1],
      },
    });
    expect(withoutNullBranch).toEqual([]);
  });

  it("the resume condition admits non-failed and retryable runs, never a terminal one", async () => {
    const terminal = await createRun("FAILED", CONTACT_NOT_FOUND_ERROR);
    const retryable = await createRun("FAILED", null);
    const waiting = await createRun("WAITING", null);
    const resumeWhere = (id: string): Where => ({
      id,
      OR: [{ status: { not: "FAILED" } }, retryableFailedRunWhere()],
    });
    for (const [run, resumes] of [
      [terminal, false],
      [retryable, true],
      [waiting, true],
    ] as const) {
      const { count } = await db.workflowRun.updateMany({
        where: resumeWhere(run.id),
        data: { status: "RUNNING" },
      });
      expect(count).toBe(resumes ? 1 : 0);
    }
    expect((await db.workflowRun.findUniqueOrThrow({ where: { id: terminal.id } })).status).toBe(
      "FAILED",
    );
  });

  it("of several attempts to reclaim one retryable run, exactly one takes it", async () => {
    // The conditional update is the guard: once one attempt has set RUNNING,
    // the others no longer match, whatever order they run in.
    const run = await createRun("FAILED", "step failed (DriverAdapterError)");
    const reclaim = () =>
      db.workflowRun.updateMany({
        where: reclaimWhere(run.id),
        data: { status: "RUNNING", error: null },
      });
    const counts = (await Promise.all([reclaim(), reclaim(), reclaim()])).map((r) => r.count);
    expect(counts.sort()).toEqual([0, 0, 1]);
  });

  /**
   * Opens a transaction that turns the run terminal and keeps it open, holding
   * the row lock, until commit() is called: a barrier, not a timed sleep.
   * Returns the holding backend's pid, to prove who is blocked by it.
   */
  async function holdTerminalFailure(runId: string) {
    let locked!: (pid: number) => void;
    let commit!: () => void;
    const lockHeld = new Promise<number>((resolve) => (locked = resolve));
    const committed = new Promise<void>((resolve) => (commit = resolve));
    const done = db.$transaction(
      async (tx) => {
        await tx.workflowRun.update({
          where: { id: runId },
          data: { status: "FAILED", error: CONTACT_NOT_FOUND_ERROR },
        });
        const [backend] = await tx.$queryRaw<
          Array<{ pid: number }>
        >`select pg_backend_pid() as pid`;
        locked(Number(backend!.pid));
        await committed;
      },
      { timeout: 20_000 },
    );
    const holderPid = await lockHeld;
    return { commit, done, holderPid };
  }

  /** Proof from the server: how many backends are blocked by this holder's locks. */
  async function blockedBy(holderPid: number): Promise<number> {
    const { rows } = await sql.query(
      `select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))`,
      [holderPid],
    );
    return Number(rows[0]!.n);
  }

  it("a reclaim blocked on a terminal failure's row lock re-checks the committed row and takes nothing", async () => {
    // Committed as a retryable failure, so the reclaim matches the row it sees
    // and must wait for the transaction that turns it terminal.
    const run = await createRun("FAILED", "step failed (DriverAdapterError)");
    const failure = await holdTerminalFailure(run.id);
    // .then() sends the query now: a Prisma query is lazy until awaited.
    const reclaim = db.workflowRun
      .updateMany({
        where: { id: run.id, ...retryableFailedRunWhere() },
        data: { status: "RUNNING" },
      })
      .then((r) => r);
    await vi.waitFor(async () => expect(await blockedBy(failure.holderPid)).toBe(1), {
      timeout: 10_000,
    });
    failure.commit();
    await failure.done;
    expect((await reclaim).count).toBe(0);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: CONTACT_NOT_FOUND_ERROR,
    });
  });

  it("control: the same blocked reclaim with the pre-#386 condition (any FAILED run) takes it", async () => {
    const run = await createRun("FAILED", "step failed (DriverAdapterError)");
    const failure = await holdTerminalFailure(run.id);
    const reclaim = db.workflowRun
      .updateMany({ where: { id: run.id, status: "FAILED" }, data: { status: "RUNNING" } })
      .then((r) => r);
    await vi.waitFor(async () => expect(await blockedBy(failure.holderPid)).toBe(1), {
      timeout: 10_000,
    });
    failure.commit();
    await failure.done;
    expect((await reclaim).count).toBe(1);
  });

  it("a run still RUNNING within the stale window: a reclaim during its failure record neither waits nor takes it", async () => {
    const run = await createRun("RUNNING", null);
    const failure = await holdTerminalFailure(run.id);
    const staleSince = new Date(Date.now() - 6 * 60_000);
    const reclaim = await db.workflowRun.updateMany({
      where: {
        id: run.id,
        OR: [retryableFailedRunWhere(), { status: "RUNNING", startedAt: { lt: staleSince } }],
      },
      data: { status: "RUNNING" },
    });
    expect(reclaim.count).toBe(0); // returned while the lock is still held
    expect(await blockedBy(failure.holderPid)).toBe(0);
    failure.commit();
    await failure.done;
  });

  it("a stale RUNNING run: the job's full reclaim waits on its failure record, then takes nothing", async () => {
    // A worker still recording the failure of a run older than the stale
    // window: the route's reclaim matches the stale row and has to wait.
    const run = await createRun("RUNNING", null, new Date(Date.now() - 10 * 60_000));
    const failure = await holdTerminalFailure(run.id);
    const staleSince = new Date(Date.now() - 6 * 60_000);
    const reclaim = db.workflowRun
      .updateMany({
        where: {
          id: run.id,
          OR: [retryableFailedRunWhere(), { status: "RUNNING", startedAt: { lt: staleSince } }],
        },
        data: { status: "RUNNING" },
      })
      .then((r) => r);
    await vi.waitFor(async () => expect(await blockedBy(failure.holderPid)).toBe(1), {
      timeout: 10_000,
    });
    failure.commit();
    await failure.done;
    expect((await reclaim).count).toBe(0);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: CONTACT_NOT_FOUND_ERROR,
    });
  });
});
