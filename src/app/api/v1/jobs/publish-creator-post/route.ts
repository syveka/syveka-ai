import { NextResponse } from "next/server";
import { z } from "zod";
import { jobPayloadJson, jobWillBeRetried } from "@/server/jobs/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A real publish flow can take minutes (Instagram processes a media container
// for up to two; see src/server/integrations/meta/client.ts), so the budget
// matches the other long jobs rather than cutting a publish off halfway.
export const maxDuration = 300;

const payloadSchema = z.object({ orgId: z.string().guid(), postId: z.string().guid() });

/**
 * QStash job: Creator Studio publishing engine entry point (Phase 13).
 * All guarding (tenant ownership, approval/autopilot authorization,
 * scheduling, social connection, media readiness) and idempotency (the
 * SCHEDULED/FAILED → PUBLISHING atomic claim) live in
 * publishCreatorPost() — this handler only verifies the QStash signature
 * and parses the payload. Answers:
 * - 200 when the post was published, needs nothing, or was refused by a
 *   guard (a refusal no retry can change: not approved, no media, ...);
 * - 409 while another delivery is publishing it, so QStash delivers again
 *   later (a killed run is then found stale and marked FAILED by the sweep);
 * - 500 on a provider or infrastructure error, for QStash's bounded retry.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [
    { verifyJobRequest },
    { publishCreatorPost, PublishGuardError },
    { ORGANIZATION_INACTIVE },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/services/creator-publishing"),
    import("@/server/jobs/organization-guard"),
  ]);

  const body = await verifyJobRequest(request);
  if (body === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(jobPayloadJson(body));
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });

  try {
    const outcome = await publishCreatorPost(parsed.data.orgId, parsed.data.postId, {
      finalAttempt: !jobWillBeRetried(request),
    });
    if (outcome === "organization_inactive") return NextResponse.json(ORGANIZATION_INACTIVE);
    if (outcome === "in_progress") {
      return NextResponse.json({ error: "publish_in_progress" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    // Recorded as FAILED with its reason by publishCreatorPost; a retry would
    // refuse it again and tell the author again.
    if (e instanceof PublishGuardError) return NextResponse.json({ ok: false, code: e.code });
    console.error(
      JSON.stringify({
        event: "publish_creator_post_job_failed",
        ...parsed.data,
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return NextResponse.json({ error: "publish failed" }, { status: 500 });
  }
}
