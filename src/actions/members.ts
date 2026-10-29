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
  revokeInvitation,
  MemberError,
  InvitationAccountMismatchError,
  InvitationAcceptError,
} from "@/server/services/members";
import { EntitlementError } from "@/server/services/billing/entitlements";
import { inviteMemberSchema, changeRoleSchema } from "@/lib/validators/members";
import { createSupabaseServer } from "@/server/supabase/server";
import { inviteContinuation, localizedPath, normalizeLocale } from "@/lib/auth-redirect";
import {
  actionRateLimitError,
  actionWriteLimitError,
  emailKey,
} from "@/server/security/rate-limit";

export type MemberActionState = { error?: string; message?: string };

/**
 * Stable, translatable invite outcomes (settingsMembers.errors.*). Raw
 * exception text is never returned to the form: it is untranslated and may
 * carry internal detail.
 */
type InviteErrorCode =
  "invalid_input" | "already_member" | "plan_limit" | "rate_limited" | "invite_failed";

function inviteErrorCode(error: unknown): InviteErrorCode {
  if (error instanceof MemberError && error.code === "already_member") return error.code;
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

  // Every invitation sends an email. Checked before anything is looked up, so
  // the answer is the same whether or not the address has an account.
  const limited = await actionRateLimitError(
    ["memberInviteOrg", ctx.orgId],
    ["memberInviteRecipient", `${ctx.orgId}:${emailKey(parsed.data.email)}`],
  );
  if (limited === "rate_limited") return { error: "rate_limited" };
  if (limited) return { error: "invite_failed" };

  try {
    await inviteMember(ctx, { email: parsed.data.email, role: parsed.data.role as Role });
  } catch (e) {
    return { error: inviteErrorCode(e) };
  }

  revalidatePath("/settings/members");
  return { message: "invited" };
}

/** `locale` comes from the invitation page and is checked against the app's locales. */
export async function acceptInvitationAction(token: string, locale?: string): Promise<void> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Not authenticated");
  const pageLocale = normalizeLocale(locale ?? null);
  const invitationPath = inviteContinuation(`/invite/${token}`);
  // A token that isn't one can't have an invitation; it fails as "invalid"
  // and lands on the dashboard instead of an invitation page.
  const invitationPage = invitationPath
    ? localizedPath(pageLocale, invitationPath)
    : localizedPath(pageLocale, "/dashboard");

  // Only acceptInvitation's own expected failures are turned into a page;
  // the redirects happen outside the try so nothing here can swallow them.
  let failure: "wrong_account" | InvitationAcceptError["code"] | null = null;
  try {
    await acceptInvitation(token, user.id);
  } catch (e) {
    if (e instanceof InvitationAccountMismatchError) failure = "wrong_account";
    else if (e instanceof InvitationAcceptError) failure = e.code;
    else throw e;
  }
  // Signed in as someone else (for example another account in the same
  // browser): back to the invitation, which says so and offers to sign out.
  if (failure === "wrong_account") redirect(invitationPage);
  if (failure) redirect(invitationPath ? `${invitationPage}?error=${failure}` : invitationPage);

  const supabase = await createSupabaseServer();
  await supabase.auth.refreshSession();

  redirect(localizedPath(pageLocale, "/dashboard"));
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
    // Stable codes only: exception text (Prisma's, a provider's) never
    // reaches the client. The name is enough to find the cause in the logs.
    if (e instanceof MemberError) return { error: e.code };
    console.error(
      JSON.stringify({
        event: "change_member_role_failed",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return { error: "failed" };
  }

  revalidatePath("/settings/members");
  return { message: "updated" };
}

/**
 * Withdraws a pending invitation; the same permission that sent it. Outcomes
 * are stable codes (settingsMembers.revokeErrors.*), never exception text.
 */
export async function revokeInvitationAction(invitationId: string): Promise<MemberActionState> {
  const ctx = await requirePermission("members:invite");
  const limited = await actionWriteLimitError("members", ctx);
  if (limited) return { error: limited };
  try {
    await revokeInvitation(ctx, invitationId);
  } catch (e) {
    if (e instanceof MemberError) return { error: e.code };
    console.error(
      JSON.stringify({
        event: "revoke_invitation_failed",
        name: e instanceof Error ? e.name : "unknown",
      }),
    );
    return { error: "revoke_failed" };
  }
  revalidatePath("/settings/members");
  return { message: "revoked" };
}

export async function removeMemberAction(memberId: string): Promise<void> {
  const ctx = await requirePermission("members:remove");
  await removeMember(ctx, memberId);
  revalidatePath("/settings/members");
}
