import { NextResponse } from "next/server";
import { createDocumentSchema } from "@/lib/validators/documents";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { listDocuments }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/documents"),
  ]);

  try {
    const ctx = await requirePermission("kb:read");
    const documents = await listDocuments(ctx);
    return NextResponse.json({ data: documents });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { AuthError },
    { createDocument, DocumentIngestionError, UrlIngestionError },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/documents"),
  ]);

  try {
    const ctx = await requirePermission("kb:write");
    const body = createDocumentSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: body.error.flatten() } },
        { status: 400 },
      );
    }
    const document = await createDocument(ctx, body.data);
    return NextResponse.json({ data: document }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (e instanceof DocumentIngestionError) {
      const status =
        e.code === "expired_upload_intent" ? 410 : e.code === "reused_upload_intent" ? 409 : 400;
      return NextResponse.json({ error: { code: e.code } }, { status });
    }
    if (e instanceof UrlIngestionError) {
      return NextResponse.json({ error: { code: e.code } }, { status: 400 });
    }
    throw e;
  }
}
