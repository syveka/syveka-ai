"use client";

import { useTranslations } from "next-intl";
import { FileText, Loader2, Mic, Square, Trash2, X } from "lucide-react";
import { MAX_RECORDING_SECONDS, PILOT_DAILY_ATTEMPTS } from "@/lib/voice/audio";
import {
  isRetryableTranscriptionError,
  type PendingRecording,
  type VoiceRecorderError,
  type VoiceRecorderStatus,
} from "@/hooks/use-voice-recorder";
import { cn } from "@/lib/utils";

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const control =
  "inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Microphone button shown in the composer's control row. */
export function MicrophoneButton({
  status,
  disabled,
  onStart,
}: {
  status: VoiceRecorderStatus;
  disabled?: boolean;
  onStart: () => void;
}) {
  const t = useTranslations("chat.voice");
  const active = status !== "idle";
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={disabled || active}
      aria-label={t("record")}
      title={t("record")}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        active && "bg-destructive/10 text-destructive",
      )}
    >
      <Mic className="size-4" />
    </button>
  );
}

/**
 * Recording → review → transcribing, with Stop, Cancel, local playback,
 * Discard and Transcribe, plus recoverable errors. Nothing is uploaded until
 * Transcribe is pressed. The ticking timer is not in the live region; only
 * state changes are announced (via `announcement`).
 */
export function VoiceStatusBar({
  status,
  elapsedMs,
  pending,
  error,
  announcement,
  onStop,
  onCancel,
  onTranscribe,
  onDiscard,
  onDismissError,
}: {
  status: VoiceRecorderStatus;
  elapsedMs: number;
  pending: PendingRecording | null;
  error: VoiceRecorderError | null;
  announcement: string;
  onStop: () => void;
  onCancel: () => void;
  onTranscribe: () => void;
  onDiscard: () => void;
  onDismissError: () => void;
}) {
  const t = useTranslations("chat.voice");
  const reviewing = status === "review" || (status === "transcribing" && pending !== null);
  const errorText = error
    ? t(`errors.${error}`, { seconds: MAX_RECORDING_SECONDS, limit: PILOT_DAILY_ATTEMPTS })
    : "";

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {status === "requesting" || status === "recording" ? (
        <div
          role="group"
          aria-label={t("record")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancel();
            }
          }}
          className="mb-2 rounded-lg border bg-muted/40 p-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex min-w-[9rem] flex-1 items-center gap-2">
              {status === "recording" ? (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 animate-pulse rounded-full bg-destructive"
                />
              ) : (
                <Loader2
                  aria-hidden
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
              )}
              <span className="truncate">
                {status === "requesting" ? t("requesting") : t("recording")}
              </span>
              {status === "recording" ? (
                <span dir="ltr" className="shrink-0 tabular-nums text-muted-foreground">
                  {clock(elapsedMs)} / {clock(MAX_RECORDING_SECONDS * 1000)}
                </span>
              ) : null}
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-2">
              {status === "recording" ? (
                <button
                  type="button"
                  onClick={onStop}
                  className={cn(control, "bg-primary text-primary-foreground")}
                >
                  <Square aria-hidden className="size-3.5" />
                  {t("stop")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onCancel}
                className={cn(control, "border bg-background")}
              >
                <X aria-hidden className="size-3.5" />
                {t("cancel")}
              </button>
            </span>
          </div>
          {status === "recording" ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("maxDuration", { seconds: MAX_RECORDING_SECONDS })} {t("privacyNote")}
            </p>
          ) : null}
        </div>
      ) : null}
      {reviewing ? (
        <div
          role="group"
          aria-label={t("reviewTitle")}
          onKeyDown={(event) => {
            if (event.key === "Escape" && status === "review") {
              event.preventDefault();
              onDiscard();
            }
          }}
          className="mb-2 rounded-lg border bg-muted/40 p-2 text-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex min-w-[9rem] flex-1 items-center gap-2">
              {status === "transcribing" ? (
                <Loader2
                  aria-hidden
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                />
              ) : null}
              <span className="truncate font-medium">
                {status === "transcribing" ? t("transcribing") : t("reviewTitle")}
              </span>
              {pending ? (
                <span dir="ltr" className="shrink-0 tabular-nums text-muted-foreground">
                  {clock(pending.durationMs)}
                </span>
              ) : null}
            </span>
            <span className="ms-auto flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={onTranscribe}
                disabled={status !== "review" || !pending}
                className={cn(control, "bg-primary text-primary-foreground")}
              >
                <FileText aria-hidden className="size-3.5" />
                {t("transcribe")}
              </button>
              <button
                type="button"
                onClick={onDiscard}
                className={cn(control, "border bg-background")}
              >
                <Trash2 aria-hidden className="size-3.5" />
                {status === "transcribing" ? t("cancel") : t("discard")}
              </button>
            </span>
          </div>
          {pending?.url ? (
            <audio
              controls
              preload="metadata"
              src={pending.url}
              aria-label={t("playbackLabel")}
              className="mt-2 h-10 w-full max-w-full"
            />
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-destructive">
              {errorText} {isRetryableTranscriptionError(error) ? t("retryHint") : null}
            </p>
          ) : null}
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("reviewHint")} {t("privacyNote")}
          </p>
        </div>
      ) : null}
      {error && status === "idle" ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 p-2 text-sm">
          <p role="alert" className="min-w-0 flex-1 text-destructive">
            {errorText}
          </p>
          <button
            type="button"
            onClick={onDismissError}
            aria-label={t("dismiss")}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : null}
    </>
  );
}
