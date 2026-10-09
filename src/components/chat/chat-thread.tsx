"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Wrench, FileText, Volume2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/hooks/use-chat";
import type { PlaybackError } from "@/hooks/use-speech-playback";
import { ActionConfirmation } from "./action-confirmation";

/** Optional read-aloud controls for assistant replies (never autoplays). */
export type ReplyPlayback = {
  supported: boolean;
  playingId: string | null;
  error: { id: string; code: PlaybackError } | null;
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

/** Tools whose activity chip has a localized label (chat.toolLabels); others show their name. */
const LABELED_TOOLS = [
  "searchKnowledgeBase",
  "searchContacts",
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
  "proposeBusinessDnaUpdate",
] as const;

const isLabeledTool = (name: string): name is (typeof LABELED_TOOLS)[number] =>
  (LABELED_TOOLS as readonly string[]).includes(name);

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
  const toolLabel = useTranslations("chat.toolLabels");
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2.5 text-sm md:max-w-[70%]",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {message.tools && message.tools.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.tools.map((tool, i) => (
              <span
                key={`${tool}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-background/60 px-2 py-0.5 text-xs text-muted-foreground"
              >
                {tool === "proposeBusinessDnaUpdate" ? null : <Wrench className="size-3" />}
                {isLabeledTool(tool) ? toolLabel(tool) : tool}
              </span>
            ))}
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
  const playing = playback.playingId === message.id;
  const error = playback.error?.id === message.id ? playback.error.code : null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/50 pt-2">
      <button
        type="button"
        onClick={() =>
          playing ? playback.stop() : playback.play(message.id, message.content, turn)
        }
        aria-label={playing ? t("stopListening") : t("listenLabel")}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-background/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {playing ? (
          <Square aria-hidden className="size-3.5" />
        ) : (
          <Volume2 aria-hidden className="size-3.5" />
        )}
        {playing ? t("stopListening") : t("listen")}
      </button>
      {error ? (
        <span role="status" className="text-xs text-muted-foreground">
          {t(`playbackErrors.${error}`)}
        </span>
      ) : null}
    </div>
  );
}
