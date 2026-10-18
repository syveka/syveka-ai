import { NextResponse } from "next/server";
import { uploadUrlSchema } from "@/lib/validators/documents";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { AuthError },
    { createUploadUrl },
    { EntitlementError },
    { rateLimitRefusal },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/documents"),
    import("@/server/services/billing/entitlements"),
    import("@/server/security/rate-limit"),
  ]);
  try {
    const ctx = await requirePermission("chat:use");
    const refused = await rateLimitRefusal("api", `ai-files-upload-url:${ctx.orgId}:${ctx.userId}`);
    if (refused) return refused;
    const parsed = uploadUrlSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    return NextResponse.json({ data: await createUploadUrl(ctx, parsed.data) });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: error.status });
    }
    if (error instanceof EntitlementError) {
      return NextResponse.json(
        { error: { code: error.code, limit: error.limit } },
        { status: 402 },
      );
    }
    throw error;
  }
}
