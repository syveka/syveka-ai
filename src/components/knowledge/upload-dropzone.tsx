"use client";

import { useCallback, useState } from "react";
import { useRouter } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { ALLOWED_MIME_TYPES, MAX_UPLOAD_BYTES } from "@/lib/validators/documents";

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
};

export function UploadDropzone() {
  const t = useTranslations("knowledge");
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      setError(null);
      setBusy(true);
      try {
        for (const file of Array.from(files)) {
          const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
          const mimeType = (ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)
            ? file.type
            : EXT_TO_MIME[ext];
          if (!mimeType) {
            setError("unsupported_type");
            continue;
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            setError("too_large");
            continue;
          }

          // 1. signed upload URL
          const urlRes = await fetch("/api/v1/kb/documents/upload-url", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fileName: file.name, mimeType, sizeBytes: file.size }),
          });
          if (!urlRes.ok) {
            setError(urlRes.status === 402 ? "quota" : "upload_failed");
            continue;
          }
          const { data } = (await urlRes.json()) as {
            data: { uploadIntentId: string; signedUrl: string };
          };

          // 2. direct upload to Storage
          const putRes = await fetch(data.signedUrl, {
            method: "PUT",
            headers: { "Content-Type": mimeType },
            body: file,
          });
          if (!putRes.ok) {
            setError("upload_failed");
            continue;
          }

          // 3. create the document record → triggers the embed pipeline
          const finalizeRes = await fetch("/api/v1/kb/documents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: file.name.replace(/\.[^.]+$/, ""),
              sourceType: "UPLOAD",
              uploadIntentId: data.uploadIntentId,
            }),
          });
          if (!finalizeRes.ok) setError("upload_failed");
        }
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  return (
    <div>
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void uploadFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors",
          dragging ? "border-primary bg-primary/5" : "border-border hover:bg-accent/40",
          busy && "pointer-events-none opacity-60",
        )}
      >
        <UploadCloud className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">{busy ? t("uploading") : t("dropzone")}</p>
        <p className="text-xs text-muted-foreground">PDF · DOCX · TXT · MD · HTML — max 25 MB</p>
        <input
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md,.html"
          className="hidden"
          onChange={(e) => e.target.files && void uploadFiles(e.target.files)}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t(`errors.${error}` as never)}
        </p>
      ) : null}
    </div>
  );
}
