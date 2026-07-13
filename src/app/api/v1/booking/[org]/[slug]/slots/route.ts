import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  duration: z.coerce.number().int().min(5).max(480).optional(),
});

/** Public: available slots for a booking page. Rate-limited per IP. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ org: string; slug: string }> },
) {
  const [{ rateLimiters }, { getPublicSlots, BookingError }] = await Promise.all([
    import("@/server/integrations/redis"),
    import("@/server/services/booking"),
  ]);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const { success } = await rateLimiters.api.limit(`booking-slots:${ip}`);
  if (!success) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { org, slug } = await params;
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    duration: url.searchParams.get("duration") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "invalid_input" }, { status: 400 });

  const from = new Date(parsed.data.from);
  const to = new Date(parsed.data.to);
  if (to.getTime() - from.getTime() > 62 * 86_400_000) {
    return NextResponse.json({ error: "range_too_large" }, { status: 400 });
  }

  try {
    const result = await getPublicSlots({
      orgSlug: org,
      typeSlug: slug,
      from,
      to,
      durationMinutes: parsed.data.duration,
    });
    return NextResponse.json({
      timezone: result.timezone,
      durationMinutes: result.durationMinutes,
      slots: result.slots.map((s) => s.toISOString()),
    });
  } catch (e) {
    if (e instanceof BookingError && e.code === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (e instanceof BookingError) {
      return NextResponse.json({ error: e.code }, { status: 400 });
    }
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
