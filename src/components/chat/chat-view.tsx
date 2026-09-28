"use client";

import { useLocale, useTranslations } from "next-intl";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";

export function ChatView({
  conversationId,
  initialMessages,
  voiceInputEnabled = false,
}: {
  conversationId?: string;
  initialMessages: UiMessage[];
  voiceInputEnabled?: boolean;
}) {
  const t = useTranslations("chat");
  const { messages, send, abort, isStreaming, error } = useChat({
    conversationId,
    initialMessages,
  });
  // One player for the whole thread: starting a reply stops any other.
  const playback = useSpeechPlayback(useLocale());

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col md:h-[calc(100vh-4.5rem)]">
      <ChatThread messages={messages} playback={playback} />
      {error ? (
        <p role="alert" className="px-4 pb-1 text-sm text-destructive">
          {t(`errors.${error}` as never) ?? t("errors.generic")}
        </p>
      ) : null}
      <Composer
        onSend={(text, opts) => void send(text, opts)}
        onAbort={abort}
        disabled={isStreaming}
        voiceInputEnabled={voiceInputEnabled}
        onRecordingStart={playback.stop}
      />
    </div>
  );
}
