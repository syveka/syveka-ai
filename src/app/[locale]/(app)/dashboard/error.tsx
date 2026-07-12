"use client";

import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  const t = useTranslations("dashboard");

  return (
    <Card role="alert">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0">
        <span className="rounded-md bg-destructive/10 p-2 text-destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
        </span>
        <CardTitle className="text-base">{t("errorTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("errorDescription")}</p>
        <Button type="button" onClick={reset}>
          {t("retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
