"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AudioLines } from "lucide-react";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { useVoiceConversation } from "@/hooks/use-voice-conversation";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";
import { VoiceConversationIntro, VoiceConversationPanel } from "./voice-conversation-panel";

export function ChatView({
  conversationId,
  initialMessages,
  voiceInputEnabled = false,
  voiceConversation = null,
}: {
  conversationId?: string;
  initialMessages: UiMessage[];
  voiceInputEnabled?: boolean;
  /** Live voice conversation, when the server allows it for this user. */
  voiceConversation?: { sessionMinutes: number } | null;
}) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const { messages, send, abort, isStreaming, error } = useChat({
    conversationId,
    initialMessages,
  });
  // One player for the whole thread: starting a reply stops any other.
  const playback = useSpeechPlayback(locale);
  const [dictating, setDictating] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);

  // Each finished spoken turn goes through the normal chat pipeline, in voice
  // mode (short spoken replies, read-only tools). Attachments are not sent.
  const onUserTurn = useCallback(
    (text: string) =>
      send(text, { useKnowledgeBase: true, documentIds: [], responseMode: "voice" }),
    [send],
  );
  const live = useVoiceConversation({ locale, onUserTurn, onAbortReply: abort });
  const liveVisible = live.active || live.phase === "ended" || live.error !== null;

  // Only one audio owner at a time: live mode, dictation or reply playback.
  const canStartLive = voiceConversation !== null && !dictating && !isStreaming && !live.active;

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col md:h-[calc(100vh-4.5rem)]">
      <ChatThread messages={messages} playback={live.active ? undefined : playback} />
      {error ? (
        <p role="alert" className="px-4 pb-1 text-sm text-destructive">
          {t(`errors.${error}` as never) ?? t("errors.generic")}
        </p>
      ) : null}
      {voiceConversation ? (
        <div className="px-4 pt-2">
          {introOpen && !live.active ? (
            <VoiceConversationIntro
              sessionMinutes={voiceConversation.sessionMinutes}
              onCancel={() => setIntroOpen(false)}
              onConfirm={() => {
                setIntroOpen(false);
                playback.stop();
                void live.start();
              }}
            />
          ) : null}
          {liveVisible ? (
            <VoiceConversationPanel
              phase={live.phase}
              muted={live.muted}
              notice={live.notice}
              error={live.error}
              elapsedMs={live.elapsedMs}
              remainingMs={live.remainingMs}
              onToggleMute={live.toggleMute}
              onStopReply={live.stopReply}
              onEnd={live.end}
              onDismiss={live.clearError}
            />
          ) : null}
          {!live.active && !introOpen ? (
            <button
              type="button"
              onClick={() => setIntroOpen(true)}
              disabled={!canStartLive}
              className="mb-1 inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <AudioLines aria-hidden className="size-4" />
              {t("live.start")}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* Kept mounted while live mode runs: a typed draft is never sent by
          live mode and is still there when the conversation ends. */}
      <div className={live.active ? "hidden" : undefined}>
        <Composer
          onSend={(text, opts) => void send(text, opts)}
          onAbort={abort}
          disabled={isStreaming}
          voiceInputEnabled={voiceInputEnabled}
          onRecordingStart={playback.stop}
          onVoiceBusyChange={setDictating}
        />
      </div>
    </div>
  );
}
