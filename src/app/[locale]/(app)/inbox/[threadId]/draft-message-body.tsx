"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { editDraftMessageAction, type InboxActionState } from "@/actions/inbox";
import { Button } from "@/components/ui/button";

const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function DraftMessageBody({ messageId, body }: { messageId: string; body: string }) {
  const t = useTranslations("inbox");
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    editDraftMessageAction.bind(null, messageId),
    {},
  );

  useEffect(() => {
    if (state.message === "edited") setEditing(false);
  }, [state.message]);

  if (!editing) {
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap text-sm">{body}</p>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t("detail.edit")}
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <textarea
        name="body"
        defaultValue={body}
        rows={4}
        maxLength={10_000}
        required
        disabled={pending}
        className={TEXTAREA_CLASS}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t("detail.saving") : t("detail.saveEdit")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setEditing(false)}
        >
          {t("detail.cancel")}
        </Button>
      </div>
      {state.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
    </form>
  );
}
