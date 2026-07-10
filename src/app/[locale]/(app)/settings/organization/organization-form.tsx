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
            <Label htmlFor="name">Company name</Label>
            <Input id="name" name="name" defaultValue={initial.name} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="businessId">Y-tunnus</Label>
              <Input
                id="businessId"
                name="businessId"
                defaultValue={initial.businessId}
                pattern="\d{7}-\d"
                placeholder="1234567-8"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vatId">VAT ID</Label>
              <Input id="vatId" name="vatId" defaultValue={initial.vatId} placeholder="FI12345678" />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">AI instructions</CardTitle>
          <CardDescription>
            Extra context every AI answer follows: tone of voice, key facts, dos and donts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            name="aiInstructions"
            defaultValue={initial.aiInstructions}
            rows={5}
            maxLength={2000}
            placeholder="We are a plumbing company in Tampere. Always mention our 24h emergency line..."
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </CardContent>
      </Card>

      {state.message ? <p className="text-sm text-success">Saved.</p> : null}
      {state.error ? <p className="text-sm text-destructive">{tc("error")}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? tc("loading") : tc("save")}
      </Button>
    </form>
  );
}
