"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { inviteMemberAction, type MemberActionState } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ROLES = ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;
const INVITE_ERRORS = new Set(["invalid_input", "already_member", "plan_limit", "invite_failed"]);

export function InviteForm() {
  const t = useTranslations("settingsMembers");
  const tRoles = useTranslations("roles");
  const [state, action, pending] = useActionState<MemberActionState, FormData>(
    inviteMemberAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("inviteTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-3 sm:flex-row">
          <label htmlFor="invite-email" className="sr-only">
            {t("emailLabel")}
          </label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={t("emailPlaceholder")}
            required
            className="sm:max-w-xs"
          />
          <label htmlFor="invite-role" className="sr-only">
            {t("roleLabel")}
          </label>
          <select
            id="invite-role"
            name="role"
            defaultValue="MEMBER"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {tRoles(r)}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={pending}>
            {pending ? t("sending") : t("send")}
          </Button>
        </form>
        {state.error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {t(`errors.${INVITE_ERRORS.has(state.error) ? state.error : "invite_failed"}` as never)}
          </p>
        ) : null}
        {state.message === "invited" ? (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            {t("invited")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
