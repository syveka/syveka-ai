export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import {
  liveStatuses,
  recordedActionOutcomes,
  restoredState,
  savedActions,
} from "@/server/ai/tool-action-history";
import { redis } from "@/server/integrations/redis";
import { requirePermission } from "@/server/auth/guard";
import { listConversations, getConversationWithMessages } from "@/server/services/conversations";
import { ConversationList } from "@/components/chat/conversation-list";
import { ChatView } from "@/components/chat/chat-view";
import { isTranscriptionPilotMember } from "@/server/ai/transcription-pilot";
import { liveVoiceFor } from "@/server/ai/voice-conversation-page";
import type { UiMessage } from "@/hooks/use-chat";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const ctx = await requirePermission("chat:use");

  const [conversations, conversation] = await Promise.all([
    listConversations(ctx),
    getConversationWithMessages(ctx, conversationId),
  ]);
  if (!conversation) notFound();

  // Saved write actions come back with their recorded outcome (audit trail,
  // this organization only); see tool-action-history.ts.
  const saved = new Map(
    conversation.messages.map((m) => [
      m.id,
      m.role === "ASSISTANT" ? savedActions(m.toolCalls) : [],
    ]),
  );
  const allSaved = [...saved.values()].flat();
  const recorded = await recordedActionOutcomes(
    ctx.orgId,
    allSaved.map((a) => a.id),
  );
  const now = Date.now();
  // Only an action the live store still holds as pending is offered again.
  const live = await liveStatuses(redis, ctx, allSaved, recorded, now);
  const initialMessages: UiMessage[] = conversation.messages
    .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
    .map((m) => {
      const actions = (saved.get(m.id) ?? []).map((action) => {
        const state = restoredState(action, recorded, now, live.get(action.id));
        return state === "pending" ? action : { ...action, restored: state };
      });
      return {
        id: m.id,
        role: m.role === "USER" ? "user" : "assistant",
        content: m.content,
        citations: (m.citations as UiMessage["citations"]) ?? undefined,
        ...(actions.length > 0 ? { actions } : {}),
      };
    });

  return (
    <>
      <ConversationList
        activeId={conversationId}
        conversations={conversations.map((c) => ({
          id: c.id,
          title: c.title,
          isPinned: c.isPinned,
        }))}
      />
      <div className="min-w-0 flex-1">
        <ChatView
          conversationId={conversationId}
          initialMessages={initialMessages}
          voiceInputEnabled={isTranscriptionPilotMember(ctx)}
          voiceConversation={liveVoiceFor(ctx)}
        />
      </div>
    </>
  );
}
