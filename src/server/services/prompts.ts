import "server-only";

import { unscopedPrisma, tenantDb } from "@/server/db/tenant";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import type { PromptInput } from "@/lib/validators/prompts";

/** Global templates (organizationId null) + org prompts (§15.7). */
export async function listPrompts(ctx: TenantContext, category?: string) {
  return unscopedPrisma.prompt.findMany({
    where: {
      isPublished: true,
      OR: [{ organizationId: null }, { organizationId: ctx.orgId }],
      ...(category ? { category } : {}),
    },
    orderBy: [{ organizationId: { sort: "desc", nulls: "last" } }, { usageCount: "desc" }],
    take: 100,
  });
}

export async function createPrompt(ctx: TenantContext, input: PromptInput) {
  const db = tenantDb(ctx.orgId);
  const variables = [
    ...new Set([...input.content.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!)),
  ].map((name) => ({ name, label: name, type: "text" as const }));

  const prompt = await db.prompt.create({
    data: {
      title: input.title,
      description: input.description || null,
      content: input.content,
      category: input.category,
      createdById: ctx.userId,
      locale:
        ctx.locale.toUpperCase() === "AR" ? "AR" : ctx.locale.toUpperCase() === "EN" ? "EN" : "FI",
      variables,
    },
  });
  await audit(ctx, {
    action: "prompt.create",
    resourceType: "prompt",
    resourceId: prompt.id,
    after: { title: input.title },
  });
  return prompt;
}

export async function deletePrompt(ctx: TenantContext, promptId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  // tenantDb scoping guarantees global templates can't be deleted
  await db.prompt.delete({ where: { id: promptId } });
  await audit(ctx, { action: "prompt.delete", resourceType: "prompt", resourceId: promptId });
}

/** Render {{variables}} + bump usage counter (§15.7). */
export async function renderPrompt(
  ctx: TenantContext,
  promptId: string,
  values: Record<string, string>,
): Promise<string> {
  const prompt = await unscopedPrisma.prompt.findFirst({
    where: {
      id: promptId,
      isPublished: true,
      OR: [{ organizationId: null }, { organizationId: ctx.orgId }],
    },
  });
  if (!prompt) throw new Error("Prompt not found");

  await unscopedPrisma.prompt.update({
    where: { id: promptId },
    data: { usageCount: { increment: 1 } },
  });

  return prompt.content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => values[name] ?? "");
}
