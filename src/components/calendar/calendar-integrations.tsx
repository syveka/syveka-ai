"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CheckCircle2, CloudOff, RefreshCw, Unplug, XCircle } from "lucide-react";
import {
  connectCalendarAction,
  disconnectCalendarAction,
  toggleCalendarSyncAction,
  checkConnectionHealthAction,
  syncNowAction,
} from "@/actions/calendar-integrations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Connection = {
  id: string;
  provider: string;
  accountEmail: string | null;
  status: string;
  lastError: string | null;
  lastCheckedAt: string | null;
  calendars: Array<{
    id: string;
    name: string;
    isPrimary: boolean;
    syncEnabled: boolean;
    lastSyncedAt: string | null;
    lastSyncStatus: string | null;
  }>;
};

const PROVIDER_LABELS: Record<string, string> = {
  GOOGLE: "Google Calendar",
  MICROSOFT: "Microsoft 365 / Outlook",
  MOCK: "Mock provider (dev)",
};

export function CalendarIntegrations({
  providers,
  connections,
  justConnected,
  connectError,
}: {
  providers: Array<{ provider: string; configured: boolean }>;
  connections: Connection[];
  justConnected: string | null;
  connectError: string | null;
}) {
  const t = useTranslations("integrations");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const connectedProviders = new Set(connections.map((c) => c.provider));
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });

  const run = (fn: () => Promise<{ error?: string; message?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      setMessage(result.error ? t("actionFailed") : null);
    });
  };

  return (
    <div className="space-y-4">
      {justConnected ? (
        <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm text-primary">
          {t("connectedBanner")}
        </p>
      ) : null}
      {connectError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {t("connectErrorBanner")}
        </p>
      ) : null}
      {message ? (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      ) : null}

      {connections.map((conn) => (
        <Card key={conn.id}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">
              {PROVIDER_LABELS[conn.provider] ?? conn.provider}
              {conn.accountEmail ? (
                <span className="ms-2 text-sm font-normal text-muted-foreground">
                  {conn.accountEmail}
                </span>
              ) : null}
            </CardTitle>
            <StatusBadge status={conn.status} t={t} />
          </CardHeader>
          <CardContent className="space-y-3">
            {conn.lastError ? <p className="text-sm text-destructive">{conn.lastError}</p> : null}

            {conn.status !== "DISCONNECTED" ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("calendars")}</p>
                <ul className="space-y-1.5">
                  {conn.calendars.map((cal) => (
                    <li
                      key={cal.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-sm"
                    >
                      <span>
                        {cal.name}
                        {cal.isPrimary ? (
                          <span className="ms-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
                            {t("primary")}
                          </span>
                        ) : null}
                        {cal.lastSyncedAt ? (
                          <span className="ms-2 text-xs text-muted-foreground">
                            {t("lastSynced", { date: fmt.format(new Date(cal.lastSyncedAt)) })}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {cal.syncEnabled ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            onClick={() => run(() => syncNowAction(cal.id))}
                          >
                            <RefreshCw className="me-1 size-3.5" />
                            {t("syncNow")}
                          </Button>
                        ) : null}
                        <Button
                          variant={cal.syncEnabled ? "outline" : "default"}
                          size="sm"
                          disabled={pending}
                          onClick={() =>
                            run(() => toggleCalendarSyncAction(cal.id, !cal.syncEnabled))
                          }
                        >
                          {cal.syncEnabled ? t("disableSync") : t("enableSync")}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex gap-2 border-t pt-3">
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => run(() => checkConnectionHealthAction(conn.id))}
              >
                {t("checkHealth")}
              </Button>
              {conn.status === "DISCONNECTED" || conn.status === "NEEDS_REAUTH" ? (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => connectCalendarAction(conn.provider))}
                >
                  {t("reconnect")}
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={pending}
                  onClick={() => run(() => disconnectCalendarAction(conn.id))}
                >
                  <Unplug className="me-1 size-3.5" />
                  {t("disconnect")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("addConnection")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {providers
            .filter((p) => !connectedProviders.has(p.provider))
            .map((p) => (
              <div key={p.provider} className="flex items-center justify-between text-sm">
                <span>{PROVIDER_LABELS[p.provider] ?? p.provider}</span>
                {p.configured ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => connectCalendarAction(p.provider))}
                  >
                    {t("connect")}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">{t("notConfigured")}</span>
                )}
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: string;
  t: ReturnType<typeof useTranslations<"integrations">>;
}) {
  if (status === "CONNECTED") {
    return (
      <span className="flex items-center gap-1 text-sm text-primary">
        <CheckCircle2 className="size-4" />
        {t("status.connected")}
      </span>
    );
  }
  if (status === "NEEDS_REAUTH") {
    return (
      <span className="flex items-center gap-1 text-sm text-destructive">
        <XCircle className="size-4" />
        {t("status.needsReauth")}
      </span>
    );
  }
  if (status === "DISCONNECTED") {
    return (
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <CloudOff className="size-4" />
        {t("status.disconnected")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-sm text-destructive">
      <XCircle className="size-4" />
      {t("status.error")}
    </span>
  );
}
