"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Role } from "@/generated/prisma/client/client";
import { requirePermission } from "@/server/auth/guard";
import { getSessionUser, AuthError } from "@/server/auth/session";
import {
  inviteMember,
  acceptInvitation,
  changeMemberRole,
  removeMember,
  MemberError,
} from "@/server/services/members";
import { EntitlementError } from "@/server/services/billing/entitlements";
import { inviteMemberSchema, changeRoleSchema } from "@/lib/validators/members";
import { createSupabaseServer } from "@/server/supabase/server";

export type MemberActionState = { error?: string; message?: string };

/**
 * Stable, translatable invite outcomes (settingsMembers.errors.*). Raw
 * exception text is never returned to the form: it is untranslated and may
 * carry internal detail.
 */
type InviteErrorCode = "invalid_input" | "already_member" | "plan_limit" | "invite_failed";

function inviteErrorCode(error: unknown): InviteErrorCode {
  if (error instanceof MemberError) return error.code;
  // Seat limit reached, or a past-due (read-only) subscription: both come from
  // assertWithinLimit and both mean "the plan does not allow this right now".
  if (error instanceof EntitlementError) return "plan_limit";
  console.error(
    JSON.stringify({
      event: "invite_member_failed",
      name: error instanceof Error ? error.name : "unknown",
    }),
  );
  return "invite_failed";
}

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
    return { error: inviteErrorCode(e) };
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
