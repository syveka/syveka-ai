"use client";

import { useTranslations } from "next-intl";
import { AudioLines, Loader2, Mic, MicOff, PhoneOff, Square, X } from "lucide-react";
import type {
  ConversationError,
  ConversationNotice,
  ConversationPhase,
} from "@/hooks/use-voice-conversation";
import type { DeviceVoice } from "@/hooks/use-device-voice";
import { cn } from "@/lib/utils";

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const PHASE_LABEL: Record<ConversationPhase, string> = {
  idle: "listening",
  connecting: "connecting",
  listening: "listening",
  user_speaking: "userSpeaking",
  processing: "processing",
  thinking: "thinking",
  speaking: "speaking",
  ended: "ended",
};

const button =
  "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Deliberate start: explains what live mode does before the microphone opens. */
export function VoiceConversationIntro({
  sessionMinutes,
  deviceVoice,
  onConfirm,
  onConfirmTextOnly,
  onCancel,
}: {
  sessionMinutes: number;
  /** Whether this device can speak replies in the interface language. */
  deviceVoice: DeviceVoice;
  onConfirm: () => void;
  onConfirmTextOnly: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("chat.live");
  return (
    <section
      aria-labelledby="live-voice-intro-title"
      className="mb-2 rounded-lg border bg-muted/40 p-3 text-sm"
    >
      <h2 id="live-voice-intro-title" className="font-medium">
        {t("introTitle")}
      </h2>
      <ul className="mt-2 list-disc space-y-1 ps-5 text-muted-foreground">
        <li>{t("introMic")}</li>
        <li>{t("introAuto")}</li>
        <li>{t("introControl")}</li>
        <li>{t("introActions")}</li>
        <li>{t("introLimit", { minutes: sessionMinutes })}</li>
        <li>{t("introDailyLimit")}</li>
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">{t("introPrivacy")}</p>
      {deviceVoice === "unavailable" ? (
        <p role="status" className="mt-2 font-medium">
          {t("voiceUnavailable")}
        </p>
      ) : deviceVoice === "unknown" ? (
        <p role="status" className="mt-2 text-muted-foreground">
          {t("voiceUnknown")}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {deviceVoice === "unavailable" ? (
          <>
            <button
              type="button"
              onClick={onConfirmTextOnly}
              className={cn(button, "bg-primary text-primary-foreground")}
            >
              <AudioLines aria-hidden className="size-4" />
              {t("startTextOnly")}
            </button>
            <button type="button" onClick={onCancel} className={cn(button, "border bg-background")}>
              {t("useDictation")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onConfirm}
              disabled={deviceVoice === "checking"}
              className={cn(button, "bg-primary text-primary-foreground")}
            >
              <AudioLines aria-hidden className="size-4" />
              {deviceVoice === "checking" ? t("voiceChecking") : t("confirm")}
            </button>
            <button type="button" onClick={onCancel} className={cn(button, "border bg-background")}>
              {t("cancel")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Live session panel: state, timers and the Mute / Stop reply / End controls. */
export function VoiceConversationPanel({
  phase,
  muted,
  notice,
  error,
  textOnly = false,
  elapsedMs,
  remainingMs,
  onToggleMute,
  onStopReply,
  onEnd,
  onDismiss,
}: {
  phase: ConversationPhase;
  muted: boolean;
  notice: ConversationNotice;
  error: ConversationError | null;
  /** Replies are shown as text only (no device voice for the language). */
  textOnly?: boolean;
  elapsedMs: number;
  remainingMs: number | null;
  onToggleMute: () => void;
  onStopReply: () => void;
  onEnd: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations("chat.live");
  const active = phase !== "idle" && phase !== "ended";
  const stateLabel = muted && active ? t("state.muted") : t(`state.${PHASE_LABEL[phase]}`);

  return (
    <section
      aria-label={t("panelLabel")}
      className="mb-2 rounded-lg border bg-muted/40 p-2 text-sm"
    >
      {/* Only state changes are announced — never the ticking timers. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {stateLabel}
      </p>
      {active ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex min-w-[9rem] flex-1 items-center gap-2" aria-hidden>
              {phase === "connecting" || phase === "processing" || phase === "thinking" ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <span
                  className={cn(
                    "size-2.5 shrink-0 rounded-full",
                    muted
                      ? "bg-muted-foreground"
                      : phase === "user_speaking"
                        ? "animate-pulse bg-destructive"
                        : phase === "speaking"
                          ? "animate-pulse bg-primary"
                          : "bg-success",
                  )}
                />
              )}
              <span className="truncate">{stateLabel}</span>
            </span>
            <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span>
                {t("elapsed")}{" "}
                <span dir="ltr" className="tabular-nums">
                  {clock(elapsedMs)}
                </span>
              </span>
              {remainingMs !== null ? (
                <span>
                  {t("remaining")}{" "}
                  <span dir="ltr" className="tabular-nums">
                    {clock(remainingMs)}
                  </span>
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onToggleMute}
              aria-pressed={muted}
              disabled={phase === "connecting"}
              className={cn(button, "border bg-background")}
            >
              {muted ? (
                <MicOff aria-hidden className="size-4" />
              ) : (
                <Mic aria-hidden className="size-4" />
              )}
              {muted ? t("unmute") : t("mute")}
            </button>
            {phase === "speaking" ? (
              <button
                type="button"
                onClick={onStopReply}
                className={cn(button, "border bg-background")}
              >
                <Square aria-hidden className="size-3.5" />
                {t("stopReply")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onEnd}
              className={cn(button, "bg-destructive text-destructive-foreground")}
            >
              <PhoneOff aria-hidden className="size-4" />
              {t("end")}
            </button>
          </div>
          {textOnly ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("textOnlyHint")}</p>
          ) : null}
          {notice ? (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              {t(`notices.${notice}`)}
            </p>
          ) : null}
        </>
      ) : null}
      {error ? (
        <div className={cn("flex items-start gap-2", active && "mt-2")}>
          <p role="alert" className="min-w-0 flex-1 text-destructive">
            {t(`errors.${error}`)}
          </p>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("dismiss")}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
      ) : !active && phase === "ended" ? (
        <p role="status" className="text-muted-foreground">
          {t("state.ended")}
        </p>
      ) : null}
    </section>
  );
}
