import "server-only";

import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import type { TenantContext } from "@/server/auth/session";
import { anthropic } from "@/server/integrations/anthropic";
import { routeModel } from "@/server/ai/router";

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
          id: true, role: true, content: true, citations: true,
          toolCalls: true, feedback: true, createdAt: true,
        },
      },
    },
  });
}

export async function createConversation(ctx: TenantContext) {
  const db = tenantDb(ctx.orgId);
  return db.conversation.create({ data: { userId: ctx.userId } });
}

export async function deleteConversation(ctx: TenantContext, conversationId: string) {
  const db = tenantDb(ctx.orgId);
  await db.conversation.update({
    where: { id: conversationId, userId: ctx.userId },
    data: { deletedAt: new Date() },
  });
}

/** Auto-title after the first exchange (Haiku-class, §15.2 "title"). */
export async function generateTitle(conversationId: string, firstMessage: string): Promise<void> {
  const { model, maxTokens } = routeModel("title");
  try {
    const res = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: `Give a 3-6 word title (same language as the message, no quotes) for a conversation starting with:\n\n${firstMessage.slice(0, 500)}`,
        },
      ],
    });
    const title = res.content[0]?.type === "text" ? res.content[0].text.trim().slice(0, 80) : null;
    if (title) {
      await unscopedPrisma.conversation.update({ where: { id: conversationId }, data: { title } });
    }
  } catch {
    // title generation is best-effort
  }
}
