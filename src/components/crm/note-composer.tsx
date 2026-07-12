"use client";

import { useActionState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import type { CrmActionState } from "@/actions/contacts";
import { Button } from "@/components/ui/button";

export function NoteComposer({
  action,
}: {
  action: (prev: CrmActionState, formData: FormData) => Promise<CrmActionState>;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<CrmActionState, FormData>(action, {});

  useEffect(() => {
    if (state.message === "noteAdded") formRef.current?.reset();
  }, [state.message]);

  return (
    <form ref={formRef} action={formAction} className="space-y-2">
      <textarea
        name="body"
        required
        maxLength={4000}
        rows={3}
        placeholder={t("notePlaceholder")}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
      />
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {tc("error")}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? tc("loading") : t("addNote")}
        </Button>
      </div>
    </form>
  );
}
