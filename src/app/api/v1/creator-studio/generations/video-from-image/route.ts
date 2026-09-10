import { NextResponse } from "next/server";
import { generateVideoFromImageSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";
// fal.ai's own queue poll ceiling (src/server/integrations/fal.ts:
// MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) is 300s; a real Kling call has been
// observed taking ~71s. Without this, the platform's default function
// timeout (well under 300s) would kill the request while fal.ai keeps
// processing — see docs/creator-studio.md §15 for the full timeout/recovery audit.
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { requestVideoFromImageGeneration },
    { handleCreatorStudioError },
    { rateLimiters },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-generations"),
    import("@/server/services/creator-studio-http"),
    import("@/server/integrations/redis"),
  ]);
  try {
    const ctx = await requirePermission("creator:generate");
    const rateLimit = await rateLimiters.creatorGenerate.limit(`${ctx.orgId}:${ctx.userId}`);
    if (!rateLimit.success) {
      return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
    }
    const body = generateVideoFromImageSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const generation = await requestVideoFromImageGeneration(ctx, body.data);
    return NextResponse.json({ data: generation }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
