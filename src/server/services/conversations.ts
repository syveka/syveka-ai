import "server-only";

import type { Prisma } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { anthropic } from "@/server/integrations/anthropic";
import { routeModel } from "@/server/ai/router";
import { estimateAiCost } from "@/server/ai/cost";
import { withAiRetry } from "@/server/ai/retry";
import { env } from "@/env";
import { recordUsage } from "@/server/services/billing/entitlements";

const SUMMARY_CONTEXT_MESSAGES = 20;
const SUMMARY_TRIGGER_MESSAGES = 40;

export async function listConversations(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.conversation.findMany({
    where: { deletedAt: null, OR: [{ userId: ctx.userId }, { isShared: true }] },
    orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
    take: 50,
    select: { id: true, title: true, isPinned: true, isShared: true, updatedAt: true },
  });
}

export async function getConversationWithMessages(ctx: TenantContext, conversationId: string) {
  const db = tenantDb(ctx.orgId);
  return db.conversation.findFirst({
    where: {
      id: conversationId,
      deletedAt: null,
      OR: [{ userId: ctx.userId }, { isShared: true }],
    },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        take: 200,
        select: {
          id: true,
          role: true,
          content: true,
          citations: true,
          toolCalls: true,
          feedback: true,
          createdAt: true,
        },
      },
    },
  });
}

export async function createConversation(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.conversation.create({ data: { organizationId: ctx.orgId, userId: ctx.userId } });
}

export async function deleteConversation(ctx: TenantContext, conversationId: string) {
  const db = tenantDb(ctx.orgId);
  await db.conversation.update({
    where: { id: conversationId, userId: ctx.userId },
    data: { deletedAt: new Date() },
  });
}

export async function attachDocumentsToConversation(params: {
  organizationId: string;
  conversationId: string;
  documentIds: string[];
}): Promise<string[]> {
  const uniqueIds = [...new Set(params.documentIds)];
  if (uniqueIds.length === 0) return [];
  const [conversation, documents] = await Promise.all([
    unscopedPrisma.conversation.findFirst({
      where: { id: params.conversationId, organizationId: params.organizationId, deletedAt: null },
      select: { id: true },
    }),
    unscopedPrisma.document.findMany({
      where: {
        id: { in: uniqueIds },
        organizationId: params.organizationId,
        deletedAt: null,
      },
      select: { id: true },
    }),
  ]);
  if (!conversation || documents.length !== uniqueIds.length) {
    throw new Error("invalid_conversation_document");
  }
  await unscopedPrisma.conversationDocument.createMany({
    data: documents.map((document) => ({
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      documentId: document.id,
    })),
    skipDuplicates: true,
  });
  return documents.map((document) => document.id);
}

export async function getConversationDocumentIds(params: {
  organizationId: string;
  conversationId: string;
}): Promise<string[]> {
  const rows = await unscopedPrisma.conversationDocument.findMany({
    where: {
      organizationId: params.organizationId,
      conversationId: params.conversationId,
      document: { deletedAt: null },
    },
    select: { documentId: true },
  });
  return rows.map((row) => row.documentId);
}

/** Build and persist an incremental rolling summary while retaining recent turns verbatim. */
export async function ensureConversationSummary(params: {
  organizationId: string;
  conversationId: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const conversation = await unscopedPrisma.conversation.findFirstOrThrow({
    where: { id: params.conversationId, organizationId: params.organizationId },
    select: { summary: true, summaryMessageCount: true },
  });
  const where: Prisma.MessageWhereInput = {
    conversationId: params.conversationId,
    role: { in: ["USER", "ASSISTANT"] },
  };
  const total = await unscopedPrisma.message.count({ where });
  const targetCount = Math.max(0, total - SUMMARY_CONTEXT_MESSAGES);
  const pendingCount = targetCount - conversation.summaryMessageCount;
  if (total <= SUMMARY_TRIGGER_MESSAGES || pendingCount < SUMMARY_CONTEXT_MESSAGES) {
    return conversation.summary;
  }

  const pending = await unscopedPrisma.message.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: conversation.summaryMessageCount,
    take: Math.min(pendingCount, 100),
    select: { role: true, content: true },
  });
  if (pending.length === 0) return conversation.summary;

  const { model, maxTokens } = routeModel("summary");
  const transcript = pending
    .map((message) => `${message.role === "USER" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n\n")
    .slice(0, 60_000);
  const response = await withAiRetry(
    () =>
      anthropic.messages.create(
        {
          model,
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: [
                "Update the rolling conversation summary. Preserve decisions, facts, names, dates, constraints, unresolved questions, and user preferences. Do not add facts.",
                conversation.summary ? `Existing summary:\n${conversation.summary}` : "",
                `New transcript:\n${transcript}`,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
        },
        { signal: params.signal },
      ),
    {
      maxAttempts: env.AI_RETRY_MAX_ATTEMPTS,
      baseDelayMs: env.AI_RETRY_BASE_DELAY_MS,
      signal: params.signal,
    },
  );
  const summary = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
  if (!summary) return conversation.summary;

  const usage = { tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens };
  const cost = estimateAiCost(model, usage);
  await Promise.all([
    unscopedPrisma.conversation.update({
      where: { id: params.conversationId },
      data: {
        summary,
        summaryMessageCount: conversation.summaryMessageCount + pending.length,
        summaryUpdatedAt: new Date(),
      },
    }),
    recordUsage(params.organizationId, "AI_TOKENS_IN", usage.tokensIn, {
      model,
      task: "summary",
      estimatedCostUsd: cost.promptUsd,
    }),
    recordUsage(params.organizationId, "AI_TOKENS_OUT", usage.tokensOut, {
      model,
      task: "summary",
      estimatedCostUsd: cost.completionUsd,
    }),
  ]);
  return summary;
}

/** Auto-title after the first exchange (Haiku-class, §15.2 "title"). */
export async function generateTitle(conversationId: string, firstMessage: string): Promise<void> {
  const { model, maxTokens } = routeModel("title");
  try {
    const res = await withAiRetry(
      () =>
        anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          messages: [
            {
              role: "user",
              content: `Give a 3-6 word title (same language as the message, no quotes) for a conversation starting with:\n\n${firstMessage.slice(0, 500)}`,
            },
          ],
        }),
      { maxAttempts: env.AI_RETRY_MAX_ATTEMPTS, baseDelayMs: env.AI_RETRY_BASE_DELAY_MS },
    );
    const title = res.content[0]?.type === "text" ? res.content[0].text.trim().slice(0, 80) : null;
    if (title) {
      await unscopedPrisma.conversation.update({ where: { id: conversationId }, data: { title } });
    }
  } catch {
    // title generation is best-effort
  }
}
