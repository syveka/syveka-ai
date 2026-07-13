"use client";

import { useActionState, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import {
  saveScheduleAction,
  deleteScheduleAction,
  type AvailabilityActionState,
} from "@/actions/availability";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Rule = { weekday: number; startMinute: number; endMinute: number };
type Override = {
  date: string;
  startMinute: number | null;
  endMinute: number | null;
  isUnavailable: boolean;
};
export type ScheduleData = {
  id: string;
  name: string;
  timezone: string;
  isDefault: boolean;
  rules: Rule[];
  overrides: Override[];
};

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday-first

function minutesToTime(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function timeToMinutes(v: string): number {
  const [h, m] = v.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function AvailabilityEditor({ schedules }: { schedules: ScheduleData[] }) {
  const t = useTranslations("calendar");
  const first: ScheduleData | undefined = schedules[0];
  const [selectedId, setSelectedId] = useState<string | "new">(first ? first.id : "new");
  const selected = schedules.find((s) => s.id === selectedId);

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <div className="space-y-2">
        {schedules.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            className={`block w-full rounded-md border px-3 py-2 text-start text-sm ${
              s.id === selectedId ? "border-primary bg-primary/5" : "hover:bg-accent"
            }`}
          >
            <span className="font-medium">{s.name}</span>
            {s.isDefault ? (
              <span className="ms-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {t("availability.default")}
              </span>
            ) : null}
            <span className="block text-xs text-muted-foreground">{s.timezone}</span>
          </button>
        ))}
        <Button variant="outline" className="w-full" onClick={() => setSelectedId("new")}>
          <Plus className="me-1.5 size-4" />
          {t("availability.newSchedule")}
        </Button>
      </div>

      <ScheduleForm
        key={selectedId}
        schedule={selectedId === "new" ? undefined : selected}
        canDelete={schedules.length > 0 && selectedId !== "new"}
      />
    </div>
  );
}

function ScheduleForm({ schedule, canDelete }: { schedule?: ScheduleData; canDelete: boolean }) {
  const t = useTranslations("calendar");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<AvailabilityActionState, FormData>(
    saveScheduleAction.bind(null, schedule?.id),
    {},
  );

  const browserTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Helsinki",
    [],
  );
  const [rules, setRules] = useState<Rule[]>(
    schedule?.rules ??
      [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
  );
  const [overrides, setOverrides] = useState<Override[]>(schedule?.overrides ?? []);

  const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" });
  const weekdayName = (d: number) => weekdayFmt.format(new Date(Date.UTC(2024, 0, 7 + d))); // 2024-01-07 = Sunday

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {schedule ? schedule.name : t("availability.newSchedule")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <input type="hidden" name="rules" value={JSON.stringify(rules)} />
          <input type="hidden" name="overrides" value={JSON.stringify(overrides)} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="name">{t("availability.name")}</Label>
              <Input id="name" name="name" defaultValue={schedule?.name ?? ""} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">{t("fields.timezone")}</Label>
              <Input
                id="timezone"
                name="timezone"
                defaultValue={schedule?.timezone ?? browserTz}
                required
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="isDefault"
              value="true"
              defaultChecked={schedule?.isDefault ?? true}
              className="size-4"
            />
            {t("availability.makeDefault")}
          </label>

          <div>
            <p className="mb-2 text-sm font-medium">{t("availability.weeklyHours")}</p>
            <div className="space-y-2">
              {WEEKDAYS.map((weekday) => {
                const dayRules = rules.filter((r) => r.weekday === weekday);
                return (
                  <div key={weekday} className="flex flex-wrap items-center gap-2">
                    <span className="w-28 text-sm capitalize">{weekdayName(weekday)}</span>
                    {dayRules.length === 0 ? (
                      <span className="text-sm text-muted-foreground">
                        {t("availability.unavailable")}
                      </span>
                    ) : (
                      dayRules.map((rule, i) => (
                        <span key={i} className="flex items-center gap-1">
                          <Input
                            type="time"
                            value={minutesToTime(rule.startMinute)}
                            onChange={(e) =>
                              setRules((prev) =>
                                prev.map((r) =>
                                  r === rule
                                    ? { ...r, startMinute: timeToMinutes(e.target.value) }
                                    : r,
                                ),
                              )
                            }
                            className="h-8 w-28"
                            aria-label={t("fields.start")}
                          />
                          –
                          <Input
                            type="time"
                            value={minutesToTime(rule.endMinute)}
                            onChange={(e) =>
                              setRules((prev) =>
                                prev.map((r) =>
                                  r === rule
                                    ? { ...r, endMinute: timeToMinutes(e.target.value) }
                                    : r,
                                ),
                              )
                            }
                            className="h-8 w-28"
                            aria-label={t("fields.end")}
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={tc("delete")}
                            onClick={() => setRules((prev) => prev.filter((r) => r !== rule))}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </span>
                      ))
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setRules((prev) => [
                          ...prev,
                          { weekday, startMinute: 540, endMinute: 1020 },
                        ])
                      }
                    >
                      <Plus className="size-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">{t("availability.overrides")}</p>
            <div className="space-y-2">
              {overrides.map((o, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                  <Input
                    type="date"
                    value={o.date}
                    onChange={(e) =>
                      setOverrides((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)),
                      )
                    }
                    className="h-8 w-40"
                    aria-label={t("availability.date")}
                  />
                  <label className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={o.isUnavailable}
                      onChange={(e) =>
                        setOverrides((prev) =>
                          prev.map((x, j) =>
                            j === i ? { ...x, isUnavailable: e.target.checked } : x,
                          ),
                        )
                      }
                      className="size-4"
                    />
                    {t("availability.unavailable")}
                  </label>
                  {!o.isUnavailable ? (
                    <>
                      <Input
                        type="time"
                        value={minutesToTime(o.startMinute ?? 540)}
                        onChange={(e) =>
                          setOverrides((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, startMinute: timeToMinutes(e.target.value) } : x,
                            ),
                          )
                        }
                        className="h-8 w-28"
                        aria-label={t("fields.start")}
                      />
                      –
                      <Input
                        type="time"
                        value={minutesToTime(o.endMinute ?? 1020)}
                        onChange={(e) =>
                          setOverrides((prev) =>
                            prev.map((x, j) =>
                              j === i ? { ...x, endMinute: timeToMinutes(e.target.value) } : x,
                            ),
                          )
                        }
                        className="h-8 w-28"
                        aria-label={t("fields.end")}
                      />
                    </>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={tc("delete")}
                    onClick={() => setOverrides((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setOverrides((prev) => [
                    ...prev,
                    {
                      date: new Date().toISOString().slice(0, 10),
                      startMinute: 540,
                      endMinute: 1020,
                      isUnavailable: false,
                    },
                  ])
                }
              >
                <Plus className="me-1.5 size-4" />
                {t("availability.addOverride")}
              </Button>
            </div>
          </div>

          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error === "overlapping_rules"
                ? t("availability.overlapError")
                : state.error === "invalid_timezone"
                  ? t("availability.timezoneError")
                  : tc("error")}
            </p>
          ) : null}
          {state.message === "saved" ? (
            <p className="text-sm text-primary">{t("availability.saved")}</p>
          ) : null}

          <div className="flex justify-between pt-2">
            {schedule && canDelete ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive"
                onClick={() => void deleteScheduleAction(schedule.id)}
              >
                {tc("delete")}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={pending}>
              {pending ? tc("loading") : tc("save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
