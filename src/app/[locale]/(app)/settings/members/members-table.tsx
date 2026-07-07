"use client";

import { changeRoleAction, removeMemberAction } from "@/actions/members";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Member = { id: string; userId: string; email: string; name: string | null; role: string };
type Invite = { id: string; email: string; role: string };

const ASSIGNABLE = ["ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;

export function MembersTable({
  members,
  pendingInvites,
  currentUserId,
  canManage,
}: {
  members: Member[];
  pendingInvites: Invite[];
  currentUserId: string;
  canManage: boolean;
}) {
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {members.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{m.name ?? m.email}</p>
              <p className="truncate text-xs text-muted-foreground">{m.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {canManage && m.role !== "OWNER" && m.userId !== currentUserId ? (
                <form
                  action={async (fd: FormData) => {
                    fd.set("memberId", m.id);
                    await changeRoleAction({}, fd);
                  }}
                >
                  <select
                    name="role"
                    defaultValue={m.role}
                    onChange={(e) => e.currentTarget.form?.requestSubmit()}
                    className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                  >
                    {ASSIGNABLE.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </form>
              ) : (
                <span className="rounded-full bg-secondary px-2 py-1 text-xs">{m.role}</span>
              )}
              {canManage && m.role !== "OWNER" && m.userId !== currentUserId ? (
                <form action={removeMemberAction.bind(null, m.id)}>
                  <Button variant="ghost" size="sm" type="submit" className="text-destructive">
                    Remove
                  </Button>
                </form>
              ) : null}
            </div>
          </div>
        ))}
        {pendingInvites.map((i) => (
          <div key={i.id} className="flex items-center justify-between gap-3 p-4 opacity-60">
            <div>
              <p className="text-sm">{i.email}</p>
              <p className="text-xs text-muted-foreground">Pending · {i.role}</p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
