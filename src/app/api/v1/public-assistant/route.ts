import { NextResponse } from "next/server";
import { publicAssistantRequestSchema } from "@/lib/validators/public-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Public, unauthenticated marketing-site assistant. No session, no tenant
 * context, no tools passed to the model -- this route cannot read or write
 * any customer/tenant data by construction, not merely by prompt
 * instruction (see src/server/ai/prompts/public-assistant.ts for the rest
 * of the boundary). Non-streaming: a single short JSON reply, capped output
 * tokens (src/server/ai/router.ts's "publicAssistant" route), IP rate
 * limited. Nothing here is persisted -- history is held client-side only.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ rateLimiters }, { streamClaude }, { routeModel }, { buildPublicAssistantSystemPrompt }] =
    await Promise.all([
      import("@/server/integrations/redis"),
      import("@/server/integrations/anthropic"),
      import("@/server/ai/router"),
      import("@/server/ai/prompts/public-assistant"),
    ]);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rateLimit = await rateLimiters.publicAssistant.limit(`public-assistant:${ip}`);
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  const parsed = publicAssistantRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { message, locale, history } = parsed.data;

  try {
    const { isFlaggedByModeration } = await import("@/server/integrations/openai");
    if (await isFlaggedByModeration(message, request.signal)) {
      return NextResponse.json({ error: "content_flagged" }, { status: 422 });
    }

    const { model, maxTokens } = routeModel("publicAssistant");
    const system = buildPublicAssistantSystemPrompt(locale);

    let reply = "";
    // No `tools` passed -- intentionally leaves the model with no callable
    // capability at all, so onToolUse is never invoked and there is no
    // tool-use branch here to guard against a prompt-injected tool call.
    await streamClaude({
      model,
      system,
      maxTokens,
      messages: [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: message },
      ],
      callbacks: {
        onText: (delta) => {
          reply += delta;
        },
      },
      signal: request.signal,
    });

    if (await isFlaggedByModeration(reply, request.signal)) {
      return NextResponse.json({ error: "content_flagged" }, { status: 422 });
    }

    return NextResponse.json({ reply });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "public_assistant_failed",
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return NextResponse.json({ error: "generic" }, { status: 500 });
  }
}
