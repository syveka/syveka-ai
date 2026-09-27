"use client";

import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Fallback for any route under [locale] without its own error.tsx (onboarding,
 * auth, public booking, most app pages). Without it, an unexpected server
 * error showed Next.js's bare, untranslated "Application error" page. Never
 * renders `error.message`: server errors can carry internal details.
 */
export default function LocaleError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("common");

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center p-4">
      <Card role="alert">
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <span className="rounded-md bg-destructive/10 p-2 text-destructive">
            <AlertCircle className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-base">{t("error")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("errorDescription")}</p>
          <Button type="button" onClick={reset}>
            {t("retry")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
