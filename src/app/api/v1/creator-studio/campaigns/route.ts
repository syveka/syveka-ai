import { NextResponse } from "next/server";
import { createCampaignSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { listCreatorCampaigns }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-campaigns"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const campaigns = await listCreatorCampaigns(ctx);
    return NextResponse.json({ data: campaigns });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { createCreatorCampaign },
    { handleCreatorStudioError },
    { rateLimiters },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-campaigns"),
    import("@/server/services/creator-studio-http"),
    import("@/server/integrations/redis"),
  ]);
  try {
    const ctx = await requirePermission("creator:write");
    const rateLimit = await rateLimiters.api.limit(
      `creator-campaigns-create:${ctx.orgId}:${ctx.userId}`,
    );
    if (!rateLimit.success) {
      return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
    }
    const body = createCampaignSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const campaign = await createCreatorCampaign(ctx, body.data);
    return NextResponse.json({ data: campaign }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
