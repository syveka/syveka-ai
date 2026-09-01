"use client";

import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Without this boundary, any client exception on this page (mount or
 * hydration) falls all the way through to Next.js's own generic, dead-end
 * "Application error" screen -- the same route group's sibling pages
 * (dashboard, inbox) already have this same boundary; this one had been
 * missing. `error.message`/`error.digest` are safe to show here: this is a
 * client-thrown error (never crossed the server/client RSC boundary, so
 * Next's production message-stripping for server errors doesn't apply) on
 * an already permission-gated settings page.
 */
export default function BusinessDnaError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("businessDna");
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Card role="alert" className="mx-auto max-w-3xl">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <span className="rounded-md bg-destructive/10 p-2 text-destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
        </span>
        <CardTitle className="text-base">{t("errorTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("errorDescription")}</p>
        <div className="flex items-center gap-3">
          <Button type="button" onClick={reset}>
            {t("retry")}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setShowDetails((v) => !v)}>
            {t("errorDetailsToggle")}
          </Button>
        </div>
        {showDetails ? (
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs text-muted-foreground">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </pre>
        ) : null}
      </CardContent>
    </Card>
  );
}
