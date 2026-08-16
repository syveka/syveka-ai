import { NextResponse } from "next/server";
import { businessDnaServiceSchema } from "@/lib/validators/business-dna";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { listBusinessDnaServices }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/business-dna-services"),
  ]);

  try {
    const ctx = await requirePermission("business-dna:read");
    const services = await listBusinessDnaServices(ctx);
    return NextResponse.json({ data: services });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    throw e;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { createBusinessDnaService }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/business-dna-services"),
  ]);

  try {
    const ctx = await requirePermission("business-dna:write");
    const body = businessDnaServiceSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: body.error.flatten() } },
        { status: 400 },
      );
    }
    const service = await createBusinessDnaService(ctx, body.data);
    return NextResponse.json({ data: service }, { status: 201 });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (
      e instanceof Error &&
      e.message === "Business DNA profile must be created before adding services"
    ) {
      return NextResponse.json(
        { error: { code: "conflict", message: e.message } },
        { status: 409 },
      );
    }
    throw e;
  }
}
