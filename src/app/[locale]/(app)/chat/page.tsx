export const dynamic = "force-dynamic";

import { requirePermission } from "@/server/auth/guard";
import { listConversations } from "@/server/services/conversations";
import { ConversationList } from "@/components/chat/conversation-list";
import { ChatView } from "@/components/chat/chat-view";
import { isTranscriptionPilotMember } from "@/server/ai/transcription-pilot";

export default async function ChatPage() {
  const ctx = await requirePermission("chat:use");
  const conversations = await listConversations(ctx);

  return (
    <>
      <ConversationList
        conversations={conversations.map((c) => ({
          id: c.id,
          title: c.title,
          isPinned: c.isPinned,
        }))}
      />
      <div className="min-w-0 flex-1">
        <ChatView initialMessages={[]} voiceInputEnabled={isTranscriptionPilotMember(ctx)} />
      </div>
    </>
  );
}
