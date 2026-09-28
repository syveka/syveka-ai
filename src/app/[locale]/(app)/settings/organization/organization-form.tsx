"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateOrganizationAction, type SettingsActionState } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function OrganizationForm({
  initial,
}: {
  initial: { name: string; businessId: string; vatId: string; aiInstructions: string };
}) {
  const t = useTranslations("settingsOrganization");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    updateOrganizationAction,
    {},
  );

  return (
    <form action={action} className="space-y-4">
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-1.5">
            <Label htmlFor="name">{t("companyName")}</Label>
            <Input id="name" name="name" defaultValue={initial.name} required />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="businessId">{t("businessId")}</Label>
              <Input
                id="businessId"
                name="businessId"
                defaultValue={initial.businessId}
                pattern="\d{7}-\d"
                placeholder="1234567-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vatId">{t("vatId")}</Label>
              <Input
                id="vatId"
                name="vatId"
                defaultValue={initial.vatId}
                placeholder="FI12345678"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            <label htmlFor="aiInstructions">{t("aiInstructionsTitle")}</label>
          </CardTitle>
          <CardDescription id="aiInstructionsHelp">{t("aiInstructionsHelp")}</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            id="aiInstructions"
            name="aiInstructions"
            aria-describedby="aiInstructionsHelp"
            defaultValue={initial.aiInstructions}
            rows={5}
            maxLength={2000}
            placeholder={t("aiInstructionsPlaceholder")}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </CardContent>
      </Card>

      {state.message ? (
        <p role="status" className="text-sm text-success">
          {t("saved")}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {tc("error")}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? tc("loading") : tc("save")}
      </Button>
    </form>
  );
}
