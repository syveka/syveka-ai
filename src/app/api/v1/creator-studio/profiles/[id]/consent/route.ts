import { NextResponse } from "next/server";
import { confirmConsentSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { confirmCreatorConsent }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-profiles"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:write");
    const { id } = await params;
    const body = confirmConsentSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const profile = await confirmCreatorConsent(ctx, id);
    return NextResponse.json({ data: profile });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
