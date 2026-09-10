"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CREATOR_REFERENCE_ASSET_MIME_TYPES,
  MAX_REFERENCE_ASSET_BYTES,
} from "@/lib/validators/creator-studio";

type AllowedMime = (typeof CREATOR_REFERENCE_ASSET_MIME_TYPES)[number];

export function ReferenceAssetUploader({ profileId }: { profileId: string }) {
  const t = useTranslations("creatorStudio.characters");
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
          if (!(CREATOR_REFERENCE_ASSET_MIME_TYPES as readonly string[]).includes(file.type)) {
            setError("unsupported_type");
            continue;
          }
          if (file.size > MAX_REFERENCE_ASSET_BYTES) {
            setError("too_large");
            continue;
          }
          const mimeType = file.type as AllowedMime;

          const urlRes = await fetch(
            `/api/v1/creator-studio/profiles/${profileId}/reference-assets/upload-url`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileName: file.name, mimeType, sizeBytes: file.size }),
            },
          );
          if (!urlRes.ok) {
            setError("upload_failed");
            continue;
          }
          const { data } = (await urlRes.json()) as {
            data: { uploadIntentId: string; signedUrl: string };
          };

          const putRes = await fetch(data.signedUrl, {
            method: "PUT",
            headers: { "Content-Type": mimeType },
            body: file,
          });
          if (!putRes.ok) {
            setError("upload_failed");
            continue;
          }

          const confirmRes = await fetch(
            `/api/v1/creator-studio/profiles/${profileId}/reference-assets/confirm`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ uploadIntentId: data.uploadIntentId }),
            },
          );
          if (!confirmRes.ok) setError("upload_failed");
        }
        router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [profileId, router],
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
        <p className="text-sm font-medium">{busy ? t("uploading") : t("uploadDropzone")}</p>
        <p className="text-xs text-muted-foreground">{t("uploadHint")}</p>
        <input
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
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
