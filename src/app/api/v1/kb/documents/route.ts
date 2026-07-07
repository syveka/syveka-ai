import { NextResponse } from "next/server";
import { requirePermission } from "@/server/auth/guard";
import { AuthError } from "@/server/auth/session";
import { createDocument, listDocuments } from "@/server/services/documents";
import { createDocumentSchema } from "@/lib/validators/documents";

export async function GET(): Promise<NextResponse> {
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
    throw e;
  }
}
