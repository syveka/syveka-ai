"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { SendHorizonal, BookOpen, Paperclip, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MAX_UPLOAD_BYTES } from "@/lib/validators/documents";

type Attachment = { id: string; title: string };

export function Composer({
  onSend,
  onAbort,
  disabled,
}: {
  onSend: (text: string, opts: { useKnowledgeBase: boolean; documentIds: string[] }) => void;
  onAbort: () => void;
  disabled: boolean;
}) {
  const t = useTranslations("chat");
  const [text, setText] = useState("");
  const [useKb, setUseKb] = useState(true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

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
    onSend(text, { useKnowledgeBase: useKb, documentIds: attachments.map((file) => file.id) });
    setText("");
    textareaRef.current?.focus();
  };

  const upload = async (file: File) => {
    setUploadError(null);
    const mimeByExtension: Record<string, string> = {
      pdf: "application/pdf",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      txt: "text/plain",
    };
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = mimeByExtension[extension];
    if (!mimeType) return setUploadError("unsupported_file");
    if (file.size > MAX_UPLOAD_BYTES) return setUploadError("file_too_large");

    setUploading(true);
    try {
      const uploadUrlResponse = await fetch("/api/v1/ai/files/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: file.name, mimeType, sizeBytes: file.size }),
      });
      if (!uploadUrlResponse.ok) throw new Error("upload_failed");
      const uploadUrlBody = (await uploadUrlResponse.json()) as {
        data: { uploadIntentId: string; signedUrl: string };
      };
      const storageResponse = await fetch(uploadUrlBody.data.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: file,
      });
      if (!storageResponse.ok) throw new Error("upload_failed");
      const title = file.name.replace(/\.[^.]+$/, "");
      const finalizeResponse = await fetch("/api/v1/ai/files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, uploadIntentId: uploadUrlBody.data.uploadIntentId }),
      });
      if (!finalizeResponse.ok) throw new Error("upload_failed");
      const finalized = (await finalizeResponse.json()) as {
        data: { id: string; title: string };
      };
      setAttachments((current) =>
        current.some((item) => item.id === finalized.data.id)
          ? current
          : [...current, finalized.data],
      );
    } catch {
      setUploadError("upload_failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="border-t p-4">
      {attachments.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((file) => (
            <span
              key={file.id}
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-1 text-xs"
            >
              {file.title}
              <button
                type="button"
                aria-label={t("removeFile")}
                onClick={() =>
                  setAttachments((current) => current.filter((item) => item.id !== file.id))
                }
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
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
        <label
          title={t("attachFile")}
          className={cn(
            "cursor-pointer rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent",
            uploading && "pointer-events-none opacity-50",
          )}
        >
          <Paperclip className="size-4" />
          <input
            type="file"
            accept=".pdf,.docx,.txt"
            className="hidden"
            disabled={uploading || disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
              event.target.value = "";
            }}
          />
        </label>
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
        <Button
          size="icon"
          onClick={disabled ? onAbort : submit}
          disabled={!disabled && (!text.trim() || uploading)}
          aria-label={disabled ? t("stopGenerating") : t("send")}
        >
          {disabled ? <Square className="size-4" /> : <SendHorizonal className="size-4" />}
        </Button>
      </div>
      {uploadError ? (
        <p role="alert" className="mt-1.5 px-1 text-xs text-destructive">
          {t(`errors.${uploadError}` as never)}
        </p>
      ) : null}
      <p className="mt-1.5 px-1 text-xs text-muted-foreground">{t("disclaimer")}</p>
    </div>
  );
}
