"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { chatErrorText } from "@/lib/chat/error-text";
import { AudioLines, Plus } from "lucide-react";
import { useRouter } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import { useVoiceConversation } from "@/hooks/use-voice-conversation";
import { useDeviceVoice } from "@/hooks/use-device-voice";
import { ChatThread } from "./chat-thread";
import { Composer } from "./composer";
import { VoiceConversationIntro, VoiceConversationPanel } from "./voice-conversation-panel";
import type { VoiceAllowance } from "@/lib/voice/allowance";

/**
 * Today's allowance for the start dialog, read from the server while it is
 * open (read-only: no session, no turn). Re-read after Helsinki midnight.
 * undefined while loading, null when it can't be read.
 */
function useLiveAllowance(open: boolean): VoiceAllowance | null | undefined {
  const [allowance, setAllowance] = useState<VoiceAllowance | null | undefined>(undefined);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let renewTimer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      setAllowance(undefined);
      fetch("/api/v1/ai/voice-conversation/session", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((body: { data?: VoiceAllowance } | null) => {
          if (cancelled) return;
          const next = body?.data ?? null;
          setAllowance(next);
          if (next) {
            renewTimer = setTimeout(load, Math.max(1_000, next.renewsAt - Date.now() + 1_000));
          }
        })
        .catch(() => {
          if (!cancelled) setAllowance(null);
        });
    };
    load();
    return () => {
      cancelled = true;
      if (renewTimer) clearTimeout(renewTimer);
    };
  }, [open]);
  return allowance;
}

type ChatViewProps = {
  conversationId?: string;
  initialMessages: UiMessage[];
  voiceInputEnabled?: boolean;
  /** The user may create Knowledge Base documents, which chat attachments are. */
  attachmentsEnabled?: boolean;
  /** Live voice conversation, when the server allows it for this user. */
  voiceConversation?: { sessionMinutes: number } | null;
};

/** Same key as the prompt library's "use in chat" hand-off; the composer restores it on mount. */
const DRAFT_KEY = "chat:draft";

export function ChatView(props: ChatViewProps) {
  // "New conversation" on /chat itself remounts the session: same route, so
  // navigating alone would keep the previous chat's messages and id.
  const [session, setSession] = useState(0);
  return <ChatSession key={session} {...props} onFreshSession={() => setSession((n) => n + 1)} />;
}

function ChatSession({
  conversationId,
  initialMessages,
  voiceInputEnabled = false,
  attachmentsEnabled = false,
  voiceConversation = null,
  onFreshSession,
}: ChatViewProps & { onFreshSession: () => void }) {
  const t = useTranslations("chat");
  const locale = useLocale();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const liveActiveRef = useRef(false);
  const {
    messages,
    send,
    abort,
    isStreaming,
    error,
    flushNavigation,
    settleAction,
    getConversationId,
  } = useChat({
    conversationId,
    initialMessages,
    // A new chat's redirect would remount this view and end a live session.
    deferNavigation: () => liveActiveRef.current,
  });
  // One player for the whole thread: starting a reply stops any other.
  const playback = useSpeechPlayback();
  const [dictating, setDictating] = useState(false);
  const [introOpen, setIntroOpen] = useState(false);
  const [speakReplies, setSpeakReplies] = useState(true);
  const deviceVoice = useDeviceVoice(locale, introOpen);
  const introAllowance = useLiveAllowance(introOpen && voiceConversation !== null);

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

  // Not while a reply streams or a live/dictation session owns this chat;
  // pointless on a chat that hasn't started.
  const canStartNewChat =
    !isStreaming && !live.active && !dictating && (messages.length > 0 || !!conversationId);

  /**
   * Starts an empty conversation; earlier ones stay in the list. An unsent
   * draft is carried over (never sent, never dropped). The server creates the
   * new conversation on its first message, with no earlier history.
   */
  const startNewChat = () => {
    const draft = rootRef.current?.querySelector("textarea")?.value ?? "";
    if (draft.trim()) {
      try {
        sessionStorage.setItem(DRAFT_KEY, draft);
      } catch {
        // Storage unavailable: the draft can't be carried over.
      }
    }
    playback.stop();
    if (conversationId) {
      router.push("/chat");
      return;
    }
    const created = getConversationId() !== undefined;
    onFreshSession();
    if (created) router.refresh(); // list the conversation that was just created
  };

  return (
    <div ref={rootRef} className="flex h-[calc(100dvh-3rem)] flex-col md:h-[calc(100dvh-4.5rem)]">
      <div className="flex shrink-0 items-center justify-end border-b px-4 py-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-10"
          onClick={startNewChat}
          disabled={!canStartNewChat}
        >
          <Plus aria-hidden />
          {t("newConversation")}
        </Button>
      </div>
      <ChatThread
        messages={messages}
        playback={live.active ? undefined : playback}
        onActionSettled={settleAction}
      />
      {error ? (
        <p role="alert" className="px-4 pb-1 text-sm text-destructive">
          {chatErrorText(t, error)}
        </p>
      ) : null}
      {voiceConversation ? (
        <div className="px-4 pt-2">
          {introOpen && !live.active ? (
            <VoiceConversationIntro
              sessionMinutes={voiceConversation.sessionMinutes}
              allowance={introAllowance}
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
              allowance={live.allowance}
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
          attachmentsEnabled={attachmentsEnabled}
          onRecordingStart={playback.stop}
          onVoiceBusyChange={setDictating}
        />
      </div>
    </div>
  );
}
