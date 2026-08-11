"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ExtractedBusinessDNA } from "@/lib/validators/business-dna";

type ExtractResponse =
  { data: ExtractedBusinessDNA; sourceUrl: string } | { error: { code: string } };

/**
 * Client-only preview flow: POSTs to the existing `/api/v1/business-dna/extract`
 * endpoint (auth/RBAC/rate-limit already enforced server-side) and hands the
 * result to the parent form to merge into its editable fields — nothing is
 * saved until the user reviews and explicitly clicks Save.
 */
export function RegenerateFromWebsite({
  onExtracted,
}: {
  onExtracted: (data: ExtractedBusinessDNA, sourceUrl: string) => void;
}) {
  const t = useTranslations("businessDna");
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);

  async function handleExtract() {
    if (!url.trim()) return;
    setStatus("loading");
    setErrorCode(null);
    try {
      const res = await fetch("/api/v1/business-dna/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = (await res.json()) as ExtractResponse;
      if (!res.ok || "error" in body) {
        setStatus("error");
        setErrorCode("error" in body ? body.error.code : "failed");
        return;
      }
      onExtracted(body.data, body.sourceUrl);
      setStatus("idle");
    } catch {
      setStatus("error");
      setErrorCode("failed");
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-4">
      <Label htmlFor="regenerate-url">{t("regenerate.label")}</Label>
      <p className="text-xs text-muted-foreground">{t("regenerate.description")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="regenerate-url"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={t("regenerate.placeholder")}
          className="max-w-sm"
          disabled={status === "loading"}
        />
        <Button
          type="button"
          variant="outline"
          disabled={status === "loading" || !url.trim()}
          onClick={handleExtract}
        >
          {status === "loading" ? t("regenerate.extracting") : t("regenerate.extract")}
        </Button>
      </div>
      {status === "error" ? (
        <p className="text-sm text-destructive">
          {errorCode === "rate_limited" ? t("regenerate.rateLimited") : t("regenerate.failed")}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("regenerate.reviewHint")}</p>
    </div>
  );
}
