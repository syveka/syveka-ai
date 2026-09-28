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
export function useChat(params: {
  conversationId?: string;
  initialMessages: UiMessage[];
  /**
   * When true, the redirect to /chat/[id] after a new conversation's first
   * message is held (e.g. while a live voice session runs: navigating would
   * remount the view and end the session) until flushNavigation().
   */
  deferNavigation?: () => boolean;
}) {
  const [messages, setMessages] = useState<UiMessage[]>(params.initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversationIdRef = useRef(params.conversationId);
  const abortControllerRef = useRef<AbortController | null>(null);
  const router = useRouter();
  const pendingRouteRef = useRef<string | null>(null);
  const deferRef = useRef(params.deferNavigation);
  deferRef.current = params.deferNavigation;

  const send = useCallback(
    async (
      text: string,
      opts?: {
        useKnowledgeBase?: boolean;
        deepMode?: boolean;
        documentIds?: string[];
        /** Single-use grant for one live voice turn (server derives voice mode from it). */
        voiceGrant?: string;
        /**
         * The live session's conversation (the grant is bound to it). In a new
         * chat this is the id the server reserved when the session started.
         */
        conversationId?: string;
      },
    ): Promise<string | null> => {
      if (isStreaming || !text.trim()) return null;
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
            conversationId: opts?.conversationId ?? conversationIdRef.current,
            message: text,
            useKnowledgeBase: opts?.useKnowledgeBase ?? true,
            deepMode: opts?.deepMode ?? false,
            documentIds: opts?.documentIds ?? [],
            ...(opts?.voiceGrant ? { voiceGrant: opts.voiceGrant } : {}),
          }),
          signal: abortController.signal,
        });

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as {
            error?: { code?: string };
          } | null;
          setError(body?.error?.code ?? "request_failed");
          patchAssistant({ streaming: false });
          setIsStreaming(false);
          return null;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const isNewConversation = !conversationIdRef.current;
        let replyText = "";
        let failed = false;

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
                failed = true;
                setError(event.code);
                break;
              case "done":
                break;
            }
          }
        }

        patchAssistant({ streaming: false });
        if (isNewConversation && conversationIdRef.current) {
          if (deferRef.current?.()) {
            pendingRouteRef.current = `/chat/${conversationIdRef.current}`;
          } else {
            router.replace(`/chat/${conversationIdRef.current}`);
            router.refresh(); // refresh conversation list
          }
        }
        return failed ? null : replyText;
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          setMessages((prev) =>
            prev.filter((message) => message.id !== assistantMsg.id || message.content.length > 0),
          );
        } else {
          setError("network_error");
        }
        patchAssistant({ streaming: false });
        return null;
      } finally {
        abortControllerRef.current = null;
        setIsStreaming(false);
      }
    },
    [isStreaming, router],
  );

  const abort = useCallback(() => abortControllerRef.current?.abort(), []);

  /** Performs a redirect that was held by deferNavigation. */
  const flushNavigation = useCallback(() => {
    const route = pendingRouteRef.current;
    if (!route) return;
    pendingRouteRef.current = null;
    router.replace(route);
    router.refresh();
  }, [router]);

  /** The current conversation, once known (also after a new chat's first reply). */
  const getConversationId = useCallback(() => conversationIdRef.current, []);

  return { messages, send, abort, isStreaming, error, flushNavigation, getConversationId };
}
