"use client";

import { AlertTriangle, CircleHelp, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { FieldClassification } from "@/lib/business-dna/classify-extracted";

/**
 * Inline, field-level indicator shown directly below a Business DNA field
 * after a website extraction. Renders nothing for SAME (the common case —
 * no visual noise when nothing needs attention). Never relies on color
 * alone: every state pairs an icon with visible text, and the two action
 * buttons on a conflict carry their own accessible labels naming the
 * field, since "Keep current" / "Use website value" alone is ambiguous
 * when several fields show the same buttons on one page.
 */
export function FieldReviewIndicator({
  classification,
  fieldLabel,
  currentValue,
  extractedValue,
  sourceUrl,
  onKeepCurrent,
  onUseWebsite,
}: {
  classification: FieldClassification | undefined;
  fieldLabel: string;
  currentValue: string;
  extractedValue: string | null;
  sourceUrl: string | null;
  onKeepCurrent: () => void;
  onUseWebsite: () => void;
}) {
  const t = useTranslations("businessDna.review");

  if (!classification || classification === "SAME") return null;

  const sourceDomain = sourceUrl ? safeHostname(sourceUrl) : null;

  if (classification === "MISSING") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-warning" role="status">
        <CircleHelp className="size-3.5 shrink-0" aria-hidden="true" />
        {t("missing")}
      </p>
    );
  }

  if (classification === "NEW") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
        {sourceDomain ? t("newFoundOn", { domain: sourceDomain }) : t("newFound")}
      </p>
    );
  }

  // CONFLICT
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
    >
      <p className="flex items-center gap-1.5 font-medium text-warning">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        {t("conflictTitle")}
      </p>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <p>
          <span className="font-medium text-foreground">{t("currentValueLabel")}: </span>
          <span className="break-words">{currentValue}</span>
        </p>
        <p>
          <span className="font-medium text-foreground">{t("websiteValueLabel")}: </span>
          <span className="break-words">{extractedValue}</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onKeepCurrent}
          aria-label={t("keepCurrentAria", { field: fieldLabel })}
        >
          {t("keepCurrent")}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onUseWebsite}
          aria-label={t("useWebsiteAria", { field: fieldLabel })}
        >
          {t("useWebsite")}
        </Button>
      </div>
    </div>
  );
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
