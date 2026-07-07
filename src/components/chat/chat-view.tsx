"use client";

import { useTranslations } from "next-intl";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";

export function ChatView({
  conversationId,
  initialMessages,
}: {
  conversationId?: string;
  initialMessages: UiMessage[];
}) {
  const t = useTranslations("chat");
  const { messages, send, isStreaming, error } = useChat({ conversationId, initialMessages });

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col md:h-[calc(100vh-4.5rem)]">
      <ChatThread messages={messages} />
      {error ? (
        <p role="alert" className="px-4 pb-1 text-sm text-destructive">
          {t(`errors.${error}` as never) ?? t("errors.generic")}
        </p>
      ) : null}
      <Composer onSend={(text, opts) => void send(text, opts)} disabled={isStreaming} />
    </div>
  );
}
