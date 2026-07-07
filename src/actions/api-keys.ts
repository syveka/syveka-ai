"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/server/auth/guard";
import { createApiKey, revokeApiKey } from "@/server/services/api-keys";
import { z } from "zod";

const createSchema = z.object({
  name: z.string().min(1).max(60),
  scopes: z.array(z.string()).min(1),
});

export async function createApiKeyAction(input: {
  name: string;
  scopes: string[];
}): Promise<{ plaintext?: string; error?: string }> {
  const ctx = await requirePermission("api-keys:manage");
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid_input" };
  try {
    const { plaintext } = await createApiKey(ctx, parsed.data);
    revalidatePath("/settings/api-keys");
    return { plaintext };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "failed" };
  }
}

export async function revokeApiKeyAction(keyId: string): Promise<void> {
  const ctx = await requirePermission("api-keys:manage");
  await revokeApiKey(ctx, keyId);
  revalidatePath("/settings/api-keys");
}
