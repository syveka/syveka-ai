import { NextResponse } from "next/server";
import { businessDnaSaveRequestSchema } from "@/lib/validators/business-dna";

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
  const [{ requirePermission }, { AuthError }, { upsertBusinessDNA }, { rateLimitRefusal }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/auth/session"),
      import("@/server/services/business-dna"),
      import("@/server/security/rate-limit"),
    ]);

  try {
    const ctx = await requirePermission("business-dna:write");
    // The limit can't be checked (Redis error or timeout): a clear 503 (fail closed).
    const refusal = await rateLimitRefusal("businessDnaWrite", ctx.orgId);
    if (refusal) return refusal;
    const body = businessDnaSaveRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: body.error.flatten() } },
        { status: 400 },
      );
    }
    const { expectedUpdatedAt, ...profileInput } = body.data;
    const saved = await upsertBusinessDNA(ctx, profileInput, expectedUpdatedAt);
    if (!saved.ok) {
      // Changed since the client loaded it: nothing was saved. GET returns
      // the current profile and its updatedAt.
      return NextResponse.json({ error: { code: "conflict" } }, { status: 409 });
    }
    return NextResponse.json({ data: saved.record });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}
