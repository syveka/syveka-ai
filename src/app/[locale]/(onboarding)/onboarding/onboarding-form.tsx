"use client";

import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createOrganizationAction, type OrgActionState } from "@/actions/organization";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function OnboardingForm() {
  const tc = useTranslations("common");
  const locale = useLocale();
  const [state, action, pending] = useActionState<OrgActionState, FormData>(
    createOrganizationAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">
          {locale === "fi" ? "Luo organisaatiosi" : "Create your organization"}
        </CardTitle>
        <CardDescription>
          {locale === "fi"
            ? "Tämä on työtilasi Syvekassa — voit kutsua tiimisi seuraavaksi."
            : "This is your workspace in Syveka — you can invite your team next."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <input type="hidden" name="defaultLocale" value={locale.toUpperCase()} />
          <div className="space-y-2">
            <Label htmlFor="name">{locale === "fi" ? "Yrityksen nimi" : "Company name"}</Label>
            <Input id="name" name="name" required minLength={2} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="businessId">
              {locale === "fi" ? "Y-tunnus (valinnainen)" : "Business ID / Y-tunnus (optional)"}
            </Label>
            <Input id="businessId" name="businessId" placeholder="1234567-8" pattern="\d{7}-\d" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="industry">{locale === "fi" ? "Toimiala" : "Industry"}</Label>
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
