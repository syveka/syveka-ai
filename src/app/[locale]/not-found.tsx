"use client";

import { SearchX } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

/**
 * Shown for every notFound() under [locale]: unknown records, and invalid or
 * inactive public booking links (which deliberately return the same not-found
 * for every failure). Without it, those showed Next.js's bare, English-only
 * 404 page, even to Finnish and Arabic guests.
 */
export default function LocaleNotFound() {
  const t = useTranslations("common");

  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-lg flex-col justify-center p-4">
      <Card>
        <CardHeader className="flex flex-row items-center gap-3 space-y-0">
          <span className="rounded-md bg-muted p-2 text-muted-foreground">
            <SearchX className="size-4" aria-hidden="true" />
          </span>
          <CardTitle className="text-base">
            <h1>{t("notFoundTitle")}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("notFoundDescription")}</p>
          <Button asChild>
            <Link href="/">{t("backToHome")}</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
