import { requirePermission } from "@/server/auth/guard";
import { listConversations } from "@/server/services/conversations";
import { ConversationList } from "@/components/chat/conversation-list";
import { ChatView } from "@/components/chat/chat-view";

export default async function ChatPage() {
  const ctx = await requirePermission("chat:use");
  const conversations = await listConversations(ctx);

  return (
    <>
      <ConversationList
        conversations={conversations.map((c) => ({
          id: c.id, title: c.title, isPinned: c.isPinned,
        }))}
      />
      <div className="flex-1">
        <ChatView initialMessages={[]} />
      </div>
    </>
  );
}
