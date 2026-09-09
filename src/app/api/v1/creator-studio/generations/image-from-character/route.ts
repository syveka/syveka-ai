import { NextResponse } from "next/server";
import { generateImageFromCharacterSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { requestImageFromCharacterGeneration },
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
    const body = generateImageFromCharacterSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const generation = await requestImageFromCharacterGeneration(ctx, body.data);
    return NextResponse.json({ data: generation }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
