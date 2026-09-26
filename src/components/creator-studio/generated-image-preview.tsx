"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * Preview of a completed IMAGE generation. The image is always loaded through
 * the authenticated route /api/v1/creator-studio/generations/:id/image, which
 * authorizes server-side and redirects to a short-lived signed URL; this
 * component never sees a storage path or bucket. Retrying only re-requests
 * that read-only route (with a cache-busting attempt number) -- it never
 * triggers a generation or a credit change.
 */
export function generatedImageSrc(generationId: string, attempt = 0): string {
  const base = `/api/v1/creator-studio/generations/${encodeURIComponent(generationId)}/image`;
  return attempt > 0 ? `${base}?attempt=${attempt}` : base;
}

export function GeneratedImagePreview({
  generationId,
  hasOutput,
}: {
  generationId: string;
  hasOutput: boolean;
}) {
  const t = useTranslations("creatorStudio.library.preview");
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  if (!hasOutput) {
    return (
      <div
        role="img"
        aria-label={t("missing")}
        className="flex h-24 w-24 shrink-0 items-center justify-center rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground sm:h-32 sm:w-32"
      >
        {t("missing")}
      </div>
    );
  }

  const src = generatedImageSrc(generationId, attempt);
  return (
    <div className="relative h-24 w-24 shrink-0 sm:h-32 sm:w-32">
      {state === "loading" ? (
        <div
          aria-live="polite"
          className="absolute inset-0 flex animate-pulse items-center justify-center rounded-md bg-muted text-xs text-muted-foreground"
        >
          {t("loading")}
        </div>
      ) : null}
      {state === "error" ? (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground"
        >
          <span>{t("error")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setState("loading");
              setAttempt((n) => n + 1);
            }}
          >
            {t("retry")}
          </Button>
        </div>
      ) : (
        <a href={src} target="_blank" rel="noopener noreferrer" aria-label={t("open")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated redirect to a short-lived signed URL; next/image would proxy and cache it */}
          <img
            key={src}
            src={src}
            alt={t("alt")}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setState("loaded")}
            onError={() => setState("error")}
            className="h-full w-full rounded-md border object-cover"
          />
        </a>
      )}
    </div>
  );
}
