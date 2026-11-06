"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { retryAssistantSyncAction, type VoiceActionState } from "@/actions/voice";
import { Button } from "@/components/ui/button";
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
 * What was asked for and what the phone service accepted are shown apart, on every visit: a saved
 * setting isn't proof of what the service does. Everything here is read on the server.
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
    <section
      aria-labelledby="voice-recording-status-title"
      role={attention ? "alert" : "status"}
      className={
        attention
          ? "space-y-2 rounded-md border border-warning p-4 text-start"
          : "space-y-2 rounded-md border p-4 text-start"
      }
    >
      <h2 id="voice-recording-status-title" className="text-sm font-medium">
        {t(`${kind}.title`)}
      </h2>
      <p className="text-sm text-muted-foreground">{t(`${kind}.body`)}</p>
      <dl className="space-y-1 text-sm">
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
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("sendAgainFailed")}
        </p>
      ) : null}
    </section>
  );
}
