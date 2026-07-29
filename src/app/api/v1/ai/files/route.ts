import { NextResponse } from "next/server";
import { chatFileFinalizeSchema } from "@/lib/validators/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { AuthError },
    { createDocument, DocumentIngestionError },
    { rateLimiters },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/documents"),
    import("@/server/integrations/redis"),
  ]);
  try {
    const ctx = await requirePermission("chat:use");
    const rateLimit = await rateLimiters.api.limit(`ai-files:${ctx.orgId}:${ctx.userId}`);
    if (!rateLimit.success) {
      return NextResponse.json(
        { error: { code: "rate_limited" } },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000))),
            "X-RateLimit-Limit": String(rateLimit.limit),
            "X-RateLimit-Remaining": String(rateLimit.remaining),
            "X-RateLimit-Reset": String(rateLimit.reset),
          },
        },
      );
    }
    const parsed = chatFileFinalizeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: parsed.error.flatten() } },
        { status: 400 },
      );
    }
    const document = await createDocument(ctx, {
      sourceType: "UPLOAD",
      title: parsed.data.title,
      uploadIntentId: parsed.data.uploadIntentId,
    });
    return NextResponse.json(
      { data: { id: document.id, title: document.title, status: document.status } },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: error.status });
    }
    if (error instanceof DocumentIngestionError) {
      const status =
        error.code === "expired_upload_intent"
          ? 410
          : error.code === "reused_upload_intent"
            ? 409
            : 400;
      return NextResponse.json({ error: { code: error.code } }, { status });
    }
    throw error;
  }
}
