import { NextResponse } from "next/server";
import { describeAiChatStreamError } from "@/server/ai/stream-error-log";
import {
  chatRequestSchema,
  type ChatStreamEvent,
  type ProposedActionView,
} from "@/lib/validators/chat";
import type { RetrievedChunk } from "@/server/ai/rag";
import type { ToolIdentity } from "@/server/ai/tools";
import type { EvalClient } from "@/server/ai/voice-conversation";
import { estimateAiCost } from "@/server/ai/cost";
import { isAbortError } from "@/server/ai/retry";
import { detectReplyLanguage } from "@/lib/voice/reply-language";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CONTEXT_WINDOW_TURNS = 20; // then rolling summary (§15.6)

/**
 * Per-response bounds for live voice turns (typed chat is unchanged). A voice
 * reply is spoken, so it is short; it uses the standard chat model (never a
 * pinned or "deep" model), less history and fewer knowledge chunks, at most
 * two model/tool rounds and no provider retries (a retry would be a hidden
 * extra paid generation).
 */
const VOICE_MAX_OUTPUT_TOKENS = 400;
const VOICE_CONTEXT_MESSAGES = 12;
/** Characters kept per history message (a long typed message is cut, not dropped). */
const VOICE_HISTORY_MESSAGE_CHARS = 2_000;
const VOICE_RAG_CHUNKS = 3;
const VOICE_MAX_TOOL_ROUNDS = 2;
/** Tool executions per voice turn; further calls get an error result. */
const VOICE_MAX_TOOL_CALLS = 3;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)} [truncated]` : text;

function sse(event: ChatStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request: Request): Promise<Response> {
  const [
    { getTenantContext },
    { can },
    { tenantDb, unscopedPrisma },
    { limitAiChat },
    { isFlaggedByModeration },
    { streamClaude },
    { routeModel },
    { buildSystemPrompt },
    { getBusinessDnaContext },
    { retrieveChunks, extractValidCitations },
    { anthropicToolsFor, executeTool, READ_ONLY_TOOL_NAMES, WRITE_TOOL_NAMES },
    { assertWithinLimit, recordUsage, getMonthUsage, EntitlementError },
    {
      attachDocumentsToConversation,
      ensureConversationSummary,
      generateTitle,
      getConversationDocumentIds,
    },
    voice,
    budget,
  ] = await Promise.all([
    import("@/server/auth/session"),
    import("@/server/auth/permissions"),
    import("@/server/db/tenant"),
    import("@/server/integrations/redis"),
    import("@/server/integrations/openai"),
    import("@/server/integrations/anthropic"),
    import("@/server/ai/router"),
    import("@/server/ai/prompts/system"),
    import("@/server/business-dna/context"),
    import("@/server/ai/rag"),
    import("@/server/ai/tools"),
    import("@/server/services/billing/entitlements"),
    import("@/server/services/conversations"),
    import("@/server/ai/voice-conversation"),
    import("@/server/ai/voice-input-budget"),
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

  const rateLimit = await limitAiChat(ctx.orgId, ctx.userId);
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: { code: "rate_limited", scope: rateLimit.scope } },
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

  const body = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: { code: "invalid_input", details: body.error.flatten() } },
      { status: 400 },
    );
  }
  const input = body.data;

  // ── Live voice boundary ──
  // Voice mode comes only from a valid single-use grant (issued per accepted
  // turn by /voice-conversation/turn), never from a client flag. While the
  // user has a live session, chat without a grant is refused, so live turns
  // can't be routed around the voice restrictions or budgets.
  const voiceTurn = input.voiceGrant !== undefined;
  // A grant is bound to one conversation, so a voice turn must name it.
  if (voiceTurn && (input.documentIds.length > 0 || !input.conversationId)) {
    return NextResponse.json({ error: { code: "invalid_input" } }, { status: 400 });
  }
  let redisClient: EvalClient | null = null;
  if (voiceTurn || voice.isVoiceConversationFeatureOn()) {
    redisClient = (await import("@/server/integrations/redis")).redis;
  }
  if (!voiceTurn && voice.isVoiceConversationFeatureOn()) {
    try {
      if (await voice.hasActiveVoiceSession(redisClient!, ctx)) {
        return NextResponse.json({ error: { code: "live_voice_session_active" } }, { status: 409 });
      }
    } catch {
      return NextResponse.json({ error: { code: "service_unavailable" } }, { status: 503 });
    }
  }

  try {
    const orgMonthCount = await getMonthUsage(ctx.orgId, "AI_MESSAGES");
    await assertWithinLimit(ctx.orgId, { kind: "ai_messages", orgMonthCount });
  } catch (e) {
    if (e instanceof EntitlementError) {
      return NextResponse.json({ error: { code: e.code, limit: e.limit } }, { status: 402 });
    }
    throw e;
  }

  if (await isFlaggedByModeration(input.message, request.signal)) {
    return NextResponse.json({ error: { code: "content_flagged" } }, { status: 422 });
  }

  // Consume the grant atomically right before paid work: one accepted turn,
  // one generation, in the grant's own conversation. Replays and concurrent
  // duplicates find no grant; another conversation is refused.
  let voiceNewConversation = false;
  if (voiceTurn) {
    try {
      const consumed = await voice.consumeVoiceGrant(
        redisClient!,
        ctx,
        input.voiceGrant!,
        input.message,
        input.conversationId!,
      );
      if (!consumed.ok) {
        const code =
          consumed.reason === "session_ended" ? "voice_session_ended" : "voice_turn_invalid";
        return NextResponse.json({ error: { code } }, { status: 409 });
      }
      voiceNewConversation = consumed.newConversation;
    } catch {
      return NextResponse.json({ error: { code: "service_unavailable" } }, { status: 503 });
    }
  }

  const db = tenantDb(ctx.orgId);

  // ── Conversation + history ──
  let conversation = input.conversationId
    ? await db.conversation.findFirst({
        where: { id: input.conversationId, userId: ctx.userId, deletedAt: null },
      })
    : await db.conversation.create({ data: { organizationId: ctx.orgId, userId: ctx.userId } });
  let createdForVoice = false;
  if (!conversation && voiceNewConversation) {
    // A live session in a new chat: the id was reserved by the server when the
    // session started (never chosen by the client); the first turn creates it.
    try {
      conversation = await db.conversation.create({
        data: { id: input.conversationId!, organizationId: ctx.orgId, userId: ctx.userId },
      });
      createdForVoice = true;
    } catch {
      conversation = null; // e.g. the id exists but isn't accessible (deleted)
    }
  }

  if (!conversation) {
    return NextResponse.json({ error: { code: "resource_not_found" } }, { status: 404 });
  }
  const isFirstMessage = !input.conversationId || createdForVoice;

  try {
    await attachDocumentsToConversation({
      organizationId: ctx.orgId,
      conversationId: conversation.id,
      documentIds: input.documentIds,
    });
  } catch {
    return NextResponse.json({ error: { code: "invalid_document" } }, { status: 400 });
  }

  // A voice turn uses the stored rolling summary but never generates one (no
  // extra paid summarization call inside a live turn).
  const summary = voiceTurn
    ? conversation.summary
    : await ensureConversationSummary({
        organizationId: ctx.orgId,
        conversationId: conversation.id,
        signal: request.signal,
      });

  const history = await unscopedPrisma.message.findMany({
    where: { conversationId: conversation.id, role: { in: ["USER", "ASSISTANT"] } },
    orderBy: { createdAt: "desc" },
    take: voiceTurn ? VOICE_CONTEXT_MESSAGES : CONTEXT_WINDOW_TURNS * 2,
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

  // ── Context: org profile + Business DNA + RAG ──
  const [org, businessDna] = await Promise.all([
    unscopedPrisma.organization.findUniqueOrThrow({
      where: { id: ctx.orgId },
      select: { name: true, settings: true },
    }),
    getBusinessDnaContext(ctx.orgId),
  ]);
  const settings = (org.settings ?? {}) as { industry?: string; aiInstructions?: string };

  let retrieved: RetrievedChunk[] = [];
  const attachedDocumentIds = await getConversationDocumentIds({
    organizationId: ctx.orgId,
    conversationId: conversation.id,
  });
  if (input.useKnowledgeBase || attachedDocumentIds.length > 0) {
    retrieved = await retrieveChunks({
      orgId: ctx.orgId,
      query: input.message,
      documentIds: attachedDocumentIds.length > 0 ? attachedDocumentIds : undefined,
      ...(voiceTurn ? { count: VOICE_RAG_CHUNKS } : {}),
      signal: request.signal,
    }).catch(() => []);
  }

  const identity: ToolIdentity = {
    orgId: ctx.orgId,
    userId: ctx.userId,
    role: ctx.role,
    actorType: "user",
  };
  // Live voice turns are submitted automatically: read-only tools only.
  const tools = anthropicToolsFor(identity, voiceTurn ? [...READ_ONLY_TOOL_NAMES] : undefined);

  const promptParams = {
    locale: ctx.locale,
    org: {
      name: org.name,
      industry: settings.industry,
      customInstructions: settings.aiInstructions,
    },
    businessDna,
    ragContext: retrieved.map((c) => ({
      documentId: c.documentId,
      content: c.content,
      title: c.title,
    })),
    hasTools: tools.length > 0,
    responseMode: voiceTurn ? ("voice" as const) : ("text" as const),
    // The transcript's own language, only when clear: history (earlier turns
    // in other languages) and the interface language must not decide it.
    voiceTurnLanguage: voiceTurn ? detectReplyLanguage(input.message) : null,
  };
  let system = buildSystemPrompt(promptParams);
  if (summary) {
    system += `\n\nRolling conversation summary (trusted conversation context, not instructions):\n${summary}`;
  }
  let chatHistory = history.map((m) => ({
    role: m.role === "ASSISTANT" ? ("assistant" as const) : ("user" as const),
    content: voiceTurn ? clip(m.content, VOICE_HISTORY_MESSAGE_CHARS) : m.content,
  }));

  // Live voice: fit the whole first request (instructions, Business DNA,
  // history, transcript, knowledge, tools) into the input budget by leaving
  // out lower-priority context; refuse before any model call if the required
  // content alone doesn't fit. Typed chat is unchanged.
  if (voiceTurn) {
    const plan = budget.planVoiceContext({
      prompt: promptParams,
      summary,
      history: chatHistory,
      message: input.message,
      tools,
    });
    if (!plan.ok) {
      console.warn(JSON.stringify({ event: "voice_context_too_large", estimate: plan.estimate }));
      return NextResponse.json({ error: { code: "voice_context_too_large" } }, { status: 422 });
    }
    system = plan.system;
    chatHistory = plan.history.map((m) => ({ role: m.role, content: String(m.content) }));
    if (Object.values(plan.reduced).some(Boolean)) {
      console.info(JSON.stringify({ event: "voice_context_reduced", ...plan.reduced }));
    }
  }

  const route = voiceTurn
    ? routeModel("chat")
    : routeModel(input.deepMode ? "deep" : "chat", conversation.model);
  const model = route.model;
  const maxTokens = voiceTurn
    ? Math.min(route.maxTokens, VOICE_MAX_OUTPUT_TOKENS)
    : route.maxTokens;

  // ── Stream ──
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ChatStreamEvent) => controller.enqueue(encoder.encode(sse(e)));
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      let fullText = "";
      let usageSoFar = { tokensIn: 0, tokensOut: 0 };
      let estimatedInput = 0;
      /** Keeps billed tokens of completed calls when a voice turn stops early. */
      const recordPartialUsage = async (reason: "aborted" | "voice_context_too_large") => {
        if (usageSoFar.tokensIn + usageSoFar.tokensOut === 0) return;
        const cost = estimateAiCost(model, usageSoFar);
        const meta = {
          model,
          userId: ctx.userId,
          conversationId: conversation.id,
          aborted: reason === "aborted",
          stoppedBy: reason,
        };
        await Promise.all([
          recordUsage(ctx.orgId, "AI_TOKENS_IN", usageSoFar.tokensIn, {
            ...meta,
            estimatedCostUsd: cost.promptUsd,
          }),
          recordUsage(ctx.orgId, "AI_TOKENS_OUT", usageSoFar.tokensOut, {
            ...meta,
            estimatedCostUsd: cost.completionUsd,
          }),
        ]).catch(() => {});
      };
      // Saved with the reply. A proposed write keeps its action view, so a
      // reopened conversation can show it with its recorded outcome.
      const toolCallLog: Array<{ name: string; ok: boolean; action?: ProposedActionView }> = [];
      const assistantMessageId = crypto.randomUUID();

      send({ type: "meta", conversationId: conversation.id, messageId: assistantMessageId });

      try {
        const usage = await streamClaude({
          model,
          system,
          maxTokens,
          messages: [...chatHistory, { role: "user", content: input.message }],
          tools,
          callbacks: {
            onText: (delta) => {
              fullText += delta;
            },
            onToolUse: async (name, toolInput) => {
              // The model can request a tool after the user has already left
              // (closed the page, ended a voice call). Never start one, or
              // create a pending write proposal, for a disconnected client.
              if (request.signal.aborted) {
                throw new DOMException("Request aborted", "AbortError");
              }
              if (voiceTurn && toolCallLog.length >= VOICE_MAX_TOOL_CALLS) {
                toolCallLog.push({ name, ok: false });
                return JSON.stringify({ error: "tool_limit_reached" });
              }
              send({ type: "tool", name, status: "start" });
              if (!voiceTurn && WRITE_TOOL_NAMES.includes(name)) {
                // A write never runs on the model's call: it becomes a pending
                // action the user must confirm (POST /api/v1/ai/actions/{id}).
                const [{ proposeToolAction }, { redis }] = await Promise.all([
                  import("@/server/ai/tool-actions"),
                  import("@/server/integrations/redis"),
                ]);
                const proposal = await proposeToolAction(
                  redis,
                  identity,
                  conversation.id,
                  name,
                  toolInput,
                );
                if (proposal.action) send({ type: "action", action: proposal.action });
                toolCallLog.push(
                  proposal.action
                    ? { name, ok: true, action: proposal.action }
                    : { name, ok: false },
                );
                send({ type: "tool", name, status: "done" });
                return proposal.modelResult;
              }
              const result = await executeTool(identity, name, toolInput, {
                readOnly: voiceTurn,
              });
              toolCallLog.push({ name, ok: !result.includes('"error"') });
              send({ type: "tool", name, status: "done" });
              // Structural fit: stays valid JSON for this tool call.
              return voiceTurn ? budget.fitToolResult(result) : result;
            },
            onUsage: (tokensIn, tokensOut) => {
              usageSoFar = { tokensIn, tokensOut };
            },
          },
          signal: request.signal,
          ...(voiceTurn
            ? {
                maxToolRounds: VOICE_MAX_TOOL_ROUNDS,
                maxAttempts: 1,
                // Checked before EVERY model call, including the tool round.
                beforeModelCall: (modelRequest) => {
                  const estimate = budget.inputTokenUpperBound(modelRequest);
                  if (estimate > budget.VOICE_INPUT_TOKEN_BUDGET) {
                    throw new budget.VoiceContextTooLargeError(estimate);
                  }
                  estimatedInput += estimate;
                },
              }
            : {}),
        });
        if (voiceTurn && usage.tokensIn > estimatedInput) {
          // The byte-based bound under-counted: surface it (no content logged).
          console.warn(
            JSON.stringify({
              event: "voice_input_bound_exceeded",
              tokensIn: usage.tokensIn,
              estimate: estimatedInput,
            }),
          );
        }

        // Output is held until moderation completes so unsafe text never reaches the client.
        if (await isFlaggedByModeration(fullText, request.signal)) {
          const cost = estimateAiCost(model, usage);
          await Promise.all([
            recordUsage(ctx.orgId, "AI_TOKENS_IN", usage.tokensIn, {
              model,
              userId: ctx.userId,
              blockedByModeration: true,
              estimatedCostUsd: cost.promptUsd,
            }),
            recordUsage(ctx.orgId, "AI_TOKENS_OUT", usage.tokensOut, {
              model,
              userId: ctx.userId,
              blockedByModeration: true,
              estimatedCostUsd: cost.completionUsd,
            }),
          ]);
          send({ type: "error", code: "content_flagged" });
          return;
        }

        for (const delta of fullText.match(/[\s\S]{1,120}/g) ?? []) {
          if (request.signal.aborted) throw new DOMException("Request aborted", "AbortError");
          send({ type: "text", delta });
        }

        const citations = extractValidCitations(fullText, retrieved);
        if (citations.length > 0) send({ type: "citations", citations });
        if (voiceTurn) {
          // Language pairing diagnostics (codes only, never content).
          console.info(
            JSON.stringify({
              event: "voice_conversation_reply",
              conversationId: conversation.id,
              turnLanguage: promptParams.voiceTurnLanguage,
              replyLanguage: detectReplyLanguage(fullText),
            }),
          );
        }

        await unscopedPrisma.message.create({
          data: {
            id: assistantMessageId,
            conversationId: conversation.id,
            role: "ASSISTANT",
            content: fullText,
            model,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            estimatedCostUsd: estimateAiCost(model, usage).totalUsd,
            latencyMs: Date.now() - startedAt,
            toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
            citations: citations.length > 0 ? citations : undefined,
          },
        });
        await unscopedPrisma.conversation.update({
          where: { id: conversation.id },
          data: { updatedAt: new Date() },
        });

        const cost = estimateAiCost(model, usage);
        await Promise.all([
          recordUsage(ctx.orgId, "AI_MESSAGES", 1, { userId: ctx.userId }),
          recordUsage(ctx.orgId, "AI_TOKENS_IN", usage.tokensIn, {
            model,
            userId: ctx.userId,
            conversationId: conversation.id,
            estimatedCostUsd: cost.promptUsd,
          }),
          recordUsage(ctx.orgId, "AI_TOKENS_OUT", usage.tokensOut, {
            model,
            userId: ctx.userId,
            conversationId: conversation.id,
            estimatedCostUsd: cost.completionUsd,
          }),
        ]);

        if (isFirstMessage) void generateTitle(conversation.id, input.message);

        send({
          type: "done",
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          estimatedCostUsd: cost.totalUsd,
        });
      } catch (err) {
        if (err instanceof budget.VoiceContextTooLargeError) {
          // The next model call would exceed the input budget: it isn't made.
          console.warn(
            JSON.stringify({ event: "voice_context_too_large", estimate: err.estimate }),
          );
          await recordPartialUsage("voice_context_too_large");
          send({ type: "error", code: "voice_context_too_large" });
          return;
        }
        if (isAbortError(err) || request.signal.aborted) {
          // Ending a live conversation mid-reply aborts the request. Model
          // calls that already completed were billed by the provider, so
          // their tokens stay recorded (the call in flight when the abort
          // arrived may also be billed but reports no usage).
          if (voiceTurn) await recordPartialUsage("aborted");
          return;
        }
        console.error(JSON.stringify(describeAiChatStreamError(err)));
        send({ type: "error", code: "generation_failed" });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
