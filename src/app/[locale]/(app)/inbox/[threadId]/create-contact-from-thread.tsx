"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { createContactFromThreadAction, type InboxActionState } from "@/actions/inbox";
import { Button } from "@/components/ui/button";

const INPUT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** Explicit operator action only — never runs automatically, so a spam or
 * unknown sender never silently becomes a CRM contact. Shown only when the
 * thread has no linked contact yet. */
export function CreateContactFromThread({ threadId }: { threadId: string }) {
  const t = useTranslations("inbox");
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    createContactFromThreadAction.bind(null, threadId),
    {},
  );

  if (state.message === "contact_created") {
    return <p className="text-sm text-muted-foreground">{t("detail.createContactSuccess")}</p>;
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <label htmlFor={`firstName-${threadId}`} className="sr-only">
        {t("detail.createContactFirstName")}
      </label>
      <input
        id={`firstName-${threadId}`}
        name="firstName"
        placeholder={t("detail.createContactFirstName")}
        required
        disabled={pending}
        className={INPUT_CLASS}
      />
      <label htmlFor={`lastName-${threadId}`} className="sr-only">
        {t("detail.createContactLastName")}
      </label>
      <input
        id={`lastName-${threadId}`}
        name="lastName"
        placeholder={t("detail.createContactLastName")}
        disabled={pending}
        className={INPUT_CLASS}
      />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? t("detail.saving") : t("detail.createContact")}
      </Button>
      {state.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
    </form>
  );
}
