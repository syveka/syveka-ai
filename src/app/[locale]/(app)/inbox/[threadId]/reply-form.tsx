"use client";

import { useActionState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { createDraftMessageAction, type InboxActionState } from "@/actions/inbox";
import { Button } from "@/components/ui/button";

const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function ReplyForm({ threadId }: { threadId: string }) {
  const t = useTranslations("inbox");
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    createDraftMessageAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.message === "drafted") formRef.current?.reset();
  }, [state.message]);

  return (
    <form ref={formRef} action={action} className="space-y-2">
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="aiGenerated" value="false" />
      <textarea
        name="body"
        rows={3}
        maxLength={10_000}
        required
        placeholder={t("detail.replyPlaceholder")}
        className={TEXTAREA_CLASS}
      />
      {state.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("detail.saving") : t("detail.saveDraft")}
      </Button>
    </form>
  );
}
