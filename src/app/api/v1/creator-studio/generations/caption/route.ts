import { NextResponse } from "next/server";
import { generateCaptionSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { requestCaptionGeneration },
    { handleCreatorStudioError },
    { rateLimitRefusal },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-generations"),
    import("@/server/services/creator-studio-http"),
    import("@/server/security/rate-limit"),
  ]);
  try {
    const ctx = await requirePermission("creator:generate");
    // A paid provider call: refused when the limit can't be verified (fail closed).
    const refusal = await rateLimitRefusal("creatorGenerate", `${ctx.orgId}:${ctx.userId}`);
    if (refusal) return refusal;
    const body = generateCaptionSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const { generation } = await requestCaptionGeneration(ctx, body.data);
    return NextResponse.json({ data: generation }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
