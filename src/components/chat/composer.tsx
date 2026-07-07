"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { SendHorizonal, BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string, opts: { useKnowledgeBase: boolean }) => void;
  disabled: boolean;
}) {
  const t = useTranslations("chat");
  const [text, setText] = useState("");
  const [useKb, setUseKb] = useState(true);

  // Prompt library hand-off (§15.7): pre-fill from "use in chat"
  useEffect(() => {
    const draft = sessionStorage.getItem("chat:draft");
    if (draft) {
      setText(draft);
      sessionStorage.removeItem("chat:draft");
    }
  }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (!text.trim() || disabled) return;
    onSend(text, { useKnowledgeBase: useKb });
    setText("");
    textareaRef.current?.focus();
  };

  return (
    <div className="border-t p-4">
      <div className="flex items-end gap-2 rounded-lg border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("placeholder")}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={() => setUseKb((v) => !v)}
          title={t("useKnowledgeBase")}
          className={cn(
            "rounded-md p-2 transition-colors",
            useKb ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent",
          )}
        >
          <BookOpen className="size-4" />
        </button>
        <Button size="icon" onClick={submit} disabled={disabled || !text.trim()}>
          <SendHorizonal className="size-4" />
        </Button>
      </div>
      <p className="mt-1.5 px-1 text-xs text-muted-foreground">{t("disclaimer")}</p>
    </div>
  );
}
