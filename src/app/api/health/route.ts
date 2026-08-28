import { NextResponse } from "next/server";
import { sanitizeErrorMessage } from "@/server/security/error-sanitization";
import { sanitizeConnectionString } from "@/server/db/connection-string-sanitizer";
import { passwordFingerprint } from "@/server/db/credential-fingerprint";

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
    // TEMPORARY (2026-08-28): proves whether DATABASE_URL's password matches
    // the separately-known-working session-pooler credential, without ever
    // exposing either secret -- see credential-fingerprint.ts. Remove once
    // the credential investigation is concluded.
    try {
      if (process.env.DATABASE_URL) {
        console.error(
          "health check: DATABASE_URL password fingerprint",
          passwordFingerprint(sanitizeConnectionString(process.env.DATABASE_URL)),
        );
      }
    } catch (fingerprintErr) {
      console.error("health check: could not compute password fingerprint", {
        name:
          fingerprintErr instanceof Error ? fingerprintErr.constructor.name : typeof fingerprintErr,
      });
    }
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
