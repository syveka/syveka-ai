import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Strips URLs/credentials so failure causes are visible without leaking secrets. */
function sanitizeError(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message = rawMessage
    .replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, "[redacted-url]")
    .slice(0, 200);
  return { name, message };
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
