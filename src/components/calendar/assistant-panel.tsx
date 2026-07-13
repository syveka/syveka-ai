"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { schedulingAssistantAction, type AssistantActionState } from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

/** Booking Assistant: natural-language scheduling with real slot suggestions. */
export function AssistantPanel({
  onPickSlot,
}: {
  onPickSlot: (startIso: string, endIso: string) => void;
}) {
  const t = useTranslations("calendar");
  const locale = useLocale();
  const [state, action, pending] = useActionState<AssistantActionState, FormData>(
    schedulingAssistantAction,
    {},
  );

  const fmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...(state.timezone ? { timeZone: state.timezone } : {}),
  });

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <form action={action} className="flex gap-2">
          <Input
            name="request"
            placeholder={t("assistant.placeholder")}
            required
            minLength={3}
            maxLength={500}
            aria-label={t("assistant.placeholder")}
          />
          <Button type="submit" disabled={pending}>
            <Sparkles className="me-1.5 size-4" />
            {pending ? t("assistant.thinking") : t("assistant.ask")}
          </Button>
        </form>

        {state.reply ? <p className="whitespace-pre-wrap text-sm">{state.reply}</p> : null}
        {state.slots && state.slots.length > 0 ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t("assistant.suggested")}
              {state.timezone ? ` (${state.timezone})` : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {state.slots.map((s) => (
                <Button
                  key={s.startsAt}
                  variant="outline"
                  size="sm"
                  onClick={() => onPickSlot(s.startsAt, s.endsAt)}
                >
                  {fmt.format(new Date(s.startsAt))}
                </Button>
              ))}
            </div>
          </div>
        ) : state.slots && state.slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("assistant.noSlots")}</p>
        ) : null}
        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("assistant.error")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
