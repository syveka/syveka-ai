import { isTerminalRunError } from "@/lib/workflows/run-failure";

type FakeRun = {
  id: string;
  organizationId: string;
  status: string;
  startedAt: Date;
} & Record<string, unknown>;

/**
 * Fake-database support for the run-workflow job's fenced failure record
 * (recordFailure in src/app/api/v1/jobs/run-workflow/route.ts): an updateMany
 * on one run by id, organization and the claim's startedAt, while the run is
 * still in one of the given statuses. Returns null for any other updateMany
 * shape, so each fake keeps its own reclaim logic. The real conditions are
 * exercised on PostgreSQL by run-workflow.postgres.test.ts.
 */
export function fakeFailureRecord(
  runs: Iterable<FakeRun>,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): { count: number } | null {
  const status = where.status as { in?: string[] } | undefined;
  if (!(where.startedAt instanceof Date) || !Array.isArray(status?.in)) return null;
  for (const run of runs) {
    if (
      run.id === where.id &&
      run.organizationId === where.organizationId &&
      run.startedAt.getTime() === (where.startedAt as Date).getTime() &&
      status.in.includes(run.status)
    ) {
      Object.assign(run, data);
      return { count: 1 };
    }
  }
  return { count: 0 };
}

/**
 * Fake-database support for the run-workflow job's conditional status writes
 * on one run by id and organization: the success write (finish: while
 * RUNNING or WAITING) and parking on a wait (park: while RUNNING with the
 * claim's startedAt), each also over a retryable failure other than
 * step_not_allowed when the write lists that alternative. Returns null for any other
 * updateMany shape, including the failure record (fakeFailureRecord), which
 * also carries startedAt but a status list.
 */
export function fakeRunFinish(
  runs: Iterable<Record<string, unknown>>,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): { count: number } | null {
  const alternatives = Array.isArray(where.OR)
    ? (where.OR as Array<Record<string, unknown>>)
    : null;
  const status = (alternatives ? alternatives[0]?.status : where.status) as
    string | { in?: string[] } | undefined;
  const allowed = typeof status === "string" ? [status] : status?.in;
  const isFinish = !("startedAt" in where) && Array.isArray(allowed);
  const isPark = where.startedAt instanceof Date && typeof status === "string";
  if (typeof where.id !== "string" || !(isFinish || isPark)) return null;
  for (const run of runs) {
    if (run.id === where.id && run.organizationId === where.organizationId) {
      const startedAt = run.startedAt as Date | undefined;
      const retryableFailure =
        alternatives !== null &&
        run.status === "FAILED" &&
        run.error !== "step_not_allowed" &&
        !isTerminalRunError((run.error as string | null | undefined) ?? null);
      if (
        !(allowed!.includes(run.status as string) || retryableFailure) ||
        (isPark && startedAt?.getTime() !== (where.startedAt as Date).getTime())
      ) {
        return { count: 0 };
      }
      Object.assign(run, data);
      return { count: 1 };
    }
  }
  return { count: 0 };
}
