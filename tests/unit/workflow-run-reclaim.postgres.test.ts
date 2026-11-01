import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * SQL NULL semantics, agreement with isTerminalRunError(), row-lock races
 * between a terminal failure and a reclaim, and rollback of the failure
 * record when the creator's notification can't be written.
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
    const [{ PrismaClient }, { PrismaPg }] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
    ]);
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

  it("two simultaneous reclaims of one retryable run: exactly one wins", async () => {
    const run = await createRun("FAILED", "step failed (DriverAdapterError)");
    const reclaim = () =>
      db.workflowRun.updateMany({
        where: reclaimWhere(run.id),
        data: { status: "RUNNING", error: null },
      });
    const counts = (await Promise.all([reclaim(), reclaim(), reclaim()])).map((r) => r.count);
    expect(counts.sort()).toEqual([0, 0, 1]);
  });

  it("a reclaim waiting on a terminal failure's row lock finds it terminal and does nothing", async () => {
    const run = await createRun("RUNNING", null);
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => (locked = resolve));
    const terminalFailure = db.$transaction(
      async (tx) => {
        await tx.workflowRun.update({
          where: { id: run.id },
          data: { status: "FAILED", error: CONTACT_NOT_FOUND_ERROR },
        });
        locked();
        await tx.$executeRaw`select pg_sleep(0.5)`;
      },
      { timeout: 10_000 },
    );
    await lockHeld;
    // Started while the failing transaction still holds the row lock; it is
    // evaluated again against the committed row.
    const reclaim = db.workflowRun.updateMany({
      where: { ...reclaimWhere(run.id), OR: [retryableFailedRunWhere()] },
      data: { status: "RUNNING" },
    });
    await terminalFailure;
    expect((await reclaim).count).toBe(0);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: "FAILED",
      error: CONTACT_NOT_FOUND_ERROR,
    });
  });

  it("the failure record and its notification commit together: a failed notification leaves the run unrecorded", async () => {
    const run = await createRun("RUNNING", null);
    // Same shape as the job's failure record; the notification's user does
    // not exist, so the insert fails on its foreign key.
    await expect(
      db.$transaction(async (tx) => {
        await tx.workflowRun.update({
          where: { id: run.id },
          data: { status: "FAILED", error: CONTACT_NOT_FOUND_ERROR, finishedAt: new Date() },
        });
        await tx.notification.create({
          data: {
            organizationId: orgId,
            userId: randomUUID(),
            type: "workflow.failed",
            title: "Reclaim test",
          },
        });
      }),
    ).rejects.toThrow();
    // Nothing terminal was recorded, so a redelivery can still run and notify.
    const after = await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(after).toMatchObject({ status: "RUNNING", error: null });
  });
});
