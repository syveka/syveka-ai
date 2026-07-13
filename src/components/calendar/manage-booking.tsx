"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Guest-facing cancel / reschedule page behind a secure expiring token. */
export function ManageBooking({
  token,
  bookingTypeName,
  typeSlug,
  orgSlug,
  status,
  startsAt,
  guestTimezone,
}: {
  token: string;
  bookingTypeName: string;
  typeSlug: string;
  orgSlug: string;
  status: string;
  startsAt: string;
  guestTimezone: string;
}) {
  const t = useTranslations("booking");
  const locale = useLocale();
  const [mode, setMode] = useState<"view" | "reschedule" | "canceled" | "rescheduled">("view");
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newStart, setNewStart] = useState<string | null>(null);

  const fullFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeStyle: "short",
        timeZone: guestTimezone,
      }),
    [locale, guestTimezone],
  );
  const timeFmt = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: guestTimezone,
  });

  useEffect(() => {
    if (mode !== "reschedule") return;
    let aborted = false;
    setLoadingSlots(true);
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
    void fetch(
      `/api/v1/booking/${orgSlug}/${typeSlug}/slots?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { slots: string[] };
        if (!aborted) setSlots(data.slots.slice(0, 40));
      })
      .catch(() => !aborted && setError(t("errors.loadFailed")))
      .finally(() => !aborted && setLoadingSlots(false));
    return () => {
      aborted = true;
    };
  }, [mode, orgSlug, typeSlug, t]);

  async function cancelBooking() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/booking/manage/${token}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMode("canceled");
    } catch {
      setError(t("errors.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function reschedule() {
    if (!newStart) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/booking/manage/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startsAt: newStart }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(
          data.error === "slot_taken" ? t("errors.slotTaken") : t("errors.rescheduleFailed"),
        );
        return;
      }
      setMode("rescheduled");
    } catch {
      setError(t("errors.rescheduleFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (mode === "canceled") {
    return (
      <Card>
        <CardContent className="pt-6 text-center">
          <h1 className="text-xl font-semibold">{t("manage.canceledTitle")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t("manage.canceledBody")}</p>
        </CardContent>
      </Card>
    );
  }
  if (mode === "rescheduled") {
    return (
      <Card>
        <CardContent className="pt-6 text-center">
          <h1 className="text-xl font-semibold">{t("manage.rescheduledTitle")}</h1>
          <p className="mt-2 text-sm">{newStart ? fullFmt.format(new Date(newStart)) : null}</p>
          <p className="mt-2 text-sm text-muted-foreground">{t("confirmationEmailNote")}</p>
        </CardContent>
      </Card>
    );
  }

  const isCanceled = status === "CANCELED";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{bookingTypeName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm">{fullFmt.format(new Date(startsAt))}</p>
          <p className="text-xs text-muted-foreground">({guestTimezone})</p>
          {isCanceled ? (
            <p className="mt-1 text-sm font-medium text-destructive">
              {t("manage.alreadyCanceled")}
            </p>
          ) : null}
        </div>

        {!isCanceled && mode === "view" ? (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setMode("reschedule")}>
              {t("manage.reschedule")}
            </Button>
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={cancelBooking}
              disabled={busy}
            >
              {busy ? t("manage.working") : t("manage.cancel")}
            </Button>
          </div>
        ) : null}

        {mode === "reschedule" ? (
          <div className="space-y-3 border-t pt-3">
            <p className="text-sm font-medium">{t("manage.pickNewTime")}</p>
            {loadingSlots ? (
              <p className="text-sm text-muted-foreground">{t("loadingSlots")}</p>
            ) : slots.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noSlots")}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {slots.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={newStart === s ? "default" : "outline"}
                    onClick={() => setNewStart(s)}
                  >
                    {timeFmt.format(new Date(s))}
                  </Button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <Button onClick={reschedule} disabled={!newStart || busy}>
                {busy ? t("manage.working") : t("manage.confirmReschedule")}
              </Button>
              <Button variant="ghost" onClick={() => setMode("view")}>
                {t("manage.back")}
              </Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
