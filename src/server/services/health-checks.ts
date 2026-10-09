import "server-only";

import { sanitizeErrorMessage } from "@/server/security/error-sanitization";

export type HealthChecks = Record<"database" | "redis", "ok" | "fail">;

/**
 * /api/health is public and unauthenticated. Every probe used to run a database query and a
 * Redis command, so a flood of requests became a flood of DB connections and paid Upstash
 * commands. One result is shared for a few seconds (in-flight requests included), which is
 * still fresh enough for uptime monitors and deploy health waits.
 */
const CACHE_MS = 10_000;

let cached: { at: number; result: Promise<HealthChecks> } | null = null;

/** Strips URLs/credentials so failure causes are visible without leaking secrets. */
function sanitizeError(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return { name, message: sanitizeErrorMessage(err, 200) };
}

async function check(): Promise<HealthChecks> {
  const [{ unscopedPrisma }, { redis }] = await Promise.all([
    import("@/server/db/tenant"),
    import("@/server/integrations/redis"),
  ]);
  const checks: HealthChecks = { database: "fail", redis: "fail" };
  try {
    await unscopedPrisma.$queryRaw`select 1`;
    checks.database = "ok";
  } catch (err) {
    console.error("health check: database failed", sanitizeError(err));
  }
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    console.error("health check: redis failed", sanitizeError(err));
  }
  return checks;
}

export function runHealthChecks(now: number = Date.now()): Promise<HealthChecks> {
  if (cached && now - cached.at < CACHE_MS) return cached.result;
  const result = check();
  cached = { at: now, result };
  return result;
}

/** Tests only: forget the shared result. */
export function resetHealthChecksCache(): void {
  cached = null;
}
