import { NextResponse } from "next/server";
import { connectSocialAccountSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { connectSocialAccount },
    { handleCreatorStudioError },
    { rateLimitRefusal },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-social-accounts"),
    import("@/server/services/creator-studio-http"),
    import("@/server/security/rate-limit"),
  ]);
  try {
    const ctx = await requirePermission("creator:manage-social-accounts");
    const refused = await rateLimitRefusal(
      "api",
      `creator-social-connect:${ctx.orgId}:${ctx.userId}`,
    );
    if (refused) return refused;
    const body = connectSocialAccountSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const account = await connectSocialAccount(ctx, body.data);
    return NextResponse.json({ data: account }, { status: 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
