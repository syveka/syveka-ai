"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { useVoiceSession } from "@/hooks/use-voice-session";
import { createBrowserSpeechEngine, type SpeechEngine } from "@/lib/voice/speech-engine";
import { speechLangFor } from "@/lib/voice/spoken-text";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";
import { VoiceSessionPanel } from "./voice-session-panel";

export function ChatView({
  conversationId,
  initialMessages,
  speechEngine,
}: {
  conversationId?: string;
  initialMessages: UiMessage[];
  /** Injectable for tests; defaults to the browser Web Speech engine. */
  speechEngine?: SpeechEngine;
}) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const { messages, send, abort, isStreaming, error, setNavigationHeld } = useChat({
    conversationId,
    initialMessages,
  });

  const [engine] = useState(() => speechEngine ?? createBrowserSpeechEngine());
  // Feature detection only after mount — the server render can't know it,
  // and guessing would cause a hydration mismatch.
  const [voiceSupported, setVoiceSupported] = useState(false);
  useEffect(() => setVoiceSupported(engine.isSupported()), [engine]);

  const sendVoiceTurn = useCallback(
    (text: string) => send(text, { responseMode: "voice", useKnowledgeBase: true }),
    [send],
  );

  const voice = useVoiceSession({
    engine,
    lang: speechLangFor(locale),
    sendTurn: sendVoiceTurn,
    onAbortTurn: abort,
  });

  useEffect(() => {
    setNavigationHeld(voice.isActive);
  }, [voice.isActive, setNavigationHeld]);

  return (
    <div className="flex h-[calc(100vh-3rem)] flex-col md:h-[calc(100vh-4.5rem)]">
      <ChatThread messages={messages} />
      {error && !voice.isActive ? (
        <p role="alert" className="px-4 pb-1 text-sm text-destructive">
          {t(`errors.${error}` as never) ?? t("errors.generic")}
        </p>
      ) : null}
      <Composer
        onSend={(text, opts) => void send(text, opts)}
        onAbort={abort}
        disabled={isStreaming || voice.isActive}
        onStartVoice={() => void voice.start()}
        voiceSupported={voiceSupported}
      />
      {voice.isActive ? (
        <VoiceSessionPanel
          status={voice.status}
          error={voice.error}
          interim={voice.interim}
          lastReply={voice.lastReply}
          isMuted={voice.isMuted}
          onMute={voice.mute}
          onUnmute={voice.unmute}
          onEnd={voice.end}
          onInterrupt={voice.interrupt}
          onRetry={voice.retry}
        />
      ) : null}
    </div>
  );
}
