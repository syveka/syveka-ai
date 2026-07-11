"use client";

import { useActionState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { saveEventAction, deleteEventAction, type CalendarActionState } from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CalEvent } from "./calendar-view";

export function EventDialog({
  date,
  event,
  canWrite,
  onClose,
}: {
  date?: string;
  event?: CalEvent;
  canWrite: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("calendar");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<CalendarActionState, FormData>(
    saveEventAction.bind(null, event?.id),
    {},
  );

  useEffect(() => {
    if (state.message === "saved") onClose();
  }, [state.message, onClose]);

  const defaultStart = event ? event.startsAt.slice(0, 16) : `${date}T09:00`;
  const defaultEnd = event ? event.endsAt.slice(0, 16) : `${date}T10:00`;
  const readOnly = !canWrite || event?.source === "VOICE_AI";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{event ? event.title : t("newEvent")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
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
            <div className="space-y-1.5">
              <Label htmlFor="location">{t("fields.location")}</Label>
              <Input id="location" name="location" disabled={readOnly} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">{t("fields.description")}</Label>
              <textarea
                id="description"
                name="description"
                rows={3}
                disabled={readOnly}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>
            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {tc("error")}
              </p>
            ) : null}
            <div className="flex justify-between pt-2">
              {event && canWrite ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    void deleteEventAction(event.id).then(onClose);
                  }}
                >
                  {tc("delete")}
                </Button>
              ) : (
                <span />
              )}
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
