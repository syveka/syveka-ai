import { NextResponse } from "next/server";
import { runHealthChecks } from "@/server/services/health-checks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

/** Uptime probe (§24): DB + Redis reachability, shared for a few seconds (see health-checks). */
export async function GET(): Promise<NextResponse> {
  const checks = await runHealthChecks();
  const healthy = Object.values(checks).every((v) => v === "ok");
  return NextResponse.json(
    { status: healthy ? "healthy" : "degraded", checks, build: buildSha() },
    { status: healthy ? 200 : 503 },
  );
}
