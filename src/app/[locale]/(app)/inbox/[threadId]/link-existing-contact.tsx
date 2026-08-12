"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  linkThreadToContactAction,
  searchContactsForLinkAction,
  type ContactSearchState,
  type InboxActionState,
} from "@/actions/inbox";
import { Button } from "@/components/ui/button";

const INPUT_CLASS =
  "h-8 rounded-md border border-input bg-transparent px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** Counterpart to `CreateContactFromThread` for the case the customer is
 * already a known CRM contact under a different address than the one
 * auto-match compares against — search-then-link, both steps explicit
 * operator actions. */
export function LinkExistingContact({ threadId }: { threadId: string }) {
  const t = useTranslations("inbox");
  const [searchState, searchAction, searching] = useActionState<ContactSearchState, FormData>(
    searchContactsForLinkAction,
    { results: [] },
  );
  const [linkState, linkAction, linking] = useActionState<InboxActionState, FormData>(
    linkThreadToContactAction.bind(null, threadId),
    {},
  );

  if (linkState.message === "contact_linked") {
    return <p className="text-sm text-muted-foreground">{t("detail.linkContactSuccess")}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <form action={searchAction} className="flex flex-wrap items-center gap-2">
        <label htmlFor={`link-contact-search-${threadId}`} className="sr-only">
          {t("detail.searchExistingContact")}
        </label>
        <input
          id={`link-contact-search-${threadId}`}
          name="query"
          placeholder={t("detail.searchExistingContact")}
          disabled={searching}
          className={INPUT_CLASS}
        />
        <Button type="submit" size="sm" variant="outline" disabled={searching}>
          {searching ? t("detail.saving") : t("detail.search")}
        </Button>
      </form>
      {searchState.results.length > 0 ? (
        <ul className="space-y-1">
          {searchState.results.map((contact) => (
            <li key={contact.id} className="flex items-center gap-2 text-sm">
              <span>
                {contact.name}
                {contact.email ? ` · ${contact.email}` : ""}
              </span>
              <form action={linkAction}>
                <input type="hidden" name="contactId" value={contact.id} />
                <Button type="submit" size="sm" variant="ghost" disabled={linking}>
                  {t("detail.linkContact")}
                </Button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
      {linkState.error ? <p className="text-sm text-destructive">{t("detail.error")}</p> : null}
    </div>
  );
}
