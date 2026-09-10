import { NextResponse } from "next/server";
import { createCreatorProfileSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { listCreatorProfiles }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-profiles"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:read");
    const profiles = await listCreatorProfiles(ctx);
    return NextResponse.json({ data: profiles });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { createCreatorProfile },
    { handleCreatorStudioError },
    { rateLimiters },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-profiles"),
    import("@/server/services/creator-studio-http"),
    import("@/server/integrations/redis"),
  ]);
  try {
    const ctx = await requirePermission("creator:write");
    const rateLimit = await rateLimiters.api.limit(
      `creator-profiles-create:${ctx.orgId}:${ctx.userId}`,
    );
    if (!rateLimit.success) {
      return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
    }
    const body = createCreatorProfileSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const profile = await createCreatorProfile(ctx, body.data);
    return NextResponse.json({ data: profile }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
