"use client";

import * as React from "react";
import { MessageCircle, X, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type ChatMessage = { role: "user" | "assistant"; content: string };
type RequestState = "idle" | "pending" | "rate_limited" | "error";

const MAX_MESSAGE_LENGTH = 600;
const MAX_HISTORY_TURNS = 8;

/**
 * Floating public marketing-site assistant (Part B, website UX task). Talks
 * only to the unauthenticated /api/v1/public-assistant endpoint -- never to
 * the in-app chat API, never with a session. State is in-memory only: no
 * localStorage, no server persistence, nothing survives a page reload. Not
 * rendered inside the authenticated app shell (see (marketing)/layout.tsx),
 * so it never competes with the logged-in product's own chat experience.
 */
export function PublicSyvekaAssistant({ locale }: { locale: string }) {
  const t = useTranslations("publicAssistant");
  const [open, setOpen] = React.useState(false);
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [draft, setDraft] = React.useState("");
  const [status, setStatus] = React.useState<RequestState>("idle");
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  // Separate from `messages` (the full UI transcript, which can include a
  // turn that never got a reply after an error) -- the API requires
  // strictly alternating user/assistant turns starting with "user", so this
  // only ever grows by a complete, successful (user, assistant) pair,
  // atomically. A failed or rate-limited attempt leaves it untouched, so a
  // retry after an error can never send a malformed sequence.
  const historyRef = React.useRef<ChatMessage[]>([]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight });
  }, [messages, status]);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const send = React.useCallback(
    async (text: string) => {
      const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!trimmed || status === "pending") return;

      setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
      setDraft("");
      setStatus("pending");

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/v1/public-assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            locale,
            history: historyRef.current,
          }),
          signal: controller.signal,
        });

        if (res.status === 429) {
          setStatus("rate_limited");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = (await res.json()) as { reply?: string };
        if (!data.reply) {
          setStatus("error");
          return;
        }
        setMessages((prev) => [...prev, { role: "assistant", content: data.reply! }]);
        historyRef.current = [
          ...historyRef.current,
          { role: "user" as const, content: trimmed },
          { role: "assistant" as const, content: data.reply },
        ].slice(-MAX_HISTORY_TURNS * 2);
        setStatus("idle");
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatus("error");
      }
    },
    [status, locale],
  );

  const suggestions = [
    { key: "whatCanSyvekaDo", kind: "chat" as const },
    { key: "aiVoice", kind: "chat" as const },
    { key: "howSyvekaHelps", kind: "chat" as const },
    { key: "pricing", kind: "link" as const, href: "/pricing" as const },
    { key: "createAccount", kind: "link" as const, href: "/register" as const },
    { key: "contact", kind: "mailto" as const, href: "mailto:sales@syveka.ai" },
  ];

  return (
    <div className="fixed bottom-4 end-4 z-50 flex flex-col items-end gap-3 pb-[env(safe-area-inset-bottom)]">
      {open ? (
        <div
          role="dialog"
          aria-modal="false"
          aria-label={t("title")}
          className="flex h-[min(32rem,calc(100dvh-6rem))] w-[min(23rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="text-sm font-semibold">{t("title")}</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("close")}
              className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            <div className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm">{t("greeting")}</div>
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  m.role === "user"
                    ? "ms-auto bg-primary text-primary-foreground"
                    : "bg-muted text-foreground",
                )}
              >
                {m.content}
              </div>
            ))}
            {status === "pending" ? (
              <div
                role="status"
                className="max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground"
              >
                {t("thinking")}
              </div>
            ) : null}
            {status === "rate_limited" ? (
              <p role="alert" className="text-xs text-destructive">
                {t("errors.rateLimited")}
              </p>
            ) : null}
            {status === "error" ? (
              <p role="alert" className="text-xs text-destructive">
                {t("errors.generic")}
              </p>
            ) : null}

            {messages.length === 0 ? (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {suggestions.map((s) =>
                  s.kind === "chat" ? (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => void send(t(`suggestions.${s.key}`))}
                      className="rounded-full border px-2.5 py-1 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t(`suggestions.${s.key}`)}
                    </button>
                  ) : (
                    <Button
                      key={s.key}
                      asChild
                      variant="outline"
                      size="sm"
                      className="h-auto rounded-full px-2.5 py-1 text-xs"
                    >
                      {s.kind === "link" ? (
                        <Link href={s.href}>{t(`suggestions.${s.key}`)}</Link>
                      ) : (
                        <a href={s.href}>{t(`suggestions.${s.key}`)}</a>
                      )}
                    </Button>
                  ),
                )}
              </div>
            ) : null}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(draft);
            }}
            className="flex items-center gap-2 border-t p-3"
          >
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
              placeholder={t("placeholder")}
              maxLength={MAX_MESSAGE_LENGTH}
              aria-label={t("placeholder")}
              disabled={status === "pending"}
            />
            <Button
              type="submit"
              size="icon"
              disabled={status === "pending" || draft.trim().length === 0}
              aria-label={t("send")}
            >
              <Send className="size-4" aria-hidden="true" />
            </Button>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("launcherLabel")}
        aria-expanded={open}
        className="flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        {open ? (
          <X className="size-6" aria-hidden="true" />
        ) : (
          <MessageCircle className="size-6" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
