import { NextResponse } from "next/server";
import { businessDnaSchema } from "@/lib/validators/business-dna";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { getBusinessDNA }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/business-dna"),
  ]);

  try {
    const ctx = await requirePermission("business-dna:read");
    const profile = await getBusinessDNA(ctx);
    return NextResponse.json({ data: profile });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}

export async function PUT(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { upsertBusinessDNA }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/business-dna"),
  ]);

  try {
    const ctx = await requirePermission("business-dna:write");
    const body = businessDnaSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: body.error.flatten() } },
        { status: 400 },
      );
    }
    const profile = await upsertBusinessDNA(ctx, body.data);
    return NextResponse.json({ data: profile });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}
