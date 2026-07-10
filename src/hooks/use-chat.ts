"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "@/i18n/routing";
import type { ChatStreamEvent } from "@/lib/validators/chat";

export type UiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: Array<{ documentId: string; title: string }>;
  tools?: string[];
  streaming?: boolean;
};

/** Consumes the SSE stream from /api/v1/ai/chat (§15.1). */
export function useChat(params: { conversationId?: string; initialMessages: UiMessage[] }) {
  const [messages, setMessages] = useState<UiMessage[]>(params.initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef(params.conversationId);
  const router = useRouter();

  const send = useCallback(
    async (text: string, opts?: { useKnowledgeBase?: boolean; deepMode?: boolean }) => {
      if (isStreaming || !text.trim()) return;
      setError(null);
      setIsStreaming(true);

      const userMsg: UiMessage = { id: crypto.randomUUID(), role: "user", content: text };
      const assistantMsg: UiMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        streaming: true,
        tools: [],
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      const patchAssistant = (patch: Partial<UiMessage> | ((m: UiMessage) => Partial<UiMessage>)) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) }
              : m,
          ),
        );

      try {
        const res = await fetch("/api/v1/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationIdRef.current,
            message: text,
            useKnowledgeBase: opts?.useKnowledgeBase ?? true,
            deepMode: opts?.deepMode ?? false,
          }),
        });

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            error?: { code?: string };
          } | null;
          setError(body?.error?.code ?? "request_failed");
          patchAssistant({ streaming: false });
          setIsStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const isNewConversation = !conversationIdRef.current;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.startsWith("data: ")) continue;
            const event = JSON.parse(frame.slice(6)) as ChatStreamEvent;
            switch (event.type) {
              case "meta":
                conversationIdRef.current = event.conversationId;
                break;
              case "text":
                patchAssistant((m) => ({ content: m.content + event.delta }));
                break;
              case "tool":
                if (event.status === "start") {
                  patchAssistant((m) => ({ tools: [...(m.tools ?? []), event.name] }));
                }
                break;
              case "citations":
                patchAssistant({ citations: event.citations });
                break;
              case "error":
                setError(event.code);
                break;
              case "done":
                break;
            }
          }
        }

        patchAssistant({ streaming: false });
        if (isNewConversation && conversationIdRef.current) {
          router.replace(`/chat/${conversationIdRef.current}`);
          router.refresh(); // refresh conversation list
        }
      } catch {
        setError("network_error");
        patchAssistant({ streaming: false });
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, router],
  );

  return { messages, send, isStreaming, error };
}
