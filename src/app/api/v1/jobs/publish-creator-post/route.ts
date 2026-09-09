import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const payloadSchema = z.object({ orgId: z.string().uuid(), postId: z.string().uuid() });

/**
 * QStash job: Creator Studio publishing engine entry point (Phase 13).
 * All guarding (tenant ownership, approval/autopilot authorization,
 * scheduling, social connection, media readiness) and idempotency (the
 * SCHEDULED/FAILED → PUBLISHING atomic claim) live in
 * publishCreatorPost() — this handler only verifies the QStash signature
 * and parses the payload. A thrown PublishGuardError or provider error
 * surfaces as a 500 so QStash's built-in bounded retry (retries: 3, set at
 * enqueue time) can attempt transient failures again.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { publishCreatorPost }] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/services/creator-publishing"),
  ]);

  const body = await verifyJobRequest(request);
  if (body === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  try {
    await publishCreatorPost(parsed.data.orgId, parsed.data.postId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("publish-creator-post job failed", { ...parsed.data, error: e });
    return NextResponse.json({ error: "publish failed" }, { status: 500 });
  }
}
