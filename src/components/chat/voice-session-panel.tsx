"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Loader2, Mic, MicOff, PhoneOff, Sparkles, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VoiceSessionError, VoiceSessionStatus } from "@/hooks/use-voice-session";

const CHAT_ERROR_KEYS = new Set([
  "rate_limited",
  "entitlement_exceeded",
  "content_flagged",
  "generation_failed",
  "network_error",
]);

/** Chat-route codes that need voice-specific guidance rather than chat's copy. */
const CHAT_CODES_WITH_VOICE_COPY: Record<string, string> = {
  unauthenticated: "session_expired",
  permission_denied: "not_permitted",
};

function useVoiceErrorMessage(error: VoiceSessionError | null): string | null {
  const t = useTranslations("chat.voice");
  const tChat = useTranslations("chat");
  if (!error) return null;
  if (error.source === "voice") return t(`errors.${error.code}`);
  const voiceKey = CHAT_CODES_WITH_VOICE_COPY[error.code];
  if (voiceKey) return t(`errors.${voiceKey}` as never);
  if (CHAT_ERROR_KEYS.has(error.code)) return tChat(`errors.${error.code}` as never);
  return t("errors.generic");
}

/**
 * The live voice-call surface. Full-screen on mobile (thumb-reachable
 * controls, safe-area aware); a floating card over the chat on desktop so
 * the transcript stays visible. Every state is announced as text, never
 * conveyed by color or animation alone.
 */
export function VoiceSessionPanel({
  status,
  error,
  interim,
  lastReply,
  isMuted,
  onMute,
  onUnmute,
  onEnd,
  onInterrupt,
  onRetry,
}: {
  status: VoiceSessionStatus;
  error: VoiceSessionError | null;
  interim: string;
  lastReply: string;
  isMuted: boolean;
  onMute: () => void;
  onUnmute: () => void;
  onEnd: () => void;
  onInterrupt: () => void;
  onRetry: () => void;
}) {
  const t = useTranslations("chat.voice");
  const errorMessage = useVoiceErrorMessage(error);
  const endButtonRef = useRef<HTMLButtonElement>(null);

  // On mobile the panel covers the whole chat, so move keyboard/screen-reader
  // focus into it — otherwise focus stays on the hidden composer beneath.
  useEffect(() => {
    endButtonRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={t("title")}
      data-testid="voice-session-panel"
      data-status={status}
      className={cn(
        "fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background",
        "pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))]",
        "md:inset-auto md:bottom-6 md:end-6 md:w-96 md:rounded-2xl md:border md:pb-4 md:pt-4 md:shadow-xl",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t(`status.${status}`)}
        </p>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-6 text-center md:py-8">
        <button
          type="button"
          onClick={status === "speaking" ? onInterrupt : undefined}
          disabled={status !== "speaking"}
          aria-label={status === "speaking" ? t("interrupt") : t(`status.${status}`)}
          className={cn(
            "relative flex size-32 items-center justify-center rounded-full transition-colors md:size-24",
            status === "listening" && "bg-primary/15 text-primary",
            status === "speaking" && "bg-primary text-primary-foreground",
            status === "thinking" && "bg-muted text-foreground",
            (status === "muted" || status === "connecting" || status === "idle") &&
              "bg-muted text-muted-foreground",
            status === "error" && "bg-destructive/10 text-destructive",
          )}
        >
          {status === "listening" ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-ping rounded-full bg-primary/10 motion-reduce:animate-none"
            />
          ) : null}
          <StatusIcon status={status} />
        </button>

        <div className="min-h-[4.5rem] w-full max-w-sm space-y-2" aria-live="polite">
          {interim && (status === "listening" || status === "thinking") ? (
            <p className="text-base">
              <span className="sr-only">{t("you")}: </span>
              {interim}
            </p>
          ) : null}
          {lastReply && (status === "speaking" || status === "listening" || status === "muted") ? (
            <p className="line-clamp-4 text-sm text-muted-foreground">
              <span className="sr-only">{t("assistant")}: </span>
              {lastReply}
            </p>
          ) : null}
          {status === "speaking" ? (
            <p className="text-xs text-muted-foreground">{t("interruptHint")}</p>
          ) : null}
          {errorMessage ? (
            <p
              role="alert"
              className="flex items-start justify-center gap-1.5 text-sm text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              {errorMessage}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-center gap-6 px-6">
        {status === "error" ? (
          <Button type="button" variant="outline" className="h-12 min-w-28" onClick={onRetry}>
            {t("retry")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-14 rounded-full"
            aria-pressed={isMuted}
            aria-label={isMuted ? t("unmute") : t("mute")}
            disabled={status === "connecting"}
            onClick={isMuted ? onUnmute : onMute}
          >
            {isMuted ? <MicOff className="size-6" /> : <Mic className="size-6" />}
          </Button>
        )}
        <Button
          type="button"
          ref={endButtonRef}
          variant="destructive"
          size="icon"
          className="size-14 rounded-full"
          aria-label={t("end")}
          onClick={onEnd}
        >
          <PhoneOff className="size-6" />
        </Button>
      </div>

      <p className="mt-4 px-6 text-center text-xs text-muted-foreground">{t("privacyNote")}</p>
    </div>
  );
}

function StatusIcon({ status }: { status: VoiceSessionStatus }) {
  const className = "relative size-10 md:size-8";
  switch (status) {
    case "connecting":
    case "thinking":
      return <Loader2 className={cn(className, "animate-spin motion-reduce:animate-none")} />;
    case "speaking":
      return <Volume2 className={className} />;
    case "muted":
      return <MicOff className={className} />;
    case "error":
      return <AlertCircle className={className} />;
    case "listening":
      return <Mic className={className} />;
    default:
      return <Sparkles className={className} />;
  }
}
