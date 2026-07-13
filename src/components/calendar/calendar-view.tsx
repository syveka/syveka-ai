"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock, ChevronLeft, ChevronRight, Phone, Search, Sparkles } from "lucide-react";
import { useRouter, usePathname } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EventDialog, type EventOptions } from "./event-dialog";
import { AssistantPanel } from "./assistant-panel";
import { cn } from "@/lib/utils";

export type CalEvent = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  source: string;
  status: string;
  timezone: string;
  location: string | null;
  description: string | null;
  recurrenceRule: string | null;
  isOccurrence: boolean;
  contactId: string | null;
  companyId: string | null;
  dealId: string | null;
  ownerId: string | null;
  attendees: Array<{ contactId: string | null; email: string | null; name: string | null }>;
};

type View = "day" | "week" | "month" | "agenda";
const VIEWS: View[] = ["day", "week", "month", "agenda"];

export function CalendarView({
  view,
  anchor,
  q,
  events,
  canWrite,
  canDelete,
  options,
}: {
  view: View;
  anchor: string; // YYYY-MM-DD
  q: string;
  events: CalEvent[];
  canWrite: boolean;
  canDelete: boolean;
  options: EventOptions;
}) {
  const locale = useLocale();
  const t = useTranslations("calendar");
  const router = useRouter();
  const pathname = usePathname();
  const [dialog, setDialog] = useState<{ date?: string; event?: CalEvent } | null>(null);
  const [prefill, setPrefill] = useState<{ startsAt: string; endsAt: string } | null>(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [search, setSearch] = useState(q);

  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  const today = new Date().toISOString().slice(0, 10);

  const setParams = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const next = { view, date: anchor, q: search || undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    router.replace(`${pathname}?${params.toString()}`);
  };

  const navigate = (delta: number) => {
    const d = new Date(anchorDate);
    if (view === "month") d.setUTCMonth(d.getUTCMonth() + delta);
    else d.setUTCDate(d.getUTCDate() + delta * (view === "day" ? 1 : view === "week" ? 7 : 30));
    setParams({ date: d.toISOString().slice(0, 10) });
  };

  const visible = useMemo(() => events.filter((e) => e.status !== "CANCELED"), [events]);
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of visible) {
      const key = e.startsAt.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return map;
  }, [visible]);

  const headerLabel = new Intl.DateTimeFormat(locale, {
    ...(view === "month"
      ? { month: "long" as const, year: "numeric" as const }
      : { day: "numeric" as const, month: "long" as const, year: "numeric" as const }),
    timeZone: "UTC",
  }).format(anchorDate);

  const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label={t("previous")}
          >
            <ChevronLeft className="size-4 rtl:rotate-180" />
          </Button>
          <Button variant="ghost" onClick={() => setParams({ date: today })}>
            {t("today")}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => navigate(1)} aria-label={t("next")}>
            <ChevronRight className="size-4 rtl:rotate-180" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium capitalize sm:min-w-44">
            {headerLabel}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-md border" role="tablist">
            {VIEWS.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={v === view}
                onClick={() => setParams({ view: v })}
                className={cn(
                  "px-2.5 py-1.5 text-xs font-medium capitalize",
                  v === view ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                {t(`views.${v}`)}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setParams({ q: search || undefined });
            }}
            className="relative"
          >
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="h-8 w-40 ps-8 sm:w-52"
              aria-label={t("searchPlaceholder")}
            />
          </form>
          {canWrite ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setAssistantOpen((v) => !v)}>
                <Sparkles className="me-1.5 size-4" />
                {t("assistant.button")}
              </Button>
              <Button size="sm" onClick={() => setDialog({ date: anchor })}>
                {t("newEvent")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {assistantOpen ? (
        <AssistantPanel
          onPickSlot={(startIso, endIso) => {
            setAssistantOpen(false);
            setPrefill({ startsAt: startIso.slice(0, 16), endsAt: endIso.slice(0, 16) });
            setDialog({ date: startIso.slice(0, 10) });
          }}
        />
      ) : null}

      {view === "month" ? (
        <MonthGrid
          anchor={anchorDate}
          eventsByDay={eventsByDay}
          today={today}
          locale={locale}
          canWrite={canWrite}
          onDayClick={(day) => canWrite && setDialog({ date: day })}
          onEventClick={(e) => setDialog({ event: e })}
        />
      ) : view === "agenda" ? (
        <AgendaList
          eventsByDay={eventsByDay}
          locale={locale}
          timeFmt={timeFmt}
          emptyLabel={t("noMeetings")}
          onEventClick={(e) => setDialog({ event: e })}
        />
      ) : (
        <DayColumns
          days={view === "day" ? [anchor] : weekDays(anchorDate)}
          eventsByDay={eventsByDay}
          locale={locale}
          timeFmt={timeFmt}
          today={today}
          canWrite={canWrite}
          onDayClick={(day) => canWrite && setDialog({ date: day })}
          onEventClick={(e) => setDialog({ event: e })}
        />
      )}

      {dialog ? (
        <EventDialog
          date={dialog.date}
          event={dialog.event}
          prefill={prefill}
          canWrite={canWrite}
          canDelete={canDelete}
          options={options}
          onClose={() => {
            setDialog(null);
            setPrefill(null);
          }}
        />
      ) : null}
    </div>
  );
}

function weekDays(anchor: Date): string[] {
  const offset = (anchor.getUTCDay() + 6) % 7;
  const monday = new Date(anchor.getTime() - offset * 86_400_000);
  return Array.from({ length: 7 }, (_, i) =>
    new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10),
  );
}

function EventChip({
  event,
  timeFmt,
  onClick,
}: {
  event: CalEvent;
  timeFmt: Intl.DateTimeFormat;
  onClick: () => void;
}) {
  return (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-start text-xs",
        event.source === "VOICE_AI"
          ? "bg-success/15 text-success"
          : event.source === "BOOKING"
            ? "bg-primary/15 text-primary"
            : "bg-primary/10 text-primary",
      )}
    >
      {event.source === "VOICE_AI" ? <Phone className="size-3 shrink-0" /> : null}
      {event.source === "BOOKING" ? <CalendarClock className="size-3 shrink-0" /> : null}
      <span className="truncate">
        {!event.allDay ? `${timeFmt.format(new Date(event.startsAt))} ` : ""}
        {event.title}
      </span>
    </button>
  );
}

function MonthGrid({
  anchor,
  eventsByDay,
  today,
  locale,
  canWrite,
  onDayClick,
  onEventClick,
}: {
  anchor: Date;
  eventsByDay: Map<string, CalEvent[]>;
  today: string;
  locale: string;
  canWrite: boolean;
  onDayClick: (day: string) => void;
  onEventClick: (e: CalEvent) => void;
}) {
  const month = anchor.getUTCMonth();
  const weeks = buildMonthGrid(anchor.getUTCFullYear(), month);
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });

  return (
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
            onClick={() => onDayClick(day)}
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
                <EventChip
                  key={`${e.id}-${e.startsAt}`}
                  event={e}
                  timeFmt={timeFmt}
                  onClick={() => onEventClick(e)}
                />
              ))}
              {dayEvents.length > 3 ? (
                <p className="px-1.5 text-xs text-muted-foreground">+{dayEvents.length - 3}</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayColumns({
  days,
  eventsByDay,
  locale,
  timeFmt,
  today,
  canWrite,
  onDayClick,
  onEventClick,
}: {
  days: string[];
  eventsByDay: Map<string, CalEvent[]>;
  locale: string;
  timeFmt: Intl.DateTimeFormat;
  today: string;
  canWrite: boolean;
  onDayClick: (day: string) => void;
  onEventClick: (e: CalEvent) => void;
}) {
  const dayFmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-lg border bg-border",
        days.length === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-7",
      )}
    >
      {days.map((day) => {
        const dayEvents = (eventsByDay.get(day) ?? []).sort((a, b) =>
          a.startsAt.localeCompare(b.startsAt),
        );
        return (
          <div
            key={day}
            onClick={() => onDayClick(day)}
            className={cn("min-h-40 bg-background p-2", canWrite && "cursor-pointer")}
          >
            <p
              className={cn(
                "mb-2 text-xs font-medium",
                day === today ? "text-primary" : "text-muted-foreground",
              )}
            >
              {dayFmt.format(new Date(`${day}T12:00:00Z`))}
            </p>
            <div className="space-y-1">
              {dayEvents.map((e) => (
                <div key={`${e.id}-${e.startsAt}`}>
                  <EventChip event={e} timeFmt={timeFmt} onClick={() => onEventClick(e)} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AgendaList({
  eventsByDay,
  locale,
  timeFmt,
  emptyLabel,
  onEventClick,
}: {
  eventsByDay: Map<string, CalEvent[]>;
  locale: string;
  timeFmt: Intl.DateTimeFormat;
  emptyLabel: string;
  onEventClick: (e: CalEvent) => void;
}) {
  const dayFmt = new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" });
  const days = [...eventsByDay.keys()].sort();
  if (days.length === 0) {
    return (
      <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {days.map((day) => (
        <div key={day} className="rounded-lg border">
          <p className="border-b bg-muted/40 px-3 py-2 text-xs font-medium capitalize text-muted-foreground">
            {dayFmt.format(new Date(`${day}T12:00:00Z`))}
          </p>
          <ul className="divide-y">
            {(eventsByDay.get(day) ?? [])
              .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
              .map((e) => (
                <li key={`${e.id}-${e.startsAt}`}>
                  <button
                    onClick={() => onEventClick(e)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-start hover:bg-accent/40"
                  >
                    <span className="w-24 shrink-0 text-xs tabular-nums text-muted-foreground">
                      {e.allDay
                        ? "—"
                        : `${timeFmt.format(new Date(e.startsAt))}–${timeFmt.format(new Date(e.endsAt))}`}
                    </span>
                    <span className="truncate text-sm">{e.title}</span>
                    {e.location ? (
                      <span className="truncate text-xs text-muted-foreground">{e.location}</span>
                    ) : null}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
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
