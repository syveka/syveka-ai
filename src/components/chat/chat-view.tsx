"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AudioLines } from "lucide-react";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { useVoiceConversation } from "@/hooks/use-voice-conversation";
import { useDeviceVoice } from "@/hooks/use-device-voice";
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
  const liveActiveRef = useRef(false);
  const { messages, send, abort, isStreaming, error, flushNavigation, getConversationId } = useChat(
    {
      conversationId,
      initialMessages,
      // A new chat's redirect would remount this view and end a live session.
      deferNavigation: () => liveActiveRef.current,
    },
  );
  // One player for the whole thread: starting a reply stops any other.
  const playback = useSpeechPlayback();
  const [dictating, setDictating] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const deviceVoice = useDeviceVoice(locale, introOpen);

  // Each finished spoken turn goes through the normal chat pipeline with its
  // single-use server grant, in the conversation the session is bound to; the
  // server derives voice mode from the grant.
  const onUserTurn = useCallback(
    (text: string, grant: string, boundConversationId: string) =>
      send(text, {
        useKnowledgeBase: true,
        documentIds: [],
        voiceGrant: grant,
        conversationId: boundConversationId,
      }),
    [send],
  );
  const live = useVoiceConversation({
    locale,
    onUserTurn,
    onAbortReply: abort,
    speakReplies,
    getConversationId,
  });
  liveActiveRef.current = live.active;
  const liveVisible = live.active || live.phase === "ended" || live.error !== null;

  // When the conversation ends, perform any redirect that was held.
  useEffect(() => {
    if (!live.active) flushNavigation();
  }, [live.active, flushNavigation]);

  // Only one audio owner at a time: live mode, dictation or reply playback.
  const canStartLive = voiceConversation !== null && !dictating && !isStreaming && !live.active;

  const startLive = (spoken: boolean) => {
    setIntroOpen(false);
    setSpeakReplies(spoken);
    playback.stop();
    void live.start();
  };

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
              deviceVoice={deviceVoice}
              onCancel={() => setIntroOpen(false)}
              onConfirm={() => startLive(true)}
              onConfirmTextOnly={() => startLive(false)}
            />
          ) : null}
          {liveVisible ? (
            <VoiceConversationPanel
              phase={live.phase}
              muted={live.muted}
              notice={live.notice}
              error={live.error}
              textOnly={!speakReplies && !live.speechEnabledInSession}
              elapsedMs={live.elapsedMs}
              remainingMs={live.remainingMs}
              onToggleMute={live.toggleMute}
              onStopReply={live.stopReply}
              onEnableSpeech={live.enableSpeech}
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
