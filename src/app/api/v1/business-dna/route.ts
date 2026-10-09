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
  const [{ requirePermission }, { AuthError }, { upsertBusinessDNA }, { rateLimiters }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/auth/session"),
      import("@/server/services/business-dna"),
      import("@/server/integrations/redis"),
    ]);

  try {
    const ctx = await requirePermission("business-dna:write");
    let rateLimit;
    try {
      rateLimit = await rateLimiters.businessDnaWrite.limit(ctx.orgId);
    } catch {
      // The limit can't be checked: refuse (fail closed), as a clear 503.
      return NextResponse.json({ error: { code: "service_unavailable" } }, { status: 503 });
    }
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
