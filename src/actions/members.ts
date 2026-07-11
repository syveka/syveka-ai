"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { requirePermission } from "@/server/auth/guard";
import { getSessionUser, AuthError } from "@/server/auth/session";
import {
  inviteMember,
  acceptInvitation,
  changeMemberRole,
  removeMember,
} from "@/server/services/members";
import { inviteMemberSchema, changeRoleSchema } from "@/lib/validators/members";
import { createSupabaseServer } from "@/server/supabase/server";

export type MemberActionState = { error?: string; message?: string };

export async function inviteMemberAction(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const ctx = await requirePermission("members:invite");

  const parsed = inviteMemberSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await inviteMember(ctx, { email: parsed.data.email, role: parsed.data.role as Role });
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invite_failed" };
  }

  revalidatePath("/settings/members");
  return { message: "invited" };
}

export async function acceptInvitationAction(token: string): Promise<void> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Not authenticated");

  await acceptInvitation(token, user.id);

  const supabase = await createSupabaseServer();
  await supabase.auth.refreshSession();

  redirect("/dashboard");
}

export async function changeRoleAction(
  _prev: MemberActionState,
  formData: FormData,
): Promise<MemberActionState> {
  const ctx = await requirePermission("members:role");

  const parsed = changeRoleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "invalid_input" };

  try {
    await changeMemberRole(ctx, parsed.data.memberId, parsed.data.role as Role);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "failed" };
  }

  revalidatePath("/settings/members");
  return { message: "updated" };
}

export async function removeMemberAction(memberId: string): Promise<void> {
  const ctx = await requirePermission("members:remove");
  await removeMember(ctx, memberId);
  revalidatePath("/settings/members");
}
