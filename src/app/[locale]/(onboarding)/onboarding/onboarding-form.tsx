"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createOrganizationAction, type OrgActionState } from "@/actions/organization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function OnboardingForm() {
  const t = useTranslations("onboarding");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [state, action, pending] = useActionState<OrgActionState, FormData>(
    createOrganizationAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <input type="hidden" name="defaultLocale" value={locale.toUpperCase()} />
          <div className="space-y-2">
            <Label htmlFor="name">{t("companyName")}</Label>
            <Input id="name" name="name" required minLength={2} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="businessId">{t("businessId")}</Label>
            <Input id="businessId" name="businessId" placeholder="1234567-8" pattern="\d{7}-\d" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="industry">{t("industry")}</Label>
            <Input id="industry" name="industry" />
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {tc("error")}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? tc("loading") : tc("create")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
