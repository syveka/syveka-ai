import { NextResponse } from "next/server";
import { businessDnaServiceSchema } from "@/lib/validators/business-dna";

export const dynamic = "force-dynamic";

/** Service records are never hard-deleted through this route -- DELETE deactivates (see `deactivateBusinessDnaService`). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { updateBusinessDnaService }] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/session"),
    import("@/server/services/business-dna-services"),
  ]);

  try {
    const ctx = await requirePermission("business-dna:write");
    const { id } = await params;
    const body = businessDnaServiceSchema
      .partial()
      .safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return NextResponse.json(
        { error: { code: "invalid_input", details: body.error.flatten() } },
        { status: 400 },
      );
    }
    const service = await updateBusinessDnaService(ctx, id, body.data);
    return NextResponse.json({ data: service });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (e instanceof Error && e.message === "Service not found") {
      // Never distinguishes "exists in another org" from "doesn't exist" --
      // both return the same 404, so cross-tenant ID guessing can't be used
      // to probe for existence.
      return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
    }
    throw e;
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { AuthError }, { deactivateBusinessDnaService }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/auth/session"),
      import("@/server/services/business-dna-services"),
    ]);

  try {
    const ctx = await requirePermission("business-dna:write");
    const { id } = await params;
    const service = await deactivateBusinessDnaService(ctx, id);
    return NextResponse.json({ data: service });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
    }
    if (e instanceof Error && e.message === "Service not found") {
      return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
    }
    throw e;
  }
}
