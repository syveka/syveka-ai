"use client";

import { useId, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Picks CRM contacts as meeting attendees: the chosen ones are listed as chips
 * with their own remove button (plus "Clear all"), and every contact is a
 * plain checkbox in a filterable list. Replaces a native multi-select, whose
 * Ctrl/long-press selection was unclear on phones. It only reports the chosen
 * ids; the dialog still submits them in its own hidden `attendees` field.
 */
export function AttendeePicker({
  contacts,
  selectedIds,
  onChange,
  disabled,
}: {
  contacts: Array<{ id: string; name: string }>;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("calendar.attendeePicker");
  const tf = useTranslations("calendar.fields");
  const labelId = useId();
  const [filter, setFilter] = useState("");

  const nameById = useMemo(() => new Map(contacts.map((c) => [c.id, c.name])), [contacts]);
  const selected = new Set(selectedIds);
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle
    ? contacts.filter((c) => c.name.toLocaleLowerCase().includes(needle))
    : contacts;

  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...selectedIds, id] : selectedIds.filter((v) => v !== id));

  return (
    <fieldset className="min-w-0 space-y-2" aria-labelledby={labelId} disabled={disabled}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span id={labelId} className="text-sm font-medium leading-none">
          {tf("attendees")}
        </span>
        {selectedIds.length > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-10 px-3 text-xs"
            onClick={() => onChange([])}
          >
            {t("clear")}
          </Button>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t("selectedCount", { count: selectedIds.length })}
      </p>

      {selectedIds.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("selectedList")}>
          {selectedIds.map((id) => {
            const name = nameById.get(id) ?? t("unknownContact");
            return (
              <li
                key={id}
                className="flex min-w-0 max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pe-1 ps-2.5 text-xs text-primary"
              >
                <span className="truncate">{name}</span>
                <button
                  type="button"
                  onClick={() => toggle(id, false)}
                  aria-label={t("remove", { name })}
                  className="-my-2 -me-1.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {contacts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("noContacts")}</p>
      ) : (
        <>
          {contacts.length > 6 ? (
            <Input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                // This filter sits inside the event form: Enter (or a phone
                // keyboard's Search key) must not save a half-filled event.
                if (e.key === "Enter") e.preventDefault();
              }}
              enterKeyHint="search"
              aria-label={t("filter")}
              placeholder={t("filter")}
            />
          ) : null}
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-md border p-1">
            {shown.map((c) => (
              <li key={c.id}>
                <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/40">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={selected.has(c.id)}
                    onChange={(e) => toggle(c.id, e.target.checked)}
                  />
                  <span className="min-w-0 break-words">{c.name}</span>
                </label>
              </li>
            ))}
            {shown.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-muted-foreground">{t("noMatches")}</li>
            ) : null}
          </ul>
        </>
      )}
    </fieldset>
  );
}
