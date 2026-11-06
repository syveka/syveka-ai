"use client";

import { useActionState } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { retryAssistantSyncAction, type VoiceActionState } from "@/actions/voice";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RecordingStatusKind } from "@/server/voice/recording-sync";

const ATTENTION: ReadonlySet<RecordingStatusKind> = new Set([
  "needsReview",
  "unreadable",
  "mismatch",
  "failed",
  "uncertain",
]);

const CAN_SEND_AGAIN: ReadonlySet<RecordingStatusKind> = new Set([
  "unreadable",
  "mismatch",
  "failed",
  "uncertain",
]);

/**
 * What was asked for and what the voice provider accepted are shown apart, on every visit: a saved
 * setting isn't proof of what the provider does. Everything here is read on the server. A region,
 * like the readiness panel beside it: its state is there on load, and only a send's result is news.
 */
export function RecordingStatusPanel({
  assistantId,
  kind,
  requested,
  reportedByVapi,
  lastAccepted,
}: {
  assistantId: string;
  kind: RecordingStatusKind;
  requested: boolean | null;
  reportedByVapi: boolean | null;
  /** Already formatted for the reader's locale. */
  lastAccepted: { enabled: boolean; at: string } | null;
}) {
  const t = useTranslations("voice.recording.status");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<VoiceActionState, FormData>(
    retryAssistantSyncAction.bind(null, assistantId),
    {},
  );

  if (kind === "notConnected") return null;

  const value = (enabled: boolean) => t(enabled ? "valueOn" : "valueOff");
  const attention = ATTENTION.has(kind);

  return (
    <Card
      role="region"
      aria-labelledby="voice-recording-status-title"
      className={attention ? "border-warning" : undefined}
    >
      <CardHeader>
        <CardTitle
          id="voice-recording-status-title"
          role="heading"
          aria-level={2}
          className="flex items-start gap-2 text-base"
        >
          {attention ? (
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
          ) : null}
          {t(`${kind}.title`)}
        </CardTitle>
        <CardDescription>{t(`${kind}.body`)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="space-y-1 text-start text-sm">
          {requested !== null ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{t("requestedLabel")}</dt>
              <dd>{value(requested)}</dd>
            </div>
          ) : null}
          {lastAccepted ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{t("lastAcceptedLabel")}</dt>
              <dd>
                {value(lastAccepted.enabled)} ({lastAccepted.at})
              </dd>
            </div>
          ) : null}
          {reportedByVapi !== null ? (
            <div className="flex flex-wrap gap-x-2">
              <dt className="text-muted-foreground">{t("reportedLabel")}</dt>
              <dd>{value(reportedByVapi)}</dd>
            </div>
          ) : null}
        </dl>
        {CAN_SEND_AGAIN.has(kind) ? (
          <form action={action}>
            <Button type="submit" variant="outline" size="sm" disabled={pending}>
              {pending ? tc("loading") : t("sendAgain")}
            </Button>
          </form>
        ) : null}
        {/* Always mounted, so a screen reader announces a result when it arrives. */}
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {state.error ? t("sendAgainFailed") : state.message ? t("sendAgainSent") : null}
        </p>
      </CardContent>
    </Card>
  );
}
