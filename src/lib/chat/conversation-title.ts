/**
 * The title every conversation is created with (the `Conversation.title`
 * schema default) until a title is generated from its first message. It is a
 * system placeholder, not text anyone wrote, so it is shown in the
 * interface language; any other title is shown exactly as stored.
 */
export const DEFAULT_CONVERSATION_TITLE = "New conversation";

export function conversationTitle(title: string, untitled: string): string {
  return title === DEFAULT_CONVERSATION_TITLE ? untitled : title;
}
