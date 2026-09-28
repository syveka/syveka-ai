"use client";

import { useTranslations } from "next-intl";
import { Loader2, Mic, Square, X } from "lucide-react";
import { MAX_RECORDING_SECONDS, PILOT_DAILY_ATTEMPTS } from "@/lib/voice/audio";
import type { VoiceRecorderError, VoiceRecorderStatus } from "@/hooks/use-voice-recorder";
import { cn } from "@/lib/utils";

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

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
 * Recording / transcribing status with Stop and Cancel, plus recoverable
 * errors. The ticking timer is not in the live region; only state changes are
 * announced (via `announcement`) so screen readers aren't flooded.
 */
export function VoiceStatusBar({
  status,
  elapsedMs,
  error,
  announcement,
  onStop,
  onCancel,
  onDismissError,
}: {
  status: VoiceRecorderStatus;
  elapsedMs: number;
  error: VoiceRecorderError | null;
  announcement: string;
  onStop: () => void;
  onCancel: () => void;
  onDismissError: () => void;
}) {
  const t = useTranslations("chat.voice");
  const busy = status !== "idle";

  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {busy ? (
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
                {status === "requesting"
                  ? t("requesting")
                  : status === "recording"
                    ? t("recording")
                    : t("transcribing")}
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
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-primary px-3 text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Square aria-hidden className="size-3.5" />
                  {t("stopRecording")}
                </button>
              ) : null}
              <button
                type="button"
                onClick={onCancel}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="size-3.5" />
                {t("cancel")}
              </button>
            </span>
          </div>
          {status === "recording" ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {t("maxDuration", { seconds: MAX_RECORDING_SECONDS })} {t("privacy")}
            </p>
          ) : null}
        </div>
      ) : null}
      {error && !busy ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/30 p-2 text-sm">
          <p role="alert" className="min-w-0 flex-1 text-destructive">
            {t(`errors.${error}`, {
              seconds: MAX_RECORDING_SECONDS,
              limit: PILOT_DAILY_ATTEMPTS,
            })}
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
