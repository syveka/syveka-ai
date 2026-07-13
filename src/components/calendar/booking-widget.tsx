"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Public guest booking widget: pick a day → pick a slot → enter details →
 * confirmation. Talks to the public /api/v1/booking endpoints; all times are
 * shown in the guest's browser timezone.
 */
export function BookingWidget({
  orgSlug,
  typeSlug,
  locale,
  durationMinutes,
  durationOptions,
  collectPhone,
  collectCompany,
  requiresConsent,
  brandColor,
}: {
  orgSlug: string;
  typeSlug: string;
  locale: string;
  durationMinutes: number;
  durationOptions: number[];
  collectPhone: boolean;
  collectCompany: boolean;
  requiresConsent: boolean;
  brandColor: string | null;
}) {
  const t = useTranslations("booking");
  const uiLocale = useLocale();
  const guestTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Europe/Helsinki",
    [],
  );

  const [duration, setDuration] = useState(durationMinutes);
  const [weekStart, setWeekStart] = useState(() => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  });
  const [slots, setSlots] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<{
    startsAt: string;
    manageToken: string;
    confirmationMessage: string | null;
  } | null>(null);

  const loadSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const from = weekStart.toISOString();
      const to = new Date(weekStart.getTime() + 7 * 86_400_000).toISOString();
      const res = await fetch(
        `/api/v1/booking/${orgSlug}/${typeSlug}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&duration=${duration}`,
      );
      if (!res.ok) throw new Error("slots");
      const data = (await res.json()) as { slots: string[] };
      setSlots(data.slots);
    } catch {
      setError(t("errors.loadFailed"));
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [weekStart, duration, orgSlug, typeSlug, t]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  const slotsByDay = useMemo(() => {
    const dayKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: guestTz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const map = new Map<string, string[]>();
    for (const s of slots) {
      const key = dayKey.format(new Date(s));
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return map;
  }, [slots, guestTz]);

  const dayFmt = new Intl.DateTimeFormat(uiLocale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: guestTz,
  });
  const timeFmt = new Intl.DateTimeFormat(uiLocale, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: guestTz,
  });
  const fullFmt = new Intl.DateTimeFormat(uiLocale, {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: guestTz,
  });

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedSlot) return;
    const form = new FormData(e.currentTarget);
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/booking/${orgSlug}/${typeSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startsAt: selectedSlot,
          durationMinutes: duration,
          timezone: guestTz,
          name: form.get("name"),
          email: form.get("email"),
          phone: form.get("phone") || undefined,
          company: form.get("company") || undefined,
          notes: form.get("notes") || undefined,
          consent: form.get("consent") === "on",
          locale,
          website: (form.get("website") as string) || "",
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        startsAt?: string;
        manageToken?: string;
        confirmationMessage?: string | null;
      };
      if (!res.ok || data.error) {
        setError(
          data.error === "slot_taken" || data.error === "invalid_slot"
            ? t("errors.slotTaken")
            : data.error === "consent_required"
              ? t("errors.consentRequired")
              : t("errors.bookingFailed"),
        );
        if (data.error === "slot_taken" || data.error === "invalid_slot") {
          setSelectedSlot(null);
          void loadSlots();
        }
        return;
      }
      setConfirmed({
        startsAt: data.startsAt!,
        manageToken: data.manageToken!,
        confirmationMessage: data.confirmationMessage ?? null,
      });
    } catch {
      setError(t("errors.bookingFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmed) {
    return (
      <Card>
        <CardContent className="space-y-3 pt-6 text-center">
          <h2
            className="text-xl font-semibold"
            style={brandColor ? { color: brandColor } : undefined}
          >
            {t("confirmedTitle")}
          </h2>
          <p className="text-sm">{fullFmt.format(new Date(confirmed.startsAt))}</p>
          <p className="text-xs text-muted-foreground">({guestTz})</p>
          {confirmed.confirmationMessage ? (
            <p className="text-sm text-muted-foreground">{confirmed.confirmationMessage}</p>
          ) : null}
          <p className="text-sm text-muted-foreground">{t("confirmationEmailNote")}</p>
          <a
            href={`/booking/manage/${confirmed.manageToken}`}
            className="inline-block text-sm text-primary underline"
          >
            {t("manageBooking")}
          </a>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {durationOptions.length > 1 ? (
          <div className="flex justify-center gap-2">
            {durationOptions.map((d) => (
              <Button
                key={d}
                variant={d === duration ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setDuration(d);
                  setSelectedSlot(null);
                }}
              >
                {t("durationLabel", { minutes: d })}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("previousWeek")}
            onClick={() => setWeekStart(new Date(weekStart.getTime() - 7 * 86_400_000))}
            disabled={weekStart <= new Date()}
          >
            <ChevronLeft className="size-4 rtl:rotate-180" />
          </Button>
          <p className="text-sm font-medium">
            {dayFmt.format(weekStart)} –{" "}
            {dayFmt.format(new Date(weekStart.getTime() + 6 * 86_400_000))}
          </p>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("nextWeek")}
            onClick={() => setWeekStart(new Date(weekStart.getTime() + 7 * 86_400_000))}
          >
            <ChevronRight className="size-4 rtl:rotate-180" />
          </Button>
        </div>

        <p className="text-center text-xs text-muted-foreground">
          {t("timezoneNote", { timezone: guestTz })}
        </p>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("loadingSlots")}</p>
        ) : slotsByDay.size === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("noSlots")}</p>
        ) : (
          <div className="space-y-3">
            {[...slotsByDay.entries()].map(([day, daySlots]) => (
              <div key={day}>
                <p className="mb-1.5 text-xs font-medium capitalize text-muted-foreground">
                  {dayFmt.format(new Date(`${day}T12:00:00`))}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {daySlots.map((s) => (
                    <Button
                      key={s}
                      variant={selectedSlot === s ? "default" : "outline"}
                      size="sm"
                      onClick={() => setSelectedSlot(s)}
                      style={
                        selectedSlot === s && brandColor
                          ? { backgroundColor: brandColor }
                          : undefined
                      }
                    >
                      {timeFmt.format(new Date(s))}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {selectedSlot ? (
          <form onSubmit={submit} className="space-y-3 border-t pt-4">
            <p className="text-sm font-medium">{fullFmt.format(new Date(selectedSlot))}</p>
            {/* Honeypot: hidden from humans, bots fill it. */}
            <input
              type="text"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              className="absolute -left-[9999px] h-0 w-0 opacity-0"
              aria-hidden="true"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="bk-name">{t("fields.name")}</Label>
                <Input id="bk-name" name="name" required maxLength={200} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bk-email">{t("fields.email")}</Label>
                <Input id="bk-email" name="email" type="email" required maxLength={320} />
              </div>
              {collectPhone ? (
                <div className="space-y-1.5">
                  <Label htmlFor="bk-phone">{t("fields.phone")}</Label>
                  <Input id="bk-phone" name="phone" type="tel" maxLength={40} />
                </div>
              ) : null}
              {collectCompany ? (
                <div className="space-y-1.5">
                  <Label htmlFor="bk-company">{t("fields.company")}</Label>
                  <Input id="bk-company" name="company" maxLength={200} />
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bk-notes">{t("fields.notes")}</Label>
              <textarea
                id="bk-notes"
                name="notes"
                rows={2}
                maxLength={2000}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>
            {requiresConsent ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="consent" required className="mt-0.5 size-4" />
                <span>{t("consentLabel")}</span>
              </label>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={submitting}
              className="w-full"
              style={brandColor ? { backgroundColor: brandColor } : undefined}
            >
              {submitting ? t("booking") : t("confirmButton")}
            </Button>
          </form>
        ) : error ? (
          <p role="alert" className="text-center text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
