import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  } catch {
    checks.database = "fail";
  }
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch {
    checks.redis = "fail";
  }
  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json(
    { status: healthy ? "healthy" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
}
