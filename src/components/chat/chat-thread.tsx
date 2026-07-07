"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Wrench, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { UiMessage } from "@/hooks/use-chat";

export function ChatThread({ messages }: { messages: UiMessage[] }) {
  const t = useTranslations("chat");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <Sparkles className="size-8" />
        <p className="text-sm">{t("emptyState")}</p>
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: UiMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-4 py-2.5 text-sm md:max-w-[70%]",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {message.tools && message.tools.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {message.tools.map((tool, i) => (
              <span
                key={`${tool}-${i}`}
                className="inline-flex items-center gap-1 rounded-full bg-background/60 px-2 py-0.5 text-xs text-muted-foreground"
              >
                <Wrench className="size-3" />
                {tool}
              </span>
            ))}
          </div>
        ) : null}

        <div className="whitespace-pre-wrap break-words">
          {message.content}
          {message.streaming ? <span className="animate-pulse">▍</span> : null}
        </div>

        {message.citations && message.citations.length > 0 ? (
          <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
            {message.citations.map((c) => (
              <div key={c.documentId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <FileText className="size-3" />
                {c.title}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
