"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  changeRoleAction,
  removeMemberAction,
  revokeInvitationAction,
  type MemberActionState,
} from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Member = { id: string; userId: string; email: string; name: string | null; role: string };
type Invite = { id: string; email: string; role: string };

const ASSIGNABLE = ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;
const ROLE_CODES = new Set(["OWNER", ...ASSIGNABLE]);
const REVOKE_ERRORS = new Set([
  "not_pending",
  "revoke_failed",
  "rate_limited",
  "service_unavailable",
]);

/**
 * The withdraw control for one pending invitation. A refusal is shown next to
 * the control, in the reader's language, and named by the button's
 * aria-describedby; a success removes the row when the page revalidates.
 * Unknown codes fall back to the generic failure so no raw text reaches the page.
 */
function WithdrawInvitationForm({ invitation }: { invitation: Invite }) {
  const t = useTranslations("settingsMembers");
  const [state, action, pending] = useActionState<MemberActionState, FormData>(
    () => revokeInvitationAction(invitation.id),
    {},
  );
  const alertId = `withdraw-invitation-error-${invitation.id}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <form action={action}>
        <Button
          variant="ghost"
          size="sm"
          type="submit"
          disabled={pending}
          className="text-destructive"
          aria-label={t("revokeInviteLabel", { email: invitation.email })}
          aria-describedby={state.error ? alertId : undefined}
        >
          {t("revokeInvite")}
        </Button>
      </form>
      {state.error ? (
        <p id={alertId} role="alert" className="max-w-xs text-end text-xs text-destructive">
          {t(
            `revokeErrors.${REVOKE_ERRORS.has(state.error) ? state.error : "revoke_failed"}` as never,
          )}
        </p>
      ) : null}
    </div>
  );
}

/** Shared limiter refusals have their own wording; anything else is a generic failure. */
const LIMIT_ERRORS = new Set(["rate_limited", "service_unavailable"]);

/**
 * Role and remove controls for one member. A refused change (the write
 * limit, a member-management rule) is shown next to the controls instead of
 * being lost: before, a refused role change looked saved and a refused
 * removal replaced the page.
 */
function MemberControls({
  member,
  roleLabel,
}: {
  member: Member;
  roleLabel: (role: string) => string;
}) {
  const t = useTranslations("settingsMembers");
  const [roleState, roleAction, rolePending] = useActionState<MemberActionState, FormData>(
    (_prev, fd) => {
      fd.set("memberId", member.id);
      return changeRoleAction({}, fd);
    },
    {},
  );
  const [removeState, removeAction, removePending] = useActionState<MemberActionState, FormData>(
    () => removeMemberAction(member.id),
    {},
  );
  const error = removeState.error ?? roleState.error;
  const alertId = `member-change-error-${member.id}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <form action={roleAction}>
          <select
            name="role"
            aria-label={t("changeRoleLabel", { name: member.name ?? member.email })}
            aria-describedby={error ? alertId : undefined}
            defaultValue={member.role}
            disabled={rolePending}
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          >
            {ASSIGNABLE.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </form>
        <form action={removeAction}>
          <Button
            variant="ghost"
            size="sm"
            type="submit"
            disabled={removePending}
            className="text-destructive"
            aria-label={t("removeLabel", { name: member.name ?? member.email })}
            aria-describedby={error ? alertId : undefined}
          >
            {t("remove")}
          </Button>
        </form>
      </div>
      {error ? (
        <p id={alertId} role="alert" className="max-w-xs text-end text-xs text-destructive">
          {LIMIT_ERRORS.has(error) ? t(`revokeErrors.${error}` as never) : t("memberChangeFailed")}
        </p>
      ) : null}
    </div>
  );
}

export function MembersTable({
  members,
  pendingInvites,
  currentUserId,
  canManage,
  canRevokeInvites,
}: {
  members: Member[];
  pendingInvites: Invite[];
  currentUserId: string;
  canManage: boolean;
  canRevokeInvites: boolean;
}) {
  const t = useTranslations("settingsMembers");
  const tRoles = useTranslations("roles");
  // Canonical role codes stay the stored/submitted values; only labels translate.
  const roleLabel = (role: string) => (ROLE_CODES.has(role) ? tRoles(role as never) : role);
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{m.name ?? m.email}</p>
              <p className="truncate text-xs text-muted-foreground">{m.email}</p>
            </div>
            {canManage && m.role !== "OWNER" && m.userId !== currentUserId ? (
              <MemberControls member={m} roleLabel={roleLabel} />
            ) : (
              <span className="rounded-full bg-secondary px-2 py-1 text-xs">
                {roleLabel(m.role)}
              </span>
            )}
          </div>
        ))}
        {pendingInvites.map((i) => (
          <div key={i.id} className="flex items-center justify-between gap-3 p-4 opacity-60">
            <div className="min-w-0">
              <p className="truncate text-sm">{i.email}</p>
              <p className="text-xs text-muted-foreground">
                {t("pending")} · {roleLabel(i.role)}
              </p>
            </div>
            {canRevokeInvites ? <WithdrawInvitationForm invitation={i} /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
