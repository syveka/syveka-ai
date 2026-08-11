import { NextResponse } from "next/server";
import { extractBusinessDnaRequestSchema } from "@/lib/validators/business-dna";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { AuthError },
    { extractBusinessDnaFromUrl, BusinessDnaExtractionError, UrlIngestionError },
    { rateLimiters },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/business-dna-extraction"),
    import("@/server/integrations/redis"),
  ]);

  try {
    const ctx = await requirePermission("business-dna:write");

    const rateLimit = await rateLimiters.businessDnaExtract.limit(ctx.orgId);
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

    const body = extractBusinessDnaRequestSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: body.error.flatten() } },
        { status: 400 },
      );
    }

    const result = await extractBusinessDnaFromUrl(body.data.url, request.signal);
    return NextResponse.json({ data: result.data, sourceUrl: result.sourceUrl });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (e instanceof UrlIngestionError) {
      return NextResponse.json({ error: { code: e.code } }, { status: 400 });
    }
    if (e instanceof BusinessDnaExtractionError) {
      const status = e.code === "ai_failed" ? 502 : 422;
      return NextResponse.json({ error: { code: e.code } }, { status });
    }
    throw e;
  }
}
