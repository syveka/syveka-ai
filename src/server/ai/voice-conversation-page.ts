import "server-only";

import {
  isVoiceConversationMember,
  readVoiceConversationConfig,
} from "@/server/ai/voice-conversation";

/** What the chat page tells the client about live voice (null = not offered). */
export function liveVoiceFor(ctx: { orgId: string; userId: string }): {
  sessionMinutes: number;
} | null {
  if (!isVoiceConversationMember(ctx)) return null;
  const config = readVoiceConversationConfig();
  return config ? { sessionMinutes: Math.floor(config.sessionSeconds / 60) } : null;
}
