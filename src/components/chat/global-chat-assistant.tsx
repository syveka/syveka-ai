"use client";

import * as React from "react";
import { ExternalLink, MessageCircle, SendHorizontal, Square, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { useChat, type UiMessage } from "@/hooks/use-chat";
import { ChatThread } from "@/components/chat/chat-thread";
import { Button } from "@/components/ui/button";

const KNOWN_CHAT_ERRORS = new Set([
  "rate_limited",
  "entitlement_exceeded",
  "content_flagged",
  "generation_failed",
  "network_error",
  "invalid_document",
]);

/**
 * Persistent authenticated assistant. It deliberately reuses the product's
 * existing /api/v1/ai/chat path via useChat, so session/RBAC, tenant scoping,
 * Business DNA, RAG, moderation, rate limits, and entitlements stay enforced
 * in one place. The app layout also omits this surface for roles without
 * chat:use; the API remains the authoritative permission boundary.
 */
export function GlobalChatAssistant() {
  const t = useTranslations("globalAssistant");
  const tc = useTranslations("chat");
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const launcherRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const initialMessages = React.useMemo<UiMessage[]>(
    () => [{ id: "global-assistant-greeting", role: "assistant", content: t("greeting") }],
    [t],
  );
  const { messages, send, abort, isStreaming, error } = useChat({
    initialMessages,
    navigateOnCreate: false,
  });

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  React.useEffect(() => () => abort(), [abort]);

  // The full chat already owns this route's entire working area.
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return null;

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || isStreaming) return;
    setDraft("");
    void send(text, { useKnowledgeBase: true });
  };

  const errorKey = error && KNOWN_CHAT_ERRORS.has(error) ? error : "generic";

  return (
    <div className="pointer-events-none fixed bottom-4 end-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col items-end gap-3 pb-[env(safe-area-inset-bottom)] md:bottom-6 md:end-6">
      {open ? (
        <section
          id="global-chat-assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-label={t("title")}
          onKeyDown={(event) => {
            if (event.key === "Escape") close();
          }}
          className="pointer-events-auto flex h-[min(32rem,calc(100dvh-7rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
        >
          <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">{t("title")}</h2>
              <Link
                href="/chat"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("openFullChat")}
                <ExternalLink className="size-3" aria-hidden="true" />
              </Link>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={t("close")}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>

          <div aria-live="polite" className="flex min-h-0 flex-1 flex-col">
            <ChatThread messages={messages} />
          </div>

          {error ? (
            <p role="alert" className="px-4 pb-2 text-xs text-destructive">
              {tc(`errors.${errorKey}` as never)}
            </p>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="border-t p-3"
          >
            <div className="flex items-end gap-2 rounded-lg border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                rows={1}
                maxLength={8_000}
                dir="auto"
                placeholder={t("placeholder")}
                aria-label={t("placeholder")}
                disabled={isStreaming}
                className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
              <Button
                type="button"
                size="icon"
                onClick={isStreaming ? abort : submit}
                disabled={!isStreaming && !draft.trim()}
                aria-label={isStreaming ? t("stop") : t("send")}
              >
                {isStreaming ? (
                  <Square className="size-4" aria-hidden="true" />
                ) : (
                  <SendHorizontal className="size-4" aria-hidden="true" />
                )}
              </Button>
            </div>
            <p className="mt-1.5 px-1 text-xs text-muted-foreground">{tc("disclaimer")}</p>
          </form>
        </section>
      ) : null}

      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("launcherLabel")}
        aria-expanded={open}
        aria-controls="global-chat-assistant-panel"
        className="pointer-events-auto flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <MessageCircle className="size-6" aria-hidden="true" />
      </button>
    </div>
  );
}
