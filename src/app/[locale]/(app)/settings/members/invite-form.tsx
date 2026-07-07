"use client";

import { useActionState } from "react";
import { inviteMemberAction, type MemberActionState } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ROLES = ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;

export function InviteForm() {
  const [state, action, pending] = useActionState<MemberActionState, FormData>(
    inviteMemberAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite a team member</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-3 sm:flex-row">
          <Input name="email" type="email" placeholder="colleague@company.fi" required className="sm:max-w-xs" />
          <select
            name="role"
            defaultValue="MEMBER"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send invite"}
          </Button>
        </form>
        {state.error ? <p className="mt-2 text-sm text-destructive">{state.error}</p> : null}
        {state.message === "invited" ? (
          <p className="mt-2 text-sm text-muted-foreground">Invitation sent.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
