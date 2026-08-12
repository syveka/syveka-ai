"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { generateDraftAction, type InboxActionState } from "@/actions/inbox";
import { Button } from "@/components/ui/button";

export function GenerateDraftButton({
  threadId,
  hasUnsentDraft,
}: {
  threadId: string;
  hasUnsentDraft: boolean;
}) {
  const t = useTranslations("inbox");
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    generateDraftAction.bind(null, threadId),
    {},
  );

  return (
    <form action={action} className="space-y-2">
      <Button type="submit" variant="outline" disabled={pending}>
        {pending
          ? t("detail.generating")
          : hasUnsentDraft
            ? t("detail.regenerateDraft")
            : t("detail.generateDraft")}
      </Button>
      {state.error ? (
        <p className="text-sm text-destructive">{t("detail.generateFailed")}</p>
      ) : null}
    </form>
  );
}
