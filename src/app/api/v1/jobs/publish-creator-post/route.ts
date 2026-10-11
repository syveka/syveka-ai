import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Instagram waits for its media container (up to 120s, each Graph request at
// most 30s; src/server/integrations/meta/client.ts): the whole run fits well
// inside this limit, so a healthy publish is never cut off mid-way.
export const maxDuration = 300;

const payloadSchema = z.object({
  orgId: z.string().uuid(),
  postId: z.string().uuid(),
  /** Set on the delayed check scheduled at each claim: the attempt to check. */
  staleCheck: z.number().int().positive().optional(),
});

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
  const [
    { verifyJobRequest },
    { publishCreatorPost, recoverStalePublish },
    { ORGANIZATION_INACTIVE },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/services/creator-publishing"),
    import("@/server/jobs/organization-guard"),
  ]);

  const body = await verifyJobRequest(request);
  if (body === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(JSON.parse(body));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  const { orgId, postId, staleCheck } = parsed.data;
  try {
    const outcome =
      staleCheck === undefined
        ? await publishCreatorPost(orgId, postId)
        : await recoverStalePublish(orgId, postId, staleCheck);
    if (outcome === "organization_inactive") return NextResponse.json(ORGANIZATION_INACTIVE);
    return NextResponse.json({ ok: true });
  } catch (e) {
    // A stale check that came too early also lands here: QStash delivers it again.
    console.error("publish-creator-post job failed", { ...parsed.data, error: e });
    return NextResponse.json({ error: "publish failed" }, { status: 500 });
  }
}
