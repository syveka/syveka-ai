"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { assignThreadAction, type InboxActionState } from "@/actions/inbox";
import { Button } from "@/components/ui/button";

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function AssignmentControls({
  threadId,
  assignedToId,
  currentUserId,
  members,
}: {
  threadId: string;
  assignedToId: string | null;
  currentUserId: string;
  members: { id: string; name: string }[];
}) {
  const t = useTranslations("inbox");
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    assignThreadAction.bind(null, threadId),
    {},
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={action} className="flex items-center gap-2">
        <label htmlFor={`assignedToId-${threadId}`} className="sr-only">
          {t("detail.assignee")}
        </label>
        <select
          id={`assignedToId-${threadId}`}
          name="assignedToId"
          defaultValue={assignedToId ?? ""}
          disabled={pending}
          className={SELECT_CLASS}
        >
          <option value="">{t("detail.unassigned")}</option>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? t("detail.saving") : t("detail.saveAssignment")}
        </Button>
      </form>
      {assignedToId !== currentUserId ? (
        <form action={action}>
          <input type="hidden" name="assignedToId" value={currentUserId} />
          <Button type="submit" size="sm" variant="ghost" disabled={pending}>
            {t("detail.assignToMe")}
          </Button>
        </form>
      ) : null}
      {state.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
    </div>
  );
}
