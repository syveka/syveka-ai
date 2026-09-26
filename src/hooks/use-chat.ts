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

export type ChatTurnResult = { text: string; error: string | null };

/** Consumes the SSE stream from /api/v1/ai/chat (§15.1). */
export function useChat(params: { conversationId?: string; initialMessages: UiMessage[] }) {
  const [messages, setMessages] = useState<UiMessage[]>(params.initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef(params.conversationId);
  const abortControllerRef = useRef<AbortController | null>(null);
  // While a voice session is live, the first-message redirect to
  // /chat/[id] would remount the chat view and drop the call — hold it and
  // apply it once the session ends.
  const navigationHeldRef = useRef(false);
  const pendingNavigationRef = useRef<string | null>(null);
  const router = useRouter();

  const navigateToConversation = useCallback(
    (conversationId: string) => {
      if (navigationHeldRef.current) {
        pendingNavigationRef.current = conversationId;
        return;
      }
      router.replace(`/chat/${conversationId}`);
      router.refresh(); // refresh conversation list
    },
    [router],
  );

  const setNavigationHeld = useCallback(
    (held: boolean) => {
      navigationHeldRef.current = held;
      if (!held && pendingNavigationRef.current) {
        const conversationId = pendingNavigationRef.current;
        pendingNavigationRef.current = null;
        navigateToConversation(conversationId);
      }
    },
    [navigateToConversation],
  );

  const send = useCallback(
    async (
      text: string,
      opts?: {
        useKnowledgeBase?: boolean;
        deepMode?: boolean;
        documentIds?: string[];
        responseMode?: "text" | "voice";
      },
    ): Promise<ChatTurnResult> => {
      if (isStreaming) return { text: "", error: "busy" };
      if (!text.trim()) return { text: "", error: "empty_message" };
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
        const abortController = new AbortController();
        abortControllerRef.current = abortController;
        const res = await fetch("/api/v1/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: conversationIdRef.current,
            message: text,
            useKnowledgeBase: opts?.useKnowledgeBase ?? true,
            deepMode: opts?.deepMode ?? false,
            documentIds: opts?.documentIds ?? [],
            responseMode: opts?.responseMode ?? "text",
          }),
          signal: abortController.signal,
        });

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            error?: { code?: string };
          } | null;
          const code = body?.error?.code ?? "request_failed";
          setError(code);
          patchAssistant({ streaming: false });
          setIsStreaming(false);
          return { text: "", error: code };
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let replyText = "";
        let streamError: string | null = null;
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
                replyText += event.delta;
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
                streamError = event.code;
                setError(event.code);
                break;
              case "done":
                break;
            }
          }
        }

        patchAssistant({ streaming: false });
        if (isNewConversation && conversationIdRef.current) {
          navigateToConversation(conversationIdRef.current);
        }
        return { text: replyText, error: streamError };
      } catch (requestError) {
        const aborted = requestError instanceof DOMException && requestError.name === "AbortError";
        if (aborted) {
          setMessages((prev) =>
            prev.filter((message) => message.id !== assistantMsg.id || message.content.length > 0),
          );
        } else {
          setError("network_error");
        }
        patchAssistant({ streaming: false });
        return { text: "", error: aborted ? "aborted" : "network_error" };
      } finally {
        abortControllerRef.current = null;
        setIsStreaming(false);
      }
    },
    [isStreaming, navigateToConversation],
  );

  const abort = useCallback(() => abortControllerRef.current?.abort(), []);

  return { messages, send, abort, isStreaming, error, setNavigationHeld };
}
