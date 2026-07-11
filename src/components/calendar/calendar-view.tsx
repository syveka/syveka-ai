"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Phone } from "lucide-react";
import { useRouter, usePathname } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { EventDialog } from "./event-dialog";
import { cn } from "@/lib/utils";

export type CalEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  source: string;
};

export function CalendarView({
  year,
  month,
  events,
  canWrite,
}: {
  year: number;
  month: number; // 0-based
  events: CalEvent[];
  canWrite: boolean;
}) {
  const locale = useLocale();
  const t = useTranslations("calendar");
  const router = useRouter();
  const pathname = usePathname();
  const [dialog, setDialog] = useState<{ date?: string; event?: CalEvent } | null>(null);

  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      const key = e.startsAt.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [events]);

  const navigate = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1));
    router.replace(`${pathname}?month=${d.toISOString().slice(0, 7)}`);
  };

  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month, 1)));

  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="previous">
            <ChevronLeft className="size-4 rtl:rotate-180" />
          </Button>
          <span className="min-w-40 text-center font-medium capitalize">{monthLabel}</span>
          <Button variant="ghost" size="icon" onClick={() => navigate(1)} aria-label="next">
            <ChevronRight className="size-4 rtl:rotate-180" />
          </Button>
        </div>
        {canWrite ? (
          <Button onClick={() => setDialog({ date: today })}>{t("newEvent")}</Button>
        ) : null}
      </div>

      <div className="grid grid-cols-7 overflow-hidden rounded-lg border text-sm">
        {weeks[0]!.map((day) => (
          <div
            key={day}
            className="border-b bg-muted/40 p-2 text-center text-xs font-medium text-muted-foreground"
          >
            {weekdayFmt.format(new Date(`${day}T12:00:00Z`))}
          </div>
        ))}
        {weeks.flat().map((day) => {
          const inMonth = new Date(`${day}T12:00:00Z`).getUTCMonth() === month;
          const dayEvents = eventsByDay.get(day) ?? [];
          return (
            <div
              key={day}
              onClick={() => canWrite && setDialog({ date: day })}
              className={cn(
                "min-h-24 border-b border-e p-1.5 align-top",
                !inMonth && "bg-muted/30 text-muted-foreground",
                canWrite && "cursor-pointer hover:bg-accent/40",
              )}
            >
              <span
                className={cn(
                  "inline-flex size-6 items-center justify-center rounded-full text-xs",
                  day === today && "bg-primary font-semibold text-primary-foreground",
                )}
              >
                {Number(day.slice(8, 10))}
              </span>
              <div className="mt-1 space-y-1">
                {dayEvents.slice(0, 3).map((e) => (
                  <button
                    key={e.id}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      setDialog({ event: e });
                    }}
                    className={cn(
                      "flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-start text-xs",
                      e.source === "VOICE_AI"
                        ? "bg-success/15 text-success"
                        : "bg-primary/10 text-primary",
                    )}
                  >
                    {e.source === "VOICE_AI" ? <Phone className="size-3 shrink-0" /> : null}
                    <span className="truncate">
                      {!e.allDay ? `${e.startsAt.slice(11, 16)} ` : ""}
                      {e.title}
                    </span>
                  </button>
                ))}
                {dayEvents.length > 3 ? (
                  <p className="px-1.5 text-xs text-muted-foreground">+{dayEvents.length - 3}</p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {dialog ? (
        <EventDialog
          date={dialog.date}
          event={dialog.event}
          canWrite={canWrite}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

/** Monday-first month grid (§20: first-day-of-week Monday). */
function buildMonthGrid(year: number, month: number): string[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Mon=0
  const start = new Date(Date.UTC(year, month, 1 - offset));
  const weeks: string[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < 6; w++) {
    const week: string[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
    if (cursor.getUTCMonth() !== month && w >= 4) break;
  }
  return weeks;
}
