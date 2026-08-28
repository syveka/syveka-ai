import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@/server/security/error-sanitization";
import { classifyDbUrl, sanitizeConnectionString } from "@/server/db/connection-string-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Strips URLs/credentials so failure causes are visible without leaking secrets. */
function sanitizeError(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return { name, message: sanitizeErrorMessage(err, 200) };
}

/** Uptime probe (§24): DB + Redis reachability. */
export async function GET(): Promise<NextResponse> {
  const [{ unscopedPrisma }, { redis }] = await Promise.all([
    import("@/server/db/tenant"),
    import("@/server/integrations/redis"),
  ]);

  const checks: Record<string, "ok" | "fail"> = {};
  try {
    await unscopedPrisma.$queryRaw`select 1`;
    checks.database = "ok";
  } catch (err) {
    checks.database = "fail";
    console.error("health check: database failed", sanitizeError(err));
    // TEMPORARY (2026-08-28): structural-only diagnostic for the staging
    // malformed-connection-string investigation. Never logs the password or
    // full connection string — see connection-string-diagnostics.ts. Remove
    // once the root cause is confirmed and fixed.
    console.error("health check: DATABASE_URL structure", classifyDbUrl(process.env.DATABASE_URL));
    console.error("health check: DIRECT_URL structure", classifyDbUrl(process.env.DIRECT_URL));
    console.error(
      "health check: DATABASE_URL structure (post-sanitize)",
      classifyDbUrl(
        process.env.DATABASE_URL ? sanitizeConnectionString(process.env.DATABASE_URL) : undefined,
      ),
    );
  }
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = "fail";
    console.error("health check: redis failed", sanitizeError(err));
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json(
    { status: healthy ? "healthy" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
}
