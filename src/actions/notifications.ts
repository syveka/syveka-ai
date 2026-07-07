"use server";

import { revalidatePath } from "next/cache";
import { getTenantContext } from "@/server/auth/session";
import { markRead } from "@/server/services/notifications";

export async function markReadAction(ids: string[] | "all"): Promise<void> {
  const ctx = await getTenantContext();
  await markRead(ctx, ids);
  revalidatePath("/notifications");
}
