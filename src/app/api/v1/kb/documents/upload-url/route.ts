import { NextResponse } from "next/server";
import { uploadUrlSchema } from "@/lib/validators/documents";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { createUploadUrl }, { EntitlementError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/auth/session"),
      import("@/server/services/documents"),
      import("@/server/services/billing/entitlements"),
    ]);

  try {
    const ctx = await requirePermission("kb:write");
    const body = uploadUrlSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    }
    const result = await createUploadUrl(ctx, body.data);
    return NextResponse.json({ data: result });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (e instanceof EntitlementError) {
      return NextResponse.json({ error: { code: e.code, limit: e.limit } }, { status: 402 });
    }
    throw e;
  }
}
