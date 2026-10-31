"use client";

import { useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Sparkles, FileText, Volume2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/hooks/use-chat";
import type { PlaybackFailure } from "@/hooks/use-speech-playback";
import { ActionConfirmation } from "./action-confirmation";

/** Optional read-aloud controls for assistant replies (never autoplays). */
export type ReplyPlayback = {
  supported: boolean;
  playingId: string | null;
  /** Waiting for the device to list a voice for the reply's language. */
  loadingId: string | null;
  error: PlaybackFailure | null;
  /** `turn`: the user message the reply answers (its language context). */
  play: (id: string, text: string, turn?: string) => void;
  stop: () => void;
};

export function ChatThread({
  messages,
  playback,
  onActionSettled,
}: {
  messages: UiMessage[];
  playback?: ReplyPlayback;
  /** A proposed write action was decided for good. */
  onActionSettled?: (actionId: string) => void;
}) {
  const t = useTranslations("chat");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <Sparkles className="size-8" />
        <p className="text-sm">{t("emptyState")}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {messages.map((m, i) => (
        <MessageBubble
          key={m.id}
          message={m}
          playback={playback}
          turn={m.role === "assistant" ? precedingUserText(messages, i) : undefined}
          onActionSettled={onActionSettled}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

/** The user message an assistant reply answers. */
function precedingUserText(messages: UiMessage[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return undefined;
}

/** Tools with their own status line (chat.toolStatus); any other shows the default. */
const TOOLS_WITH_STATUS = [
  "searchKnowledgeBase",
  "searchContacts",
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
  "proposeBusinessDnaUpdate",
] as const;

const hasStatus = (name: string): name is (typeof TOOLS_WITH_STATUS)[number] =>
  (TOOLS_WITH_STATUS as readonly string[]).includes(name);

function MessageBubble({
  message,
  playback,
  turn,
  onActionSettled,
}: {
  message: UiMessage;
  playback?: ReplyPlayback;
  turn?: string;
  onActionSettled?: (actionId: string) => void;
}) {
  const toolStatus = useTranslations("chat.toolStatus");
  const isUser = message.role === "user";
  const runningTool = message.streaming ? message.tools?.at(-1) : undefined;
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2.5 text-sm md:max-w-[70%]",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {/* Only while a tool runs, in plain words: never a tool name, and
            nothing stays on the finished reply. */}
        {runningTool ? (
          <div role="status" className="mb-2 text-xs text-muted-foreground">
            {toolStatus(hasStatus(runningTool) ? runningTool : "default")}
          </div>
        ) : null}

        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {message.streaming ? <span className="animate-pulse">▍</span> : null}
        </div>

        {message.citations && message.citations.length > 0 ? (
          <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
            {message.citations.map((c) => (
              <div
                key={c.documentId}
                className="flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <FileText className="size-3" />
                {c.title}
              </div>
            ))}
          </div>
        ) : null}

        {!isUser && message.actions?.length
          ? message.actions.map((action) => (
              <ActionConfirmation key={action.id} action={action} onSettled={onActionSettled} />
            ))
          : null}

        {!isUser && playback?.supported && !message.streaming && message.content.trim() ? (
          <ListenControl message={message} playback={playback} turn={turn} />
        ) : null}
      </div>
    </div>
  );
}

function ListenControl({
  message,
  playback,
  turn,
}: {
  message: UiMessage;
  playback: ReplyPlayback;
  turn?: string;
}) {
  const t = useTranslations("chat.voice");
  const locale = useLocale();
  const playing = playback.playingId === message.id;
  const loading = playback.loadingId === message.id;
  const active = playing || loading;
  const failure = playback.error?.id === message.id ? playback.error : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() =>
          active ? playback.stop() : playback.play(message.id, message.content, turn)
        }
        aria-label={active ? t("stopListening") : t("listenLabel")}
        aria-busy={loading || undefined}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {active ? (
          <Square aria-hidden className="size-3.5" />
        ) : (
          <Volume2 aria-hidden className="size-3.5" />
        )}
        {active ? t("stopListening") : t("listen")}
      </button>
      {loading ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t("preparingVoice")}
        </span>
      ) : failure ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t(`playbackErrors.${failure.code}`, {
            language: languageName(failure.language ?? "", locale),
          })}
        </span>
      ) : null}
    </div>
  );
}

/** The language's name in the interface language ("ar" → "arabia" in Finnish). */
function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}
