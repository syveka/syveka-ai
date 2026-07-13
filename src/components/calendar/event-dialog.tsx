"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  saveEventAction,
  cancelEventAction,
  deleteEventAction,
  type CalendarActionState,
} from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CalEvent } from "./calendar-view";

export type EventOptions = {
  owners: Array<{ id: string; name: string }>;
  contacts: Array<{ id: string; name: string }>;
  companies: Array<{ id: string; name: string }>;
  deals: Array<{ id: string; title: string }>;
};

const COMMON_TIMEZONES = [
  "Europe/Helsinki",
  "Europe/Stockholm",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Riyadh",
  "UTC",
];

const RECURRENCE_PRESETS: Array<{ value: string; key: string }> = [
  { value: "", key: "none" },
  { value: "FREQ=DAILY", key: "daily" },
  { value: "FREQ=WEEKLY", key: "weekly" },
  { value: "FREQ=WEEKLY;INTERVAL=2", key: "biweekly" },
  { value: "FREQ=MONTHLY", key: "monthly" },
];

export function EventDialog({
  date,
  event,
  prefill,
  canWrite,
  canDelete,
  options,
  onClose,
}: {
  date?: string;
  event?: CalEvent;
  prefill?: { startsAt: string; endsAt: string } | null;
  canWrite: boolean;
  canDelete: boolean;
  options: EventOptions;
  onClose: () => void;
}) {
  const t = useTranslations("calendar");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<CalendarActionState, FormData>(
    saveEventAction.bind(null, event?.id),
    {},
  );
  const [allowConflict, setAllowConflict] = useState(false);

  useEffect(() => {
    if (state.message === "saved") onClose();
  }, [state.message, onClose]);

  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Helsinki",
    [],
  );
  const timezones = useMemo(() => [...new Set([browserTz, ...COMMON_TIMEZONES])], [browserTz]);

  const defaultStart = prefill?.startsAt ?? (event ? event.startsAt.slice(0, 16) : `${date}T09:00`);
  const defaultEnd = prefill?.endsAt ?? (event ? event.endsAt.slice(0, 16) : `${date}T10:00`);
  const readOnly = !canWrite || event?.source === "VOICE_AI" || event?.source === "BOOKING";

  const initialAttendees = event?.attendees ?? [];
  const [attendeeContactIds, setAttendeeContactIds] = useState<string[]>(
    initialAttendees.map((a) => a.contactId).filter((v): v is string => Boolean(v)),
  );
  const [guestEmails, setGuestEmails] = useState<string>(
    initialAttendees
      .filter((a) => !a.contactId && a.email)
      .map((a) => a.email)
      .join(", "),
  );

  const attendeesJson = useMemo(() => {
    const rows: Array<{ contactId?: string; email?: string }> = attendeeContactIds.map((id) => ({
      contactId: id,
    }));
    for (const raw of guestEmails.split(",")) {
      const email = raw.trim();
      if (email && /.+@.+\..+/.test(email)) rows.push({ email });
    }
    return JSON.stringify(rows);
  }, [attendeeContactIds, guestEmails]);

  const selectClass =
    "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto">
        <CardHeader>
          <CardTitle>{event ? event.title : t("newEvent")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <input type="hidden" name="attendees" value={attendeesJson} />
            <input type="hidden" name="allowConflict" value={allowConflict ? "true" : "false"} />

            <div className="space-y-1.5">
              <Label htmlFor="title">{t("fields.title")}</Label>
              <Input
                id="title"
                name="title"
                defaultValue={event?.title}
                required
                disabled={readOnly}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="startsAt">{t("fields.start")}</Label>
                <Input
                  id="startsAt"
                  name="startsAt"
                  type="datetime-local"
                  defaultValue={defaultStart}
                  required
                  disabled={readOnly}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="endsAt">{t("fields.end")}</Label>
                <Input
                  id="endsAt"
                  name="endsAt"
                  type="datetime-local"
                  defaultValue={defaultEnd}
                  required
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="timezone">{t("fields.timezone")}</Label>
                <select
                  id="timezone"
                  name="timezone"
                  defaultValue={event?.timezone ?? browserTz}
                  disabled={readOnly}
                  className={selectClass}
                >
                  {timezones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="recurrenceRule">{t("fields.repeat")}</Label>
                <select
                  id="recurrenceRule"
                  name="recurrenceRule"
                  defaultValue={event?.recurrenceRule ?? ""}
                  disabled={readOnly || Boolean(event?.isOccurrence)}
                  className={selectClass}
                >
                  {RECURRENCE_PRESETS.map((r) => (
                    <option key={r.key} value={r.value}>
                      {t(`recurrence.${r.key}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="allDay"
                value="true"
                defaultChecked={event?.allDay}
                disabled={readOnly}
                className="size-4"
              />
              {t("fields.allDay")}
            </label>

            <div className="space-y-1.5">
              <Label htmlFor="location">{t("fields.location")}</Label>
              <Input
                id="location"
                name="location"
                defaultValue={event?.location ?? ""}
                disabled={readOnly}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ownerId">{t("fields.owner")}</Label>
                <select
                  id="ownerId"
                  name="ownerId"
                  defaultValue={event?.ownerId ?? ""}
                  disabled={readOnly}
                  className={selectClass}
                >
                  <option value="">{t("fields.me")}</option>
                  {options.owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="contactId">{t("fields.contact")}</Label>
                <select
                  id="contactId"
                  name="contactId"
                  defaultValue={event?.contactId ?? ""}
                  disabled={readOnly}
                  className={selectClass}
                >
                  <option value="">—</option>
                  {options.contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="companyId">{t("fields.company")}</Label>
                <select
                  id="companyId"
                  name="companyId"
                  defaultValue={event?.companyId ?? ""}
                  disabled={readOnly}
                  className={selectClass}
                >
                  <option value="">—</option>
                  {options.companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dealId">{t("fields.deal")}</Label>
                <select
                  id="dealId"
                  name="dealId"
                  defaultValue={event?.dealId ?? ""}
                  disabled={readOnly}
                  className={selectClass}
                >
                  <option value="">—</option>
                  {options.deals.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="attendeeContacts">{t("fields.attendees")}</Label>
              <select
                id="attendeeContacts"
                multiple
                value={attendeeContactIds}
                onChange={(e) =>
                  setAttendeeContactIds([...e.target.selectedOptions].map((o) => o.value))
                }
                disabled={readOnly}
                className={`${selectClass} min-h-20`}
              >
                {options.contacts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Input
                placeholder={t("fields.guestEmails")}
                value={guestEmails}
                onChange={(e) => setGuestEmails(e.target.value)}
                disabled={readOnly}
                aria-label={t("fields.guestEmails")}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="description">{t("fields.description")}</Label>
              <textarea
                id="description"
                name="description"
                rows={3}
                defaultValue={event?.description ?? ""}
                disabled={readOnly}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>

            {state.error === "conflict" ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              >
                <p className="font-medium text-destructive">{t("conflictWarning")}</p>
                <ul className="mt-1 list-inside list-disc text-muted-foreground">
                  {state.conflicts?.map((c) => (
                    <li key={c.id}>
                      {c.title} — {c.startsAt.slice(0, 16).replace("T", " ")}
                    </li>
                  ))}
                </ul>
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allowConflict}
                    onChange={(e) => setAllowConflict(e.target.checked)}
                    className="size-4"
                  />
                  {t("bookAnyway")}
                </label>
              </div>
            ) : state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {tc("error")}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-between gap-2 pt-2">
              <div className="flex gap-2">
                {event && canWrite && event.status !== "CANCELED" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void cancelEventAction(event.id).then(onClose)}
                  >
                    {t("cancelEvent")}
                  </Button>
                ) : null}
                {event && canDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive"
                    onClick={() => void deleteEventAction(event.id).then(onClose)}
                  >
                    {tc("delete")}
                  </Button>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  {tc("cancel")}
                </Button>
                {!readOnly ? (
                  <Button type="submit" disabled={pending}>
                    {pending ? tc("loading") : tc("save")}
                  </Button>
                ) : null}
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
