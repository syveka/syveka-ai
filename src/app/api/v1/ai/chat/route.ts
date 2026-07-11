import { NextResponse } from "next/server";
import { chatRequestSchema, type ChatStreamEvent } from "@/lib/validators/chat";
import type { RetrievedChunk } from "@/server/ai/rag";
import type { ToolIdentity } from "@/server/ai/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CONTEXT_WINDOW_TURNS = 20; // then rolling summary (§15.6)

function sse(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request): Promise<Response> {
  const [
    { getTenantContext },
    { can },
    { tenantDb, unscopedPrisma },
    { rateLimiters },
    { isFlaggedByModeration },
    { streamClaude },
    { routeModel },
    { buildSystemPrompt },
    { retrieveChunks, extractValidCitations },
    { anthropicToolsFor, executeTool },
    { assertWithinLimit, recordUsage, getMonthUsage, EntitlementError },
    { generateTitle },
  ] = await Promise.all([
    import("@/server/auth/session"),
    import("@/server/auth/permissions"),
    import("@/server/db/tenant"),
    import("@/server/integrations/redis"),
    import("@/server/integrations/openai"),
    import("@/server/integrations/anthropic"),
    import("@/server/ai/router"),
    import("@/server/ai/prompts/system"),
    import("@/server/ai/rag"),
    import("@/server/ai/tools"),
    import("@/server/services/billing/entitlements"),
    import("@/server/services/conversations"),
  ]);

  // ── Guardrails: auth → permission → rate limit → entitlement → moderation ──
  let ctx;
  try {
    ctx = await getTenantContext();
  } catch {
    return NextResponse.json({ error: { code: "unauthenticated" } }, { status: 401 });
  }
  if (!can(ctx.role, "chat:use")) {
    return NextResponse.json({ error: { code: "permission_denied" } }, { status: 403 });
  }

  const { success } = await rateLimiters.aiChat.limit(`${ctx.orgId}:${ctx.userId}`);
  if (!success) {
    return NextResponse.json({ error: { code: "rate_limited" } }, { status: 429 });
  }

  const body = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
  }
  const input = body.data;

  try {
    const userMonthCount = await getMonthUsage(ctx.orgId, "AI_MESSAGES");
    await assertWithinLimit(ctx.orgId, { kind: "ai_messages", userMonthCount });
  } catch (e) {
    if (e instanceof EntitlementError) {
      return NextResponse.json({ error: { code: e.code, limit: e.limit } }, { status: 402 });
    }
    throw e;
  }

  if (await isFlaggedByModeration(input.message)) {
    return NextResponse.json({ error: { code: "content_flagged" } }, { status: 422 });
  }

  const db = tenantDb(ctx.orgId);

  // ── Conversation + history ──
  const conversation = input.conversationId
    ? await db.conversation.findFirst({
        where: { id: input.conversationId, userId: ctx.userId, deletedAt: null },
      })
    : await db.conversation.create({ data: { organizationId: ctx.orgId, userId: ctx.userId } });

  if (!conversation) {
    return NextResponse.json({ error: { code: "resource_not_found" } }, { status: 404 });
  }
  const isFirstMessage = !input.conversationId;

  const history = await unscopedPrisma.message.findMany({
    where: { conversationId: conversation.id, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: CONTEXT_WINDOW_TURNS * 2,
    select: { role: true, content: true },
  });
  history.reverse();

  await unscopedPrisma.message.create({
    data: {
      conversationId: conversation.id,
      userId: ctx.userId,
      role: "USER",
      content: input.message,
    },
  });

  // ── Context: org profile + RAG ──
  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { name: true, settings: true },
  });
  const settings = (org.settings ?? {}) as { industry?: string; aiInstructions?: string };

  let retrieved: RetrievedChunk[] = [];
  if (input.useKnowledgeBase) {
    retrieved = await retrieveChunks({ orgId: ctx.orgId, query: input.message }).catch(() => []);
  }

  const identity: ToolIdentity = {
    orgId: ctx.orgId,
    userId: ctx.userId,
    role: ctx.role,
    actorType: "user",
  };
  const tools = anthropicToolsFor(identity);

  const system = buildSystemPrompt({
    locale: ctx.locale,
    org: {
      name: org.name,
      industry: settings.industry,
      customInstructions: settings.aiInstructions,
    },
    ragContext: retrieved.map((c) => ({
      documentId: c.documentId,
      content: c.content,
      title: c.title,
    })),
    hasTools: tools.length > 0,
  });

  const { model, maxTokens } = routeModel(input.deepMode ? "deep" : "chat", conversation.model);

  // ── Stream ──
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatStreamEvent) => controller.enqueue(encoder.encode(sse(e)));
      let fullText = "";
      const toolCallLog: Array<{ name: string; ok: boolean }> = [];

      send({ type: "meta", conversationId: conversation.id, messageId: "" });

      try {
        const usage = await streamClaude({
          model,
          system,
          maxTokens,
          messages: [
            ...history.map((m) => ({
              role: m.role === "ASSISTANT" ? ("assistant" as const) : ("user" as const),
              content: m.content,
            })),
            { role: "user", content: input.message },
          ],
          tools,
          callbacks: {
            onText: (delta) => {
              fullText += delta;
              send({ type: "text", delta });
            },
            onToolUse: async (name, toolInput) => {
              send({ type: "tool", name, status: "start" });
              const result = await executeTool(identity, name, toolInput);
              toolCallLog.push({ name, ok: !result.includes('"error"') });
              send({ type: "tool", name, status: "done" });
              return result;
            },
          },
        });

        const citations = extractValidCitations(fullText, retrieved);
        if (citations.length > 0) send({ type: "citations", citations });

        await unscopedPrisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: fullText,
            model,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            latencyMs: Date.now() - startedAt,
            toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
            citations: citations.length > 0 ? citations : undefined,
          },
        });
        await unscopedPrisma.conversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        });

        await Promise.all([
          recordUsage(ctx.orgId, "AI_MESSAGES", 1, { userId: ctx.userId }),
          recordUsage(ctx.orgId, "AI_TOKENS_IN", usage.tokensIn, { model }),
          recordUsage(ctx.orgId, "AI_TOKENS_OUT", usage.tokensOut, { model }),
        ]);

        if (isFirstMessage) void generateTitle(conversation.id, input.message);

        send({ type: "done", tokensIn: usage.tokensIn, tokensOut: usage.tokensOut });
      } catch (err) {
        console.error("ai/chat stream failed", err);
        send({ type: "error", code: "generation_failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
