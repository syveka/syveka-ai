"use client";

import type { RefObject } from "react";
import { useTranslations } from "next-intl";

/**
 * Appends a real, live public booking link to the given textarea — never a
 * fabricated time/slot; availability is computed live when the customer
 * opens the link, through the public booking flow's own protections. Shared
 * between `ReplyForm` (composing a new reply) and `DraftMessageBody`
 * (editing an existing AI or human draft) so the control and its behavior
 * stay identical everywhere an operator is writing to a customer.
 */
export function InsertBookingLinkControl({
  fieldId,
  textareaRef,
  bookingTypes,
  bookingBaseUrl,
}: {
  fieldId: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  bookingTypes: { slug: string; name: string }[];
  bookingBaseUrl?: string;
}) {
  const t = useTranslations("inbox");
  if (bookingTypes.length === 0) return null;

  function insertBookingLink(slug: string) {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const link = `${bookingBaseUrl}/${slug}`;
    const separator = textarea.value && !textarea.value.endsWith("\n") ? "\n" : "";
    textarea.value += `${separator}${link}`;
    textarea.focus();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={fieldId} className="text-xs text-muted-foreground">
        {t("detail.insertBookingLink")}
      </label>
      <select
        id={fieldId}
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
  );
}
