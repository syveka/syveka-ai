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
 * Fake-database support for the run-workflow job's success write (finish in
 * the route): an updateMany on one run by id and organization, only while it
 * is RUNNING. Returns null for any other updateMany shape.
 */
export function fakeRunFinish(
  runs: Iterable<Record<string, unknown>>,
  where: Record<string, unknown>,
  data: Record<string, unknown>,
): { count: number } | null {
  if (where.status !== "RUNNING" || typeof where.id !== "string" || "startedAt" in where) {
    return null;
  }
  for (const run of runs) {
    if (run.id === where.id && run.organizationId === where.organizationId) {
      if (run.status !== "RUNNING") return { count: 0 };
      Object.assign(run, data);
      return { count: 1 };
    }
  }
  return { count: 0 };
}
