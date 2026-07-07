import { notFound } from "next/navigation";
import { requirePermission } from "@/server/auth/guard";
import {
  listConversations, getConversationWithMessages,
} from "@/server/services/conversations";
import { ConversationList } from "@/components/chat/conversation-list";
import { ChatView } from "@/components/chat/chat-view";
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

  const initialMessages: UiMessage[] = conversation.messages
    .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
    .map((m) => ({
      id: m.id,
      role: m.role === "USER" ? "user" : "assistant",
      content: m.content,
      citations: (m.citations as UiMessage["citations"]) ?? undefined,
    }));

  return (
    <>
      <ConversationList
        activeId={conversationId}
        conversations={conversations.map((c) => ({
          id: c.id, title: c.title, isPinned: c.isPinned,
        }))}
      />
      <div className="flex-1">
        <ChatView conversationId={conversationId} initialMessages={initialMessages} />
      </div>
    </>
  );
}
