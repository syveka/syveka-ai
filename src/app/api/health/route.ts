import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@/server/security/error-sanitization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Strips URLs/credentials so failure causes are visible without leaking secrets. */
function sanitizeError(err: unknown): { name: string; message: string } {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  return { name, message: sanitizeErrorMessage(err, 200) };
}

/**
 * Commit SHA inlined at build time by the staging release workflow, so a
 * host can be proven to serve an exact build (e.g. a stable alias versus a
 * per-deployment Preview URL). The repository is public, so the SHA is not
 * sensitive; anything other than a full lowercase SHA reports "unknown".
 */
function buildSha(): string {
  const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
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
    { status: healthy ? "healthy" : "degraded", checks, build: buildSha() },
    { status: healthy ? 200 : 503 },
  );
}
