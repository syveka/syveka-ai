import { NextResponse } from "next/server";
import { chatFileFinalizeSchema } from "@/lib/validators/chat";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { createDocument, DocumentIngestionError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/auth/session"),
      import("@/server/services/documents"),
    ]);
  try {
    const ctx = await requirePermission("chat:use");
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
