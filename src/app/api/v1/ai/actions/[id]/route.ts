import { NextResponse } from "next/server";
import { z } from "zod";
import { isCrossOrigin } from "@/server/security/same-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    decision: z.enum(["confirm", "cancel"]),
    conversationId: z.string().uuid(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

function error(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

/**
 * Refusals that happen after the action was marked decided (see
 * decideToolAction), with the outcome to record: permission and an invalid
 * stored action are refused before the tool runs ("failed": nothing was
 * done); an error while the tool ran may come after its write ("unknown").
 */
const CONSUMED_FAILURES: Record<string, "failed" | "unknown"> = {
  permission_denied: "failed",
  invalid_action: "failed",
  action_failed: "unknown",
};

const REFUSALS = {
  not_found: 404,
  already_decided: 409,
  mismatch: 409,
  permission_denied: 403,
  invalid_action: 422,
  action_failed: 500,
} as const;

/**
 * The user's decision on an AI-proposed write action (see
 * src/server/ai/tool-actions.ts): confirm runs exactly the stored action
 * once; cancel discards it. Only the signed-in user who received the
 * proposal, in its organization and conversation, can decide it.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (isCrossOrigin(request)) return error("cross_origin_request", 403);
  const [{ getTenantContext }, { can }, { limitAiChat, redis }, actions, { audit }] =
    await Promise.all([
      import("@/server/auth/session"),
      import("@/server/auth/permissions"),
      import("@/server/integrations/redis"),
      import("@/server/ai/tool-actions"),
      import("@/server/services/audit"),
    ]);
  /**
   * Records the decision. Never changes the response: the action has already
   * run (or not), and reporting a recording failure as an action failure
   * would be false. A missing record shows as "unknown" when reopened.
   */
  const record = async (
    owner: { orgId: string; userId: string },
    input: Parameters<typeof audit>[1],
  ) => {
    try {
      await audit(owner, input);
    } catch (e) {
      console.error(
        JSON.stringify({
          event: "ai_tool_action_audit_failed",
          actionId: input.resourceId,
          name: e instanceof Error ? e.name : "unknown",
        }),
      );
    }
  };

  let ctx;
  try {
    ctx = await getTenantContext();
  } catch {
    return error("unauthenticated", 401);
  }
  if (!can(ctx.role, "chat:use")) return error("permission_denied", 403);

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return error("invalid_input", 400);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return error("invalid_input", 400);

  const rate = await limitAiChat(ctx.orgId, ctx.userId);
  if (!rate.success) return error("rate_limited", 429);

  let outcome;
  try {
    outcome = await actions.decideToolAction(
      redis,
      { orgId: ctx.orgId, userId: ctx.userId, role: ctx.role, actorType: "user" },
      { id, ...body.data },
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "ai_tool_action_store_unavailable",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return error("service_unavailable", 503);
  }
  if (!outcome.ok) {
    // These happen after the action was marked decided (it can't run again):
    // record them, so a reopened conversation shows "failed", not "unknown".
    const recorded = CONSUMED_FAILURES[outcome.reason];
    if (recorded) {
      await record(
        { orgId: ctx.orgId, userId: ctx.userId },
        {
          action: "ai_action.confirm",
          resourceType: "ai_action",
          resourceId: id,
          actorType: "user",
          after: { outcome: recorded, reason: outcome.reason },
        },
      );
    }
    return error(outcome.reason, REFUSALS[outcome.reason]);
  }

  await record(
    { orgId: ctx.orgId, userId: ctx.userId },
    {
      action: outcome.status === "canceled" ? "ai_action.cancel" : "ai_action.confirm",
      resourceType: "ai_action",
      resourceId: id,
      actorType: "user",
      after: {
        tool: outcome.tool,
        // A change not applied because it was out of date is recorded as such,
        // so a reopened conversation doesn't show it as a taken time slot.
        outcome:
          outcome.status === "not_done" && outcome.reason === "stale" ? "stale" : outcome.status,
      },
    },
  );
  return NextResponse.json({ data: outcome });
}
