import { NextResponse } from "next/server";
import { generateCharacterImageSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";
// fal.ai's own queue poll ceiling (src/server/integrations/fal.ts:
// MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) is 300s — see docs/creator-studio.md §15
// for the full timeout/recovery audit.
export const maxDuration = 300;

export async function POST(request: Request): Promise<NextResponse> {
  const [
    { requirePermission },
    { requestCharacterImageGeneration },
    { handleCreatorStudioError },
    { rateLimitRefusal },
    { parseIdempotencyKeyHeader },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/services/creator-generations"),
    import("@/server/services/creator-studio-http"),
    import("@/server/security/rate-limit"),
    import("@/server/services/creator-studio-idempotency"),
  ]);
  try {
    const ctx = await requirePermission("creator:generate");
    // A paid provider call: refused when the limit can't be verified (fail closed).
    const refusal = await rateLimitRefusal("creatorGenerate", `${ctx.orgId}:${ctx.userId}`);
    if (refusal) return refusal;
    const idempotencyKey = parseIdempotencyKeyHeader(request.headers.get("Idempotency-Key"));
    const body = generateCharacterImageSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const { generation, reused } = await requestCharacterImageGeneration(ctx, {
      ...body.data,
      idempotencyKey,
    });
    return NextResponse.json({ data: generation }, { status: reused ? 200 : 201 });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
