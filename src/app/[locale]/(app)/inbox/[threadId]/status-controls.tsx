"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateThreadStatusAction, type InboxActionState } from "@/actions/inbox";
import { INBOX_THREAD_STATUSES } from "@/lib/validators/inbox";
import { Button } from "@/components/ui/button";

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function StatusControls({ threadId, status }: { threadId: string; status: string }) {
  const t = useTranslations("inbox");
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    updateThreadStatusAction.bind(null, threadId),
    {},
  );

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <label htmlFor={`status-${threadId}`} className="sr-only">
        {t("detail.status")}
      </label>
      <select
        id={`status-${threadId}`}
        name="status"
        defaultValue={status}
        disabled={pending}
        className={SELECT_CLASS}
      >
        {INBOX_THREAD_STATUSES.map((value) => (
          <option key={value} value={value}>
            {t(`status.${value}`)}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? t("detail.saving") : t("detail.saveStatus")}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
    </form>
  );
}
