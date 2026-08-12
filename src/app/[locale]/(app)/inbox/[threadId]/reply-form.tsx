"use client";

import { useActionState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { createDraftMessageAction, type InboxActionState } from "@/actions/inbox";
import { Button } from "@/components/ui/button";

const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export function ReplyForm({
  threadId,
  bookingTypes = [],
  bookingBaseUrl,
}: {
  threadId: string;
  /** Active booking types the operator can hand off to — empty when the
   * viewer lacks `booking:manage` or the org has none configured. */
  bookingTypes?: { slug: string; name: string }[];
  bookingBaseUrl?: string;
}) {
  const t = useTranslations("inbox");
  const [state, action, pending] = useActionState<InboxActionState, FormData>(
    createDraftMessageAction,
    {},
  );
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state.message === "drafted") formRef.current?.reset();
  }, [state.message]);

  /** Appends the real, live public booking link to the reply text — never a
   * fabricated time/slot. Availability is computed live when the customer
   * opens the link, through the existing public booking flow's own
   * rate-limiting/consent/double-booking protections; nothing here creates
   * a booking or claims a slot on the customer's behalf. */
  function insertBookingLink(slug: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const link = `${bookingBaseUrl}/${slug}`;
    const separator = textarea.value && !textarea.value.endsWith("\n") ? "\n" : "";
    textarea.value += `${separator}${link}`;
    textarea.focus();
  }

  return (
    <form ref={formRef} action={action} className="space-y-2">
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="aiGenerated" value="false" />
      <textarea
        ref={textareaRef}
        name="body"
        rows={3}
        maxLength={10_000}
        required
        placeholder={t("detail.replyPlaceholder")}
        className={TEXTAREA_CLASS}
      />
      {bookingTypes.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`booking-link-${threadId}`} className="text-xs text-muted-foreground">
            {t("detail.insertBookingLink")}
          </label>
          <select
            id={`booking-link-${threadId}`}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            defaultValue=""
            onChange={(e) => {
              if (e.target.value) insertBookingLink(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="" disabled>
              {t("detail.chooseBookingType")}
            </option>
            {bookingTypes.map((bt) => (
              <option key={bt.slug} value={bt.slug}>
                {bt.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {state.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("detail.saving") : t("detail.saveDraft")}
      </Button>
    </form>
  );
}
