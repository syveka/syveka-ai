import { NextResponse } from "next/server";
import { setAutopilotSchema } from "@/lib/validators/creator-studio";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const [{ requirePermission }, { setCampaignAutopilot }, { handleCreatorStudioError }] =
    await Promise.all([
      import("@/server/auth/guard"),
      import("@/server/services/creator-campaigns"),
      import("@/server/services/creator-studio-http"),
    ]);
  try {
    const ctx = await requirePermission("creator:manage-autopilot");
    const { id } = await params;
    const body = setAutopilotSchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
    const campaign = await setCampaignAutopilot(ctx, id, body.data);
    return NextResponse.json({ data: campaign });
  } catch (e) {
    return handleCreatorStudioError(e);
  }
}
